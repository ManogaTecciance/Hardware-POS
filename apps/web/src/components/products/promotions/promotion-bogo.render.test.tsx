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
const { forgetCurrency, rememberCurrency } = await import('@/lib/tenant-money');

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

/**
 * Open the picker and choose a product by name. `from` is a BOGO section
 * heading, or 'Products' for the flat list the other types share.
 */
async function choose(from: 'Customer buys' | 'Customer gets' | 'Products', product: string) {
  const button =
    from === 'Products'
      ? screen.getByRole('button', { name: 'Add product' })
      : section(from).getByRole('button', {
          name: /Choose product|Change product|Add reward/,
        });
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

/*
 * Money adornments live here rather than in their own file because this is the
 * editor's only render harness — the mocks above are what it takes to mount
 * it, and a second copy of them would be the thing that goes stale.
 */
describe('money fields name the tenant’s currency', () => {
  it('labels Amount off and its input with the tenant’s code, not the pilot’s', async () => {
    // D54 — a tenant billing in USD must not be shown LKR anywhere. The
    // synchronous read is cached in module memory, so it is reset per case.
    forgetCurrency();
    rememberCurrency('USD');

    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Amount off/ }));

    // The type button's own badge AND the field's prefix — the two places the
    // pilot's currency was hardcoded.
    expect(screen.getAllByText('USD').length).toBeGreaterThan(1);
    // NEGATIVE: and the hardcoded code is gone, not merely joined. Without
    // this arm the assertion above would pass for a build that printed both.
    expect(screen.queryByText('LKR')).toBeNull();
  });

  it('falls back to LKR when the tenant has no currency cached', async () => {
    // POSITIVE CONTROL for the case above: the default is unchanged, so that
    // test proves the value is READ rather than that some string renders.
    forgetCurrency();

    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());

    // Both places again — the Amount-off badge and the Bundle price field's
    // prefix, since Bundle is the type the editor opens on.
    expect(screen.getAllByText('LKR').length).toBeGreaterThan(1);
    expect(screen.queryByText('USD')).toBeNull();
  });
});

/*
 * D141 — the money-off form states its scope instead of implying it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The threshold cases are the point, and each asserts the PAYLOAD, not the
 * screen: the old form accepted `minimumSpend` beside a product list and the
 * server stored it, so "the field was filled in" was already true of the
 * broken version. What was never true is that the saved rule could honour it.
 * Every case that hides a control also asserts one that must still be there,
 * so a section that failed to render cannot pass.
 */
describe('a money-off promotion states what it discounts', () => {
  async function renderAmountOff() {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Amount off/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rs 100 off' } });
    fireEvent.change(screen.getByLabelText(/^Amount off/), { target: { value: '100' } });
  }

  it('offers the whole cart by default, with a threshold and no product list', async () => {
    await renderAmountOff();

    expect((screen.getByRole('radio', { name: 'The whole cart' }) as HTMLInputElement).checked)
      .toBe(true);
    // POSITIVE: the threshold belongs to this mode…
    expect(screen.getByLabelText('Minimum spend')).toBeTruthy();
    // …NEGATIVE: and a cart-level rule has no products by definition, so
    // offering the list would offer a way to contradict the chosen scope.
    expect(screen.queryByRole('button', { name: 'Add product' })).toBeNull();
  });

  it('sends the threshold on a cart-level rule', async () => {
    await renderAmountOff();
    fireEvent.change(screen.getByLabelText('Minimum spend'), { target: { value: '10000' } });

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));

    expect(payload()?.minimumSpend).toBe(10000);
    expect(payload()?.items).toEqual([]);
  });

  it('swaps the threshold for the product list on Specific products', async () => {
    await renderAmountOff();
    fireEvent.change(screen.getByLabelText('Minimum spend'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Specific products' }));

    // The engine reads `minimumSpend` only for a rule with no items, so a
    // threshold here could never be consulted. It goes with the mode.
    expect(screen.queryByLabelText('Minimum spend')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add product' })).toBeTruthy();
  });

  it('never saves a threshold the engine cannot honour', async () => {
    await renderAmountOff();
    fireEvent.change(screen.getByLabelText('Minimum spend'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Specific products' }));
    await choose('Products', 'Shirt');

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));

    // The whole defect, in one assertion: the old form stored 10000 beside a
    // product list and the engine ignored it for the life of the promotion.
    expect(payload()?.minimumSpend).toBeNull();
    expect(itemsOf()).toEqual([{ productId: 'prd_shirt', role: 'BUY' }]);
  });

  it('blocks a product-scoped rule that names no products', async () => {
    await renderAmountOff();
    fireEvent.click(screen.getByRole('radio', { name: 'Specific products' }));

    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    // Empty used to MEAN cart-level, so this exact form saved a promotion that
    // did something other than what the operator had just selected.
    expect(await screen.findByText(/switch to the whole cart/)).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('reads the offer back', async () => {
    await renderAmountOff();
    fireEvent.change(screen.getByLabelText('Minimum spend'), { target: { value: '10000' } });

    const summary = await screen.findByRole('status');
    expect(summary.textContent).toMatch(/off any basket of/);
    expect(summary.textContent).toMatch(/10,000/);
  });
});

/*
 * Negative and out-of-range figures, caught before the round trip.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * `type="number" min={0}` already looked like validation and was not: the
 * attribute marks the field `:invalid` and constrains the steppers, and with
 * no native form submit nothing consulted it. So every case here pairs the
 * message with `createPromotion` NOT being called — "an error appeared" would
 * be satisfied by a build that showed a message and saved anyway, and
 * "nothing saved" by one that refused every promotion. The last case is the
 * positive control: a valid figure in the same field still saves.
 */
describe('amounts are checked before the save, not by the server', () => {
  async function amountOffWith(value: string) {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Amount off/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rs off' } });
    fireEvent.change(screen.getByLabelText(/^Amount off/), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
  }

  it('refuses a negative amount off', async () => {
    await amountOffWith('-10');

    expect(await screen.findByText('Amount off must be more than zero.')).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('refuses a third decimal place, which the column cannot hold', async () => {
    await amountOffWith('10.999');

    expect(
      await screen.findByText('Amount off cannot have more than two decimal places.'),
    ).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('refuses a negative minimum spend, and says so about THAT field', async () => {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Amount off/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rs off' } });
    fireEvent.change(screen.getByLabelText(/^Amount off/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Minimum spend'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    // Zero IS a legal threshold, so this field's floor is different from the
    // amount's — and the message has to name the right field or the operator
    // corrects the wrong box.
    expect(await screen.findByText('Minimum spend cannot be negative.')).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('refuses a reward percentage over 100', async () => {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Buy X, Get Y/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'BOGO' } });
    await choose('Customer buys', 'Shirt');
    await choose('Customer gets', 'Tie');
    fireEvent.click(screen.getByRole('radio', { name: 'Percentage off' }));
    fireEvent.change(screen.getByLabelText('Percentage off the reward'), {
      target: { value: '150' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    expect(
      await screen.findByText('The discount on the reward cannot be more than 100.'),
    ).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('refuses a fractional buy quantity', async () => {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Buy X, Get Y/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'BOGO' } });
    await choose('Customer buys', 'Shirt');
    await choose('Customer gets', 'Tie');
    fireEvent.change(screen.getByLabelText('Buy quantity'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));

    expect(await screen.findByText('Buy quantity must be a whole number.')).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('still saves a perfectly ordinary amount', async () => {
    // POSITIVE CONTROL: without it every case above is satisfied by a form
    // that refuses everything.
    await amountOffWith('10.99');

    await waitFor(() => expect(createPromotion).toHaveBeenCalledTimes(1));
    expect(payload()?.amountOff).toBe(10.99);
  });
});

/*
 * Where and when a problem is reported.
 *
 * The rules were already right; what was wrong was the delivery. One message
 * at a time, in a banner at the foot of a form long enough to have scrolled
 * past it, frozen from the moment Create was pressed — so correcting a field
 * left the old text standing and the only way to learn whether it had worked
 * was to press Create again.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * "Both messages are on screen" is the claim the old single-string validator
 * could not satisfy, and "the message went away on its own" is the one the
 * snapshot could not. Each is paired with the state that must NOT change with
 * it — the save still refused, the other field still complaining — so a form
 * that simply stopped validating fails.
 */
describe('problems are reported at their field, and follow the values', () => {
  async function blockedAmountOff() {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Amount off/ }));
    // Name blank AND amount negative: two problems, two fields.
    fireEvent.change(screen.getByLabelText(/^Amount off/), { target: { value: '-10' } });
    fireEvent.click(screen.getByRole('button', { name: /Create promotion/ }));
  }

  it('reports every bad field at once, not one save attempt at a time', async () => {
    await blockedAmountOff();

    expect(await screen.findByText('Give the promotion a name.')).toBeTruthy();
    expect(screen.getByText('Amount off must be more than zero.')).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('marks the offending inputs, so the field itself says it is wrong', async () => {
    await blockedAmountOff();
    await screen.findByText('Give the promotion a name.');

    expect(screen.getByLabelText(/^Name/).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(/^Amount off/).getAttribute('aria-invalid')).toBe('true');
  });

  it('focuses the first bad field so the next keystroke lands where the fix is', async () => {
    await blockedAmountOff();
    await screen.findByText('Give the promotion a name.');

    expect(document.activeElement).toBe(screen.getByLabelText(/^Name/));
  });

  it('clears a message the moment its field is corrected — no second Create', async () => {
    await blockedAmountOff();
    await screen.findByText('Give the promotion a name.');

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rs off' } });

    await waitFor(() => expect(screen.queryByText('Give the promotion a name.')).toBeNull());
    // …and ONLY that one. A form that dropped every message on any edit would
    // satisfy the line above and be worse than the snapshot it replaced.
    expect(screen.getByText('Amount off must be more than zero.')).toBeTruthy();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('says nothing at all before the first Create', async () => {
    forgetCurrency();
    render(<PromotionEditor session={session} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Channels' })).toBeTruthy());

    // Reward early, punish late: an empty form has not done anything wrong
    // yet, and complaining at someone mid-entry is the thing to avoid.
    expect(screen.queryByText('Give the promotion a name.')).toBeNull();
    expect(screen.getByLabelText(/^Name/).getAttribute('aria-invalid')).not.toBe('true');
  });
});
