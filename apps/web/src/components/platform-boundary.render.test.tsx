/**
 * D55 — the client half of the platform/workspace boundary.
 *
 * The server half (`PlatformBoundaryGuard`) already refuses the wrong token in
 * both directions, so nothing here is a security control. What it is: the two
 * redirects that stop a user landing on a shell that cannot load. A platform
 * admin inside the workspace shell would 403 on the profile fetch and sit in
 * front of an empty sidebar; a workspace user inside the console would 403 on
 * every list.
 *
 * Both directions are asserted, and each is asserted to NOT fire for the other
 * role — a one-directional redirect passes half of this file and fails the
 * other half.
 *
 * Mutation-proven: dropping the `isPlatformAdmin` branch from `Protected` (both
 * the redirect and the render guard) fails exactly one test here — "sends a
 * platform admin to the console instead of rendering the shell" — and leaves the
 * other six green, so the two directions are genuinely independent rather than
 * one assertion counted twice.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
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
import PlatformLayout from '@/app/platform/layout';
import { Protected } from '@/components/protected';

// No global setup file, so RTL's auto-cleanup is not registered. Without this
// the previous test's DOM survives and every "must not render" assertion below
// would be reading the last test's output.
afterEach(cleanup);

beforeEach(() => {
  replace.mockClear();
  auth = { isPlatformAdmin: false, authenticated: true, loading: false };
});

describe('Protected — the workspace shell', () => {
  it('renders the workspace shell for a workspace user, and redirects nowhere', async () => {
    render(
      <Protected>
        <p>workspace content</p>
      </Protected>,
    );

    expect(await screen.findByText('workspace content')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends a platform admin to the console instead of rendering the shell', async () => {
    auth.isPlatformAdmin = true;

    render(
      <Protected>
        <p>workspace content</p>
      </Protected>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/platform'));
    // Not merely redirected — the shell must not render at all, or its profile
    // fetch fires and 403s on the way out.
    expect(screen.queryByText('workspace content')).toBeNull();
  });

  it('sends an unauthenticated visitor to the login page', async () => {
    auth.authenticated = false;

    render(
      <Protected>
        <p>workspace content</p>
      </Protected>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(replace).not.toHaveBeenCalledWith('/platform');
  });
});

describe('PlatformLayout — the console shell', () => {
  it('renders the console for a platform admin, and redirects nowhere', async () => {
    auth.isPlatformAdmin = true;

    render(
      <PlatformLayout>
        <p>console content</p>
      </PlatformLayout>,
    );

    expect(await screen.findByText('console content')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends a workspace user back to their own app', async () => {
    render(
      <PlatformLayout>
        <p>console content</p>
      </PlatformLayout>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByText('console content')).toBeNull();
  });

  it('sends an unauthenticated visitor to the login page', async () => {
    auth.authenticated = false;

    render(
      <PlatformLayout>
        <p>console content</p>
      </PlatformLayout>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(replace).not.toHaveBeenCalledWith('/dashboard');
  });

  it('redirects nobody while the session is still loading', () => {
    auth.loading = true;

    render(
      <PlatformLayout>
        <p>console content</p>
      </PlatformLayout>,
    );

    // An unresolved session is its own state: guessing here would bounce a
    // signed-in admin to /login on every hard refresh.
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText('console content')).toBeNull();
  });
});
