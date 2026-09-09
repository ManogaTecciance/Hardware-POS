/**
 * Buy X, Get Y is composed as a sentence, not a field grid.
 *
 * ## What was wrong
 *
 * The old form asked for Buy quantity, Get quantity and "Percentage off
 * (100 = free)" in one row of boxes, then for products in a flat list where
 * every row carried a Role dropdown. Three separate failures came out of that
 * shape, all of them silent:
 *
 *  - every product landed as BUY, and a promotion with no GET item is skipped
 *    by the pricing engine — no badge, no discount, no error;
 *  - the picker deduped on product id alone, so the same product could not be
 *    both trigger and reward, which is the commonest BOGO there is;
 *  - "100 = free" made an operator encode the ordinary case as a magic number,
 *    and one of them typed 7.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The payload cases assert the WHOLE item set — roles and ids together — not
 * that some item exists. "A GET item was sent" would pass for a build that
 * dropped the trigger; "a BUY item was sent" would pass for the broken version
 * this replaces. Each case that asserts a control is present also asserts what
 * it produces on save, so a rendered-but-unwired control fails.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainFor } from '@hardware-pos/shared';

// ── boundaries ───────────────────────────────────────────────────────────────

const session = {
  token: 't',
  user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
  branchId: 'brn_1',
} as never;

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

vi.mock('@/lib/products/branches-api', () => ({
  fetchBranches: vi.fn(async () => []),
}));

/** The two products the picker offers. */
const PRODUCTS = [
  { id: 'prd_shirt', name: 'Shirt', type: 'Inventory', quantityOnHand: 10, unitPrice: 2000 },
  { id: 'prd_tie', name: 'Tie', type: 'Inventory', quantityOnHand: 5, unitPrice: 500 },
];

vi.mock('@/lib/products-api', () => ({
  fetchProducts: vi.fn(async () => ({ items: PRODUCTS, total: 2, page: 1, pageSize: 20 })),
  listManagedProducts: async () => ({ items: [], total: 0, nextCursor: null }),
  resolveImageUrl: (u: string | null) => u,
  variantSkuLabel: () => 'SKU-1',
}));

// Parameters declared so the payload can be read off `mock.calls[n][1]` —
// a zero-arg mock infers an empty tuple and the index is a type error.
const createPromotion = vi.fn(async (_session: unknown, _input: unknown) => ({
  id: 'promo_new',
}));

vi.mock('@/lib/products/promotions-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products/promotions-api')>();
  return { ...actual, createPromotion, updatePromotion: vi.fn(), fetchPromotion: vi.fn() };
});

const { PromotionEditor } = await import('./promotion-editor');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Render the editor already switched to Buy X, Get Y. */
async function renderBogo() {
  render(<PromotionEditor session={session} />);
  await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
  fireEvent.click(screen.getByRole('radio', { name: /Buy X, Get Y/ }));
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Shirt offer' } });
}

/** The section card with this heading, so queries can be scoped to one half. */
function section(name: 'Customer buys' | 'Customer gets') {
  const heading = screen.getByRole('heading', { name });
  return within(heading.closest('div')!.parentElement!);
}

/** Open the picker from one section and choose a product by name. */
async function choose(from: 'Customer buys' | 'Customer gets', product: string) {
  const button = section(from).getByRole('button', { name: /Choose product|Change product|Add reward/ });
  fireEvent.click(button);
  const dialog = within(await screen.findByRole('dialog'));
  const option = await dialog.findByRole('button', { name: new RegExp(product) });
  fireEvent.click(option);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** The items in the payload of the Nth create call, role-tagged. */
function itemsOf(call = 0): { productId: string; role: string }[] {
  const payload = createPromotion.mock.calls[call]?.[1] as
    | { items: { productId: string; role: string }[] }
    | undefined;
  return (payload?.items ?? []).map((i) => ({ productId: i.productId, role: i.role }));
}

function payload(call = 0) {
  return createPromotion.mock.calls[call]?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

// ── specs ────────────────────────────────────────────────────────────────────

describe('the form is two sections, not a list with roles', () => {
  it('offers Customer buys and Customer gets, and no role dropdown at all', async () => {
    await renderBogo();

    // POSITIVE: the two halves of the sentence are the form.
    expect(screen.getByRole('heading', { name: 'Customer buys' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Customer gets' })).toBeTruthy();

    // NEGATIVE: the control that made role an attribute is gone. Asserting its
    // absence alone would pass for a blank page, which is why the two headings
    // above are checked in the same render.
    expect(screen.queryByLabelText('Item role')).toBeNull();
  });

  it('sends the product from each section under that section’s role', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');
    await choose('Customer gets', 'Tie');

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));

    // The WHOLE set: a build that dropped either half would satisfy a
    // "contains a BUY item" check.
    expect(itemsOf()).toEqual([
      { productId: 'prd_shirt', role: 'BUY' },
      { productId: 'prd_tie', role: 'GET' },
    ]);
  });

  it('replaces the buy product instead of appending a second one', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');
    await choose('Customer buys', 'Tie');
    await choose('Customer gets', 'Shirt');

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));

    // The server refuses more than one BUY item on this type; composing one
    // and finding out at save time is the failure this prevents.
    expect(itemsOf().filter((i) => i.role === 'BUY')).toEqual([
      { productId: 'prd_tie', role: 'BUY' },
    ]);
  });
});

describe('the reward', () => {
  it('can be the very product being bought — B2G1 on one item', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');

    fireEvent.click(screen.getByLabelText(/reward is the same product/i));

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));

    // The offer the old picker could not express at all: it deduped on product
    // id, so one product could only ever hold one role. The server has always
    // accepted the pair — `@@unique([promotionId, productId, role])`.
    expect(itemsOf()).toEqual([
      { productId: 'prd_shirt', role: 'BUY' },
      { productId: 'prd_shirt', role: 'GET' },
    ]);
  });

  it('is free by default, and Free means 100 on the wire', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');
    await choose('Customer gets', 'Tie');

    // No percentage box while Free is selected — the operator is never asked
    // to know that 100 means free.
    expect(screen.queryByLabelText('Percentage off the reward')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));
    expect(payload()?.percentageOff).toBe(100);
  });

  it('takes a typed percentage when the operator asks for one', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');
    await choose('Customer gets', 'Tie');

    fireEvent.click(screen.getByRole('radio', { name: 'Percentage off' }));
    fireEvent.change(screen.getByLabelText('Percentage off the reward'), {
      target: { value: '50' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));
    expect(payload()?.percentageOff).toBe(50);
  });
});

describe('a half-written offer cannot be saved', () => {
  it('names the missing reward instead of letting the server reject it', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    // The exact shape that used to save happily and then never fire.
    expect(await screen.findByText(/Choose what the customer gets/)).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('names the missing trigger too', async () => {
    await renderBogo();
    await choose('Customer gets', 'Tie');

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    expect(await screen.findByText(/has to buy/)).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });
});

describe('the offer is read back', () => {
  it('states the whole sentence once both halves are chosen', async () => {
    await renderBogo();
    fireEvent.change(screen.getByLabelText('Buy quantity'), { target: { value: '2' } });
    await choose('Customer buys', 'Shirt');
    await choose('Customer gets', 'Tie');

    const summary = await screen.findByRole('status');
    expect(summary.textContent).toBe('Buy 2 × Shirt, get 1 × Tie free.');
  });

  it('says nothing until there is something true to say', async () => {
    await renderBogo();
    await choose('Customer buys', 'Shirt');

    // Half a sentence read back is worse than none — it would describe an
    // offer the save is about to refuse.
    expect(screen.queryByRole('status')).toBeNull();
  });
});
