/**
 * D55 — the client half of the platform/workspace boundary, at ONE url.
 *
 * The server half (`PlatformBoundaryGuard`) already refuses the wrong token in
 * both directions, so nothing here is a security control. What it is: the
 * branching that stops a user landing on a shell that cannot load. A platform
 * admin inside the workspace shell would 403 on the profile fetch and sit in
 * front of an empty sidebar; a workspace user must never see the console.
 *
 * Since 2026-08-17 the console renders AT /dashboard through
 * `PlatformConsoleBoundary`, so the assertions compose the boundary with
 * `Protected` exactly as the (app) layout does. Both directions are asserted,
 * and each is asserted NOT to fire for the other role — a one-directional
 * branch passes half of this file and fails the other half.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let pathname = '/dashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

interface AuthState {
  isPlatformAdmin: boolean;
  authenticated: boolean;
  loading: boolean;
}

let auth: AuthState;

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: auth.authenticated
      ? {
          token: 't',
          isPlatformAdmin: auth.isPlatformAdmin,
          user: { id: 'u1', name: 'Test User', role: 'OWNER', tenantId: 'tnt', permissions: [] },
        }
      : null,
    loading: auth.loading,
    isAuthenticated: auth.authenticated,
    hasPermission: () => true,
    loginWithEmail: vi.fn(),
    logout: vi.fn(),
  }),
}));

// Imported after the mocks so both components see them.
import { PlatformConsoleBoundary } from '@/components/platform/platform-console-boundary';
import { Protected } from '@/components/protected';

// No global setup file, so RTL's auto-cleanup is not registered. Without this
// the previous test's DOM survives and every "must not render" assertion below
// would be reading the last test's output.
afterEach(cleanup);

beforeEach(() => {
  replace.mockClear();
  pathname = '/dashboard';
  auth = { isPlatformAdmin: false, authenticated: true, loading: false };
});

/** The exact composition the (app) layout uses. */
function Shell() {
  return (
    <PlatformConsoleBoundary console={<p>console content</p>}>
      <Protected>
        <p>workspace content</p>
      </Protected>
    </PlatformConsoleBoundary>
  );
}

describe('a workspace user', () => {
  it('gets the workspace shell, never the console, and redirects nowhere', async () => {
    render(<Shell />);

    expect(await screen.findByText('workspace content')).toBeTruthy();
    expect(screen.queryByText('console content')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('is sent to the login page when unauthenticated', async () => {
    auth.authenticated = false;

    render(<Shell />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('console content')).toBeNull();
    expect(replace).not.toHaveBeenCalledWith('/dashboard');
  });
});

describe('a platform admin', () => {
  beforeEach(() => {
    auth.isPlatformAdmin = true;
  });

  it('sees the console at /dashboard — the workspace shell never mounts', async () => {
    render(<Shell />);

    expect(await screen.findByText('console content')).toBeTruthy();
    // Not merely covered — the shell must not render at all, or its profile
    // fetch fires and 403s underneath the console.
    expect(screen.queryByText('workspace content')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('is sent to /dashboard from any other workspace route', async () => {
    pathname = '/products';

    render(<Shell />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByText('workspace content')).toBeNull();
    expect(screen.queryByText('console content')).toBeNull();
  });

  it('still bounces off a bare Protected used outside the boundary', async () => {
    // Defence in depth: Protected's own redirect, for any usage that is not
    // wrapped by the boundary. Must target /dashboard, where the boundary
    // renders the console — so the pair cannot loop.
    render(
      <Protected>
        <p>workspace content</p>
      </Protected>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByText('workspace content')).toBeNull();
  });
});

describe('an unresolved session', () => {
  it('redirects nobody and renders neither product while loading', () => {
    auth.loading = true;

    render(<Shell />);

    // An unresolved session is its own state: guessing here would bounce a
    // signed-in admin to /login — or flash the wrong product — on every hard
    // refresh.
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText('console content')).toBeNull();
    expect(screen.queryByText('workspace content')).toBeNull();
  });
});
