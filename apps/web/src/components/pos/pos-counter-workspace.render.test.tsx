/**
 * D145 — the counter workspace's two destructive questions, asked through the
 * app's own confirm instead of `window.confirm`.
 *
 * ## Why both directions, on both sites
 *
 * Both guards protect work that cannot be recovered: an unsent cart. The old
 * `window.confirm` was synchronous, so "does the guard still hold?" was a
 * question nobody had to ask. The replacement is a promise, and the failure
 * mode of getting it wrong is silent in BOTH directions:
 *
 *   - a dropped `await` (or a dropped guard) clears the cart with no question,
 *     which looks identical to a cashier who tapped Clear on purpose;
 *   - an inverted guard refuses forever, which looks like a dead button.
 *
 * So every site is asserted twice on the same screen — Cancel leaves the cart
 * and the mode exactly as they were, Confirm performs the action — and the
 * cases where the guard must NOT fire (a single line, an empty cart) are
 * asserted too, so a confirm that became unconditional cannot pass here.
 *
 * Cart contents are counted by the per-line "Remove item" buttons: they exist
 * only inside the cart, so unlike the item name (which is also on the menu
 * card that added it) the count cannot be satisfied by the menu.
 *
 * Mutation-proven, each mutation run against the component itself:
 *   1. dropping the `await` in `clearAll` (`confirm({...})` unawaited, so the
 *      truthy Promise walks straight through the guard) fails "Cancel leaves
 *      the cart alone" — 1 failed, 5 passed.
 *   2. dropping the `resetMode` guard entirely fails both Change-order-type
 *      cases, the question never being asked — 2 failed, 4 passed.
 *   3. making `clearAll` ask unconditionally (dropping `draft.length > 1`)
 *      fails "clears a single line without a question" — 1 failed, 5 passed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import type { PosCatalogueItem } from '@/lib/restaurant/pos-catalogue-api';

// ── fixtures ─────────────────────────────────────────────────────────────────

function catalogueItem(id: string, name: string): PosCatalogueItem {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    unitPrice: 250,
    prepMinutes: null,
    dietaryTags: [],
    foodType: 'FOOD',
    category: null,
    subcategory: null,
    // No modifier groups and no variants: `openItem` fast-adds these straight
    // into the cart, which is what lets a test build a two-line cart without
    // driving the Customise dialog.
    hasVariants: false,
    variants: [],
    modifierGroups: [],
    stations: [],
    promotions: [],
    stockState: 'UNTRACKED',
  };
}

/**
 * Built through the REAL adapter (`vi.importActual`, so the module mock below
 * cannot reach it): a hand-rolled `MenuData` would let the picker render rows
 * production never produces.
 */
const { catalogueToMenuData } = await vi.importActual<typeof import('./use-menu-data')>(
  './use-menu-data',
);
const MENU = catalogueToMenuData([
  catalogueItem('p1', 'Rice and Curry'),
  catalogueItem('p2', 'Kottu'),
]);

// ── mocks ────────────────────────────────────────────────────────────────────

const back = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ back, push }) }));

vi.mock('@/lib/auth', () => ({
  // Every mode available, so the mode chip (and therefore its Change button)
  // renders — with a single available mode the workspace skips the chooser.
  useAuth: () => ({ session, hasPermission: () => true }),
}));

vi.mock('@/lib/platform-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-profile')>()),
  useEffectiveProfile: () => ({
    profile: { capabilities: { fulfilment: { kind: 'TABLE_SERVICE' } } },
    loading: false,
    error: null,
  }),
}));

// Only the branch config call is stubbed; everything else in the API module
// stays real so an accidental network path would still be visible as itself.
vi.mock('@/lib/restaurant/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant/api')>();
  return {
    ...actual,
    restaurantConfig: {
      ...actual.restaurantConfig,
      get: () => Promise.resolve({ serviceChargePercent: 0 } as never),
    },
  };
});

vi.mock('./use-menu-data', () => ({
  useMenuData: () => ({ data: MENU, loading: false, error: null, reload: vi.fn() }),
  usePosCatalogue: () => ({
    data: MENU,
    loading: false,
    error: null,
    reload: vi.fn(),
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    total: 2,
    loadedCount: 2,
  }),
}));

const session = {
  token: 't',
  branchName: 'Main',
  user: { id: 'usr_1', tenantId: 'tnt_1', role: 'OWNER' as const },
} as never;

const { PosCounterWorkspace } = await import('./pos-counter-workspace');

// ── harness ──────────────────────────────────────────────────────────────────

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Cart lines, counted by the control that exists only on a cart line. */
const cartLines = () => screen.queryAllByRole('button', { name: 'Remove item' });

/*
 * A regex, because the empty state shares its element with the "Select an
 * item…" line across a <br/>: an exact-string query matches NEITHER the empty
 * nor the filled cart, so `queryByText('No items yet.')` would be null in both
 * and prove nothing (D30).
 */
const EMPTY_CART = /No items yet\./;

async function mount() {
  const onModeChange = vi.fn();
  render(
    <ConfirmProvider>
      <PosCounterWorkspace
        session={session}
        branchId="brn_1"
        initialMode="TAKEAWAY"
        onModeChange={onModeChange}
      />
    </ConfirmProvider>,
  );
  await settle();
  return { onModeChange };
}

/** Two DISTINCT items — identical adds merge into one line (draftLineMergeKey). */
async function addTwoItems() {
  fireEvent.click(screen.getByRole('button', { name: /Rice and Curry/ }));
  fireEvent.click(screen.getByRole('button', { name: /Kottu/ }));
  await waitFor(() => expect(cartLines()).toHaveLength(2));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Clear current order ──────────────────────────────────────────────────────

describe('Clear current order (D145)', () => {
  it('asks before clearing, and Cancel leaves the cart alone', async () => {
    // Proves the native dialog is gone as well as that the guard holds: jsdom's
    // `window.confirm` returns false, so a leftover call would ALSO leave the
    // cart intact and this test would pass for the wrong reason.
    const native = vi.spyOn(window, 'confirm');
    await mount();
    await addTwoItems();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(
      await screen.findByRole('heading', { name: 'Clear current order?' }),
    ).toBeTruthy();
    expect(screen.getByText('All unsent items will be removed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();

    expect(cartLines()).toHaveLength(2);
    expect(screen.queryByText(EMPTY_CART)).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });

  it('empties the cart once the question is answered', async () => {
    await mount();
    await addTwoItems();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear order' }));

    await waitFor(() => expect(cartLines()).toHaveLength(0));
    expect(screen.getByText(EMPTY_CART)).toBeTruthy();
  });

  it('clears a single line without a question', async () => {
    // The guard is `draft.length > 1` and always was: one line is one tap to
    // re-add, so a confirm that became unconditional is a regression too.
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Rice and Curry/ }));
    await waitFor(() => expect(cartLines()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await settle();

    expect(screen.queryByRole('heading', { name: 'Clear current order?' })).toBeNull();
    expect(cartLines()).toHaveLength(0);
  });
});

// ── Change order type ────────────────────────────────────────────────────────

describe('Change order type (D145)', () => {
  it('asks before discarding the cart, and Cancel keeps the mode and the cart', async () => {
    const { onModeChange } = await mount();
    await addTwoItems();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('heading', { name: 'Change order type?' })).toBeTruthy();
    expect(screen.getByText('This will clear the current cart.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();

    // Everything after the guard must have been skipped: the cart, the mode,
    // and the URL the parent rewrites from `onModeChange`.
    expect(cartLines()).toHaveLength(2);
    expect(screen.queryByRole('dialog', { name: 'Start new order' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Order mode: Takeaway' })).toBeTruthy();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('clears the cart and reopens the chooser once confirmed', async () => {
    const { onModeChange } = await mount();
    await addTwoItems();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change order type' }));

    expect(await screen.findByRole('dialog', { name: 'Start new order' })).toBeTruthy();
    expect(onModeChange).toHaveBeenCalledWith(null);
    expect(cartLines()).toHaveLength(0);
  });

  it('changes type without asking when the cart is empty', async () => {
    const { onModeChange } = await mount();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await settle();

    expect(screen.queryByRole('heading', { name: 'Change order type?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Start new order' })).toBeTruthy();
    expect(onModeChange).toHaveBeenCalledWith(null);
  });
});
