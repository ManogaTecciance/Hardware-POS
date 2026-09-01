/**
 * The header sync pill, rendered.
 *
 * `/sync/status` is QuickBooks-only and module-enforced on the server. The pill is
 * header chrome, so before this gate a restaurant tenant issued a guaranteed 403
 * on every page load and every 30s thereafter — invisibly, because the component
 * swallows the failure and renders nothing.
 *
 * That invisibility is why these assertions are made against a **runtime spy on
 * the API client** (D30 §4) rather than the rendered output: "renders nothing" was
 * already true of the broken version, so a DOM-only test would pass on both. The
 * request count is the only thing that distinguishes fixed from broken.
 *
 * Every case asserts both directions: the QuickBooks tenant really does call the
 * endpoint, and each non-QuickBooks state really does not. A gate that never
 * polled at all would satisfy the negatives alone.
 */
import { domainFor } from '@hardware-pos/shared';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectiveBusinessProfile, ModuleKey } from '@/lib/platform-api';
import type { Session } from '@/lib/session-store';

// ── boundaries ───────────────────────────────────────────────────────────────

const get = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

let session: Session | null = null;
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session }) }));

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

const { SyncStatus } = await import('@/components/sync-status');

// ── fixtures ─────────────────────────────────────────────────────────────────

const SHARED_CORE: ModuleKey[] = [
  'CUSTOMERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
];
/** Mirrors RETAIL_MODULES — the only shape in which QUICKBOOKS is enabled. */
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
/** Mirrors FOOD_SERVICE_MODULES, which excludes QUICKBOOKS by decision D2. */
const RESTAURANT: ModuleKey[] = [
  ...SHARED_CORE,
  'MENU_MANAGEMENT',
  'DINING',
  'TABLE_MANAGEMENT',
  'TAKEAWAY',
  'KITCHEN',
];

function profile(businessType: string, enabledModules: ModuleKey[]): EffectiveBusinessProfile {
  return {
    source: 'EXPLICIT',
    businessType: businessType as EffectiveBusinessProfile['businessType'],
    inventoryMode: businessType === 'RESTAURANT' ? 'LOCAL' : 'QUICKBOOKS',
    accountingProvider: businessType === 'RESTAURANT' ? 'NONE' : 'QUICKBOOKS',
    enabledModules,
    capabilities: domainFor(businessType as EffectiveBusinessProfile['businessType']).capabilities,
    version: 1,
    updatedAt: null,
  };
}

const SUMMARY = {
  pendingCount: 0,
  failedCount: 0,
  lastSyncedAt: null,
  quickbooksConnected: true,
};

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue(SUMMARY);
  session = {
    token: 'tok',
    user: {
      id: 'usr_1',
      name: 'Owner',
      email: 'owner@example.test',
      role: 'OWNER',
      tenantId: 'tnt_1',
      permissions: [],
    },
    branchId: 'brn_1',
    registerId: null,
    branchName: 'Main',
    registerName: '',
  } as Session;
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe('a tenant with the QUICKBOOKS module', () => {
  it('polls /sync/status and shows the pill', async () => {
    profileState = { status: 'ready', profile: profile('HARDWARE', LEGACY) };
    render(<SyncStatus />);

    expect(await screen.findByText('Synced')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    // The exact path matters: a renamed endpoint must fail here, not silently
    // stop polling and leave the negative cases below trivially satisfied.
    expect(get).toHaveBeenCalledWith('/sync/status', { token: 'tok', tenantId: 'tnt_1' });
  });
});

describe('a tenant without the QUICKBOOKS module', () => {
  it('issues no request at all and renders nothing', () => {
    profileState = { status: 'ready', profile: profile('RESTAURANT', RESTAURANT) };
    const { container } = render(<SyncStatus />);

    expect(get).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });
});

describe('an unresolved profile (D31)', () => {
  it('does not poll while the profile is loading', () => {
    profileState = { status: 'loading', profile: null };
    const { container } = render(<SyncStatus />);

    expect(get).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('does not poll after the profile request failed', () => {
    // The tempting fallback is "assume QuickBooks" — that is the bug, restored.
    profileState = { status: 'error', profile: null };
    const { container } = render(<SyncStatus />);

    expect(get).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });
});

describe('no session', () => {
  it('does not poll even for a QuickBooks tenant', () => {
    session = null;
    profileState = { status: 'ready', profile: profile('HARDWARE', LEGACY) };
    render(<SyncStatus />);

    expect(get).not.toHaveBeenCalled();
  });
});
