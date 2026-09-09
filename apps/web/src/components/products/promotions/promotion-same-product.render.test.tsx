/**
 * A promotion may name one product as both BUY and GET (2026-09-09).
 *
 * ## What was wrong
 *
 * "Buy 5 Baby Soap, get 1 Baby Soap free" — the commonest BOGO there is — could
 * not be authored. `addProduct` guarded on the product alone:
 *
 *     if (items.some((i) => i.productId === product.id)) return prev;
 *
 * One product, one row, whatever its role. An operator wanting a same-product
 * BOGO had to name a DIFFERENT product as the reward, which is a different offer.
 *
 * **Nothing else in the stack agreed.** `PromotionItem` is
 * `@@unique([promotionId, productId, role])` — role is IN the key. The create DTO
 * validates each item on its own. `applier.ts` handles the same-product case
 * deliberately, with a comment describing exactly this shape. The engine was
 * built for a promotion the editor would not let anyone create.
 *
 * The guard also returned the state unchanged and said nothing, so a refusal was
 * indistinguishable from a dead button — which is how it was reported.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The permissive case is paired with the restrictive one: a product may hold two
 * rows in DIFFERENT roles, and may NOT hold two in the same role. Dropping
 * either half would pass for a guard removed entirely, which would let the
 * editor build a promotion the database's unique key refuses on save.
 *
 * The per-row operations are asserted too, because the item list was keyed by
 * product throughout: before this, removing the Buy row of a same-product BOGO
 * took the Get row with it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainFor } from '@hardware-pos/shared';

const session = {
  user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
  branchId: 'brn_1',
} as never;

const SOAP = { id: 'p_soap', name: 'Baby Soap' };

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
    status: 'ready',
    profile: { capabilities: domainFor('RETAIL').capabilities },
    inventoryMode: 'LOCAL',
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/products-api', () => ({
  //  reads , not .
  fetchProducts: async () => ({
    items: [{ ...SOAP, sku: 'SOAP', unitPrice: 150, isActive: true, hasVariants: false }],
    total: 1,
    page: 1,
    pageSize: 20,
  }),
  listManagedProducts: async () => ({ items: [], total: 0, nextCursor: null }),
  resolveImageUrl: (u: string | null) => u,
}));

vi.mock('@/lib/products/promotions-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/promotions-api')>();
  return { ...actual, createPromotion: vi.fn(), updatePromotion: vi.fn(), getPromotion: vi.fn() };
});

const { PromotionEditor } = await import('./promotion-editor');

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/**
 * Add Baby Soap once, from inside the PICKER.
 *
 * Scoped with `within(dialog)` deliberately: after the first add, "Baby Soap"
 * appears both as an item row and as a picker entry, and an unscoped query picks
 * whichever comes first in the DOM — which silently clicked the row and made the
 * second add look like a refusal.
 */
async function addSoap() {
  fireEvent.click(screen.getByRole('button', { name: /add product/i }));
  const dialog = await screen.findByRole('dialog');
  const entry = await within(dialog).findByText('Baby Soap');
  fireEvent.click(entry);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** Render, switch to Buy X Get Y, and add Baby Soap `times` times. */
async function editorWithSoap(times: number) {
  render(<PromotionEditor session={session} />);
  await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());

  fireEvent.click(screen.getByRole('radio', { name: /buy x, get y/i }));

  for (let i = 0; i < times; i += 1) await addSoap();
}

/** The item rows, which show `Role: BUY` / `Role: GET` under the name. */
function roleRows(): string[] {
  return screen
    .queryAllByText(/^Role: (BUY|GET|BUNDLE)$/)
    .map((el) => el.textContent!.replace('Role: ', ''));
}

describe('one product, two roles', () => {
  it('adds the same product a second time, in the remaining role', async () => {
    await editorWithSoap(2);

    // The whole point: Baby Soap is both what you buy and what you get.
    expect(roleRows()).toEqual(['BUY', 'GET']);
  });

  it('refuses a THIRD row, and says why', async () => {
    /*
     * The restrictive half. Without it, "two rows are allowed" would pass for a
     * guard deleted outright — and the editor would happily build a promotion
     * that `@@unique([promotionId, productId, role])` refuses on save, turning a
     * legible refusal into a 500 after the operator pressed Save.
     */
    await editorWithSoap(3);

    expect(roleRows()).toEqual(['BUY', 'GET']);
    expect(screen.getByRole('status').textContent).toMatch(/already on this promotion/i);
  });

  it('a bundle still takes one row per product', async () => {
    // BUNDLE has a single role, so the old one-row rule is still right there.
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /^bundle$/i }));

    for (let i = 0; i < 2; i += 1) await addSoap();

    expect(roleRows()).toEqual(['BUNDLE']);
  });
});

describe('the rows are independent', () => {
  it('removing the Buy row leaves the Get row standing', async () => {
    /*
     * `removeProduct` filtered on `productId` alone, so this removed BOTH. It
     * could not be noticed before, because the only promotion shape with two
     * rows for one product was the one the editor refused to create.
     */
    await editorWithSoap(2);
    expect(roleRows()).toEqual(['BUY', 'GET']);

    fireEvent.click(screen.getByRole('button', { name: /remove baby soap \(buy\)/i }));

    expect(roleRows()).toEqual(['GET']);
  });

  it('changing one quantity does not change the other', async () => {
    // Same defect, same cause: the quantity handler matched on product only.
    await editorWithSoap(2);

    const buyQty = screen.getByLabelText(/quantity for baby soap \(buy\)/i) as HTMLInputElement;
    const getQty = screen.getByLabelText(/quantity for baby soap \(get\)/i) as HTMLInputElement;

    fireEvent.change(buyQty, { target: { value: '5' } });

    expect(buyQty.value).toBe('5');
    expect(getQty.value).toBe('1');
  });

  it('refuses a role change that would collide', async () => {
    // Moving Get -> Buy when Buy is taken would produce two BUY rows, which the
    // database rejects. Refused where the operator can see it.
    await editorWithSoap(2);

    const selects = screen.getAllByLabelText(/item role/i) as HTMLSelectElement[];
    fireEvent.change(selects[1]!, { target: { value: 'BUY' } });

    expect(roleRows()).toEqual(['BUY', 'GET']);
    expect(screen.getByRole('status').textContent).toMatch(/already has a row in this role/i);
  });
});
