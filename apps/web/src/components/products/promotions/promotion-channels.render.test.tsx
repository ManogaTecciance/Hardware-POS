/**
 * D56 (4.9) — a promotion offers the channels ITS TENANT sells on.
 *
 * ## What was wrong
 *
 * The editor hardcoded `['DINE_IN', 'TAKEAWAY', 'ONLINE']` — the food-service
 * three — and `COUNTER` was not even in the type. A RETAIL shopkeeper was shown
 * Dine-in / Takeaway / Online, and ticking any of them scoped the promotion to a
 * channel their till never sends (`catalog.ts` and `sales.service` both send
 * `COUNTER`). `isPromotionActive` then refused it, so the offer **silently never
 * fired** — no badge, no discount, no error.
 *
 * `capabilities.fulfilment.channels` already answered this per template. The
 * resolver existed and the component ignored it, which is exactly the scattered
 * comparison D56 exists to end.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Each case asserts the chips that SHOULD be there and the ones that should NOT,
 * in the same render. "Retail shows Counter" alone would pass for a component
 * that rendered every channel; "retail does not show Dine-in" alone would pass
 * for one that rendered nothing at all.
 *
 * The two templates are asserted against each other, so a change that collapses
 * both to one list fails on whichever side it broke.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainFor } from '@hardware-pos/shared';

const session = {
  user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
  branchId: 'brn_1',
} as never;

/** Flipped per test, so one suite covers retail AND food service. */
const tenant = { businessType: 'RETAIL' as 'RETAIL' | 'RESTAURANT', resolved: true };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/products/promotions/new',
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session, hasPermission: () => true }),
}));

vi.mock('@/lib/platform-profile', () => ({
  PlatformProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useEffectiveProfile: () => ({
    status: tenant.resolved ? 'ready' : 'loading',
    // Unresolved is its own state (D31) — `profile` is null while loading.
    profile: tenant.resolved ? { capabilities: domainFor(tenant.businessType).capabilities } : null,
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/products-api', () => ({
  listManagedProducts: async () => ({ items: [], total: 0, nextCursor: null }),
  resolveImageUrl: (u: string | null) => u,
}));

vi.mock('@/lib/products/promotions-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/promotions-api')>();
  return { ...actual, createPromotion: vi.fn(), updatePromotion: vi.fn(), getPromotion: vi.fn() };
});

const { PromotionEditor } = await import('./promotion-editor');

const chip = (name: string) => screen.queryByRole('checkbox', { name });

async function renderEditor() {
  render(<PromotionEditor session={session} />);
  await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  tenant.businessType = 'RETAIL';
  tenant.resolved = true;
});
afterEach(cleanup);

describe('the channel chips follow the tenant capability, not a hardcoded list', () => {
  it('RETAIL offers Counter, and none of the food-service channels', async () => {
    tenant.businessType = 'RETAIL';
    await renderEditor();

    // POSITIVE: the channel a retail till actually sends.
    expect(chip('Counter')).toBeTruthy();
    // NEGATIVE: and not the three it never will. Ticking one of these was the
    // bug — it scoped the promotion to a channel that never arrives, so the
    // offer silently never fired.
    expect(chip('Dine-in')).toBeNull();
    expect(chip('Takeaway')).toBeNull();
    expect(chip('Online')).toBeNull();
  });

  it('FOOD SERVICE keeps its three, and is not given Counter', async () => {
    tenant.businessType = 'RESTAURANT';
    await renderEditor();

    // POSITIVE: unchanged for the team that already had this working.
    expect(chip('Dine-in')).toBeTruthy();
    expect(chip('Takeaway')).toBeTruthy();
    expect(chip('Online')).toBeTruthy();
    // NEGATIVE: a restaurant does not sell at a retail counter, and offering it
    // would be the same defect pointed the other way.
    expect(chip('Counter')).toBeNull();
  });

  it('renders NO chips while the profile is unresolved', async () => {
    /*
     * D31 — unresolved is its own state. An empty scope already means "every
     * channel", so a promotion saved in this moment is unrestricted rather than
     * mis-restricted; guessing a list would risk the opposite.
     */
    tenant.resolved = false;
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());

    // Scoped to the Channels group: the days-of-week chips are checkboxes too,
    // and an unscoped query would have counted seven of them.
    const group = screen.getByRole('group', { name: 'Channels' });
    expect(within(group).queryAllByRole('checkbox')).toHaveLength(0);

    // POSITIVE CONTROL: the same editor with a resolved profile does render one,
    // so the emptiness above is about the unresolved state and not a query typo.
    cleanup();
    tenant.resolved = true;
    await renderEditor();
    expect(chip('Counter')).toBeTruthy();
  });
});
