/**
 * Route-level module gating, rendered (Slice 8.6).
 *
 * `nav.test.ts` proves which module a path requires. This proves the component
 * acts on that answer: gated content is absent from the DOM rather than merely
 * hidden, ungated content survives a profile failure, and the three profile states
 * produce three different screens. Every case asserts both what is shown and what
 * is not — a gate that rendered an empty page always would satisfy the negatives
 * alone.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EffectiveBusinessProfile, ModuleKey } from '@/lib/platform-api';

// ── boundaries ───────────────────────────────────────────────────────────────

let pathname = '/dashboard';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

let profileState: {
  status: 'loading' | 'ready' | 'error';
  profile: EffectiveBusinessProfile | null;
};

vi.mock('@/lib/platform-profile', () => ({
  useEffectiveProfile: () => ({
    ...profileState,
    inventoryMode: profileState.profile?.inventoryMode ?? null,
    refresh: vi.fn(),
  }),
}));

const { ModuleGate } = await import('@/components/module-gate');

// ── helpers ──────────────────────────────────────────────────────────────────

const SHARED_CORE: ModuleKey[] = [
  'CUSTOMERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
];
const LEGACY: ModuleKey[] = [
  ...SHARED_CORE,
  'RETAIL_POS',
  'INVENTORY',
  'QUOTATIONS',
  'RETURNS',
  'EXCHANGES',
  'SUPPLIERS',
  'QUICKBOOKS',
];
const RESTAURANT: ModuleKey[] = [
  ...SHARED_CORE,
  'MENU_MANAGEMENT',
  'DINING',
  'TABLE_MANAGEMENT',
  'TAKEAWAY',
  'KITCHEN',
];

const CONTENT = 'The page behind the gate';

function profile(businessType: string, enabledModules: ModuleKey[]): EffectiveBusinessProfile {
  return {
    source: 'EXPLICIT',
    businessType: businessType as EffectiveBusinessProfile['businessType'],
    inventoryMode: businessType === 'RESTAURANT' ? 'LOCAL' : 'QUICKBOOKS',
    accountingProvider: businessType === 'RESTAURANT' ? 'NONE' : 'QUICKBOOKS',
    enabledModules,
    version: 1,
    updatedAt: null,
  };
}

function renderAt(
  path: string,
  state: { status: 'loading' | 'ready' | 'error'; profile: EffectiveBusinessProfile | null },
) {
  pathname = path;
  profileState = state;
  return render(
    <ModuleGate>
      <p>{CONTENT}</p>
    </ModuleGate>,
  );
}

const ready = (businessType: string, modules: ModuleKey[]) =>
  ({ status: 'ready', profile: profile(businessType, modules) }) as const;

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe('a tenant that has the module', () => {
  it('renders the page untouched', () => {
    renderAt('/quickbooks', ready('TILE_SHOP', LEGACY));

    expect(screen.getByText(CONTENT)).toBeTruthy();
    expect(screen.queryByText('Not part of this workspace')).toBeNull();
  });

  it('renders a gated child route too', () => {
    renderAt('/quickbooks/sync-log', ready('TILE_SHOP', LEGACY));
    expect(screen.getByText(CONTENT)).toBeTruthy();
  });

  it('renders the restaurant shells for a restaurant', () => {
    // `/takeaway` was replaced by the POS-mode workspace in Pilot Change 2;
    // `/orders` is the new gated path (TABLE_MANAGEMENT) so the test now
    // covers it. `/pos` is intentionally not in this list — it dispatches
    // by business type and is shared with the retail workspace, so its
    // client-side gate is null (server-authoritative) rather than
    // TABLE_MANAGEMENT.
    for (const path of ['/tables', '/orders', '/kitchen', '/menu']) {
      renderAt(path, ready('RESTAURANT', RESTAURANT));
      expect({ path, shown: !!screen.queryByText(CONTENT) }).toEqual({ path, shown: true });
      cleanup();
    }
  });
});

describe('a tenant that does not have the module', () => {
  it('replaces QuickBooks with an explanation for a restaurant', () => {
    renderAt('/quickbooks', ready('RESTAURANT', RESTAURANT));

    expect(screen.getByText('Not part of this workspace')).toBeTruthy();
    // Absent, not hidden: the page's own requests must never be mounted.
    expect(screen.queryByText(CONTENT)).toBeNull();
  });

  it('blocks the restaurant shells for a Tile Shop', () => {
    for (const path of ['/tables', '/orders', '/kitchen', '/menu']) {
      renderAt(path, ready('TILE_SHOP', LEGACY));
      expect({ path, shown: !!screen.queryByText(CONTENT) }).toEqual({ path, shown: false });
      cleanup();
    }
  });

  it('offers a way out rather than a dead end', () => {
    renderAt('/quickbooks', ready('RESTAURANT', RESTAURANT));

    const home = screen.getByRole('link', { name: 'Back to dashboard' });
    expect(home.getAttribute('href')).toBe('/dashboard');
  });

  it('does not name the module key', () => {
    // The operator cannot act on `QUICKBOOKS`, and printing it reads as a fault
    // report rather than as the configuration choice it is.
    renderAt('/quickbooks', ready('RESTAURANT', RESTAURANT));
    expect(document.body.textContent).not.toContain('QUICKBOOKS');
  });
});

describe('while the profile is unresolved', () => {
  it('shows neither the page nor a refusal while loading', () => {
    renderAt('/quickbooks', { status: 'loading', profile: null });

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(CONTENT)).toBeNull();
    // A refusal here would tell a Tile Shop its integration had been removed.
    expect(screen.queryByText('Not part of this workspace')).toBeNull();
  });

  it('refuses to guess after a failed profile read', () => {
    renderAt('/quickbooks', { status: 'error', profile: null });

    expect(screen.getByText('Workspace unavailable')).toBeTruthy();
    expect(screen.queryByText(CONTENT)).toBeNull();
    expect(screen.queryByText('Not part of this workspace')).toBeNull();
  });

  it('announces the outcome to a screen reader', () => {
    renderAt('/quickbooks', { status: 'error', profile: null });
    expect(screen.getByRole('status').textContent).toBe('Workspace unavailable');
  });
});

describe('ungated routes', () => {
  it('render regardless of the profile state', () => {
    // The rule that keeps a profile outage from blanking the application: only a
    // route that requires a module is ever withheld.
    for (const state of [
      { status: 'loading', profile: null },
      { status: 'error', profile: null },
      ready('RESTAURANT', RESTAURANT),
    ] as const) {
      for (const path of ['/dashboard', '/products', '/sales']) {
        renderAt(path, state);
        expect({ path, status: state.status, shown: !!screen.queryByText(CONTENT) }).toEqual({
          path,
          status: state.status,
          shown: true,
        });
        cleanup();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the gate assertions can actually fail', () => {
  it('a gate that always rendered its children would be detected', () => {
    renderAt('/quickbooks', ready('RESTAURANT', RESTAURANT));
    expect(screen.queryByText(CONTENT)).toBeNull();
    cleanup();

    // The pass-through implementation this slice replaced.
    render(<p>{CONTENT}</p>);
    expect(() => expect(screen.queryByText(CONTENT)).toBeNull()).toThrow();
  });

  it('a gate that blocked everything would be detected', () => {
    // The opposite failure, and the reason every negative above is paired with a
    // positive: a component returning `null` satisfies all of them.
    renderAt('/dashboard', { status: 'error', profile: null });
    expect(screen.getByText(CONTENT)).toBeTruthy();
    cleanup();

    render(<></>);
    expect(() => screen.getByText(CONTENT)).toThrow();
  });
});
