/**
 * D145 — clearing the retail cart asks first, and the asking is the guard.
 *
 * This site is the POSITIVE form: `if (ok) cart.clearCart()`. Nothing about it
 * is visible in the DOM, so the only way to tell a real guard from a button
 * that empties the cart and opens a dialog for decoration is to answer the
 * dialog both ways and watch `clearCart`.
 *
 * So all three assertions are made, and each rules out a different broken
 * version:
 *
 *   - Confirming clears — a component that never resolved the promise, or
 *     dropped the call, passes the cancel case alone.
 *   - Dismissing does NOT clear — a component with the guard removed passes
 *     the confirm case alone.
 *   - Opening the dialog has not cleared anything yet — this is what fails if
 *     the clear were moved ahead of the question and merely announced.
 *
 * Only the Clear control is exercised; the rest of the checkout is stubbed at
 * its data seams (catalogue, cart, auth) so the spec cannot go green or red
 * for a reason that has nothing to do with the confirmation.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import { cartLineKey, type CartItem } from '@/lib/cart';
import type { CheckoutData, ClientProduct } from '@/lib/catalog';

// ── fixtures ─────────────────────────────────────────────────────────────────

const PRODUCT: ClientProduct = {
  id: 'p1',
  name: 'Floor Tile 60x60',
  sku: 'TIL-60',
  type: 'Inventory',
  categoryName: 'Tiles',
  subcategoryId: null,
  subcategoryName: null,
  unitPrice: 1200,
  quantityOnHand: 40,
  stockState: 'IN_STOCK',
  imageUrl: null,
  taxable: true,
  quantityType: 'WHOLE',
  unitOfMeasure: null,
  variants: [],
};

// Keyed through the real `cartLineKey`, so the fixture carries the same line
// identity production does rather than a hand-written string that only looks
// like one.
const ITEM: CartItem = {
  lineKey: cartLineKey(PRODUCT.id, null),
  product: PRODUCT,
  variant: null,
  quantity: 2,
};

const clearCart = vi.fn();

/*
 * One frozen object, not a fresh literal per render: the component destructures
 * `setShopTimeZone` into an effect's dependency list, and a new identity every
 * render would loop it.
 */
const cart = {
  items: [ITEM],
  customerId: '',
  addedCustomers: [],
  orderDiscount: undefined,
  orderApprovalToken: undefined,
  saleDate: '2026-01-01',
  hydrated: true,
  today: '2026-01-01',
  saleDateValid: true,
  submittedSaleDate: undefined,
  setShopTimeZone: vi.fn(),
  setSaleDate: vi.fn(),
  addToCart: vi.fn(),
  changeQty: vi.fn(),
  setQty: vi.fn(),
  removeItem: vi.fn(),
  setNote: vi.fn(),
  setLineDiscount: vi.fn(),
  setOrderDiscount: vi.fn(),
  setCustomerId: vi.fn(),
  addCustomer: vi.fn(),
  refreshProducts: vi.fn(),
  clearCart,
};

const checkout: CheckoutData = {
  loading: false,
  error: null,
  products: [PRODUCT],
  categories: ['Tiles'],
  categoryTree: [{ id: 'c1', name: 'Tiles', subcategories: [] }],
  settings: { currency: 'LKR', taxRatePercent: 15, timezone: 'Asia/Colombo' },
  promotionRules: [],
  reload: vi.fn(),
};

// ── seams ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// MANAGER, so `discountLimitFor` resolves to a real number for the discount
// dialogs this screen always mounts (closed).
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { token: 't', user: { id: 'u1', role: 'MANAGER' }, branchId: 'b1' },
    // No optional permissions: the Clear control does not depend on any, and
    // granting them would only add fetching neighbours to the tree.
    hasPermission: () => false,
  }),
}));

// Partial mocks: `stockCap`, `isMeasured` and `displayPrice` are real logic the
// cart panel renders through, and stubbing them would make the fixture lie.
vi.mock('@/lib/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catalog')>()),
  useCheckoutData: () => checkout,
}));

vi.mock('@/lib/pos-cart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pos-cart')>()),
  usePosCart: () => cart,
}));

// Both hit the held-sales API on mount; neither is under test here.
vi.mock('@/components/pos/held-sales', () => ({
  HoldCartButton: () => null,
  HeldSalesButton: () => null,
}));

// Searches customers as soon as it opens; the cart header only needs a slot.
vi.mock('@/components/pos/customer-combobox', () => ({
  CustomerCombobox: () => null,
}));

const { PosRetailCheckout } = await import('./pos-retail-checkout');

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function renderCheckout() {
  render(
    <ConfirmProvider>
      <PosRetailCheckout />
    </ConfirmProvider>,
  );
}

/** The cart header's Clear — not the search box's "Clear search". */
const clearButton = () => screen.getByRole('button', { name: 'Clear' });

describe('PosRetailCheckout — clearing the cart (D145)', () => {
  it('asks before clearing, and clears when the question is answered yes', async () => {
    renderCheckout();

    fireEvent.click(clearButton());

    // The question is the app's own dialog, with a destructive verb rather than
    // a bare OK, and the cart is still untouched while it stands open.
    expect(
      await screen.findByRole('heading', { name: 'Clear all items from the cart?' }),
    ).toBeTruthy();
    expect(clearCart).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear cart' }));

    await waitFor(() => expect(clearCart).toHaveBeenCalledTimes(1));
  });

  it('leaves the cart alone when the question is cancelled', async () => {
    renderCheckout();

    fireEvent.click(clearButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    // The dialog going away is what makes the negative meaningful: it proves the
    // promise settled and the handler ran on to its guard, rather than the click
    // never having reached the button at all.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Clear all items from the cart?' })).toBeNull(),
    );
    expect(clearCart).not.toHaveBeenCalled();
  });

  it('leaves the cart alone when the question is dismissed with Escape', async () => {
    renderCheckout();

    fireEvent.click(clearButton());
    await screen.findByRole('heading', { name: 'Clear all items from the cart?' });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Clear all items from the cart?' })).toBeNull(),
    );
    expect(clearCart).not.toHaveBeenCalled();
  });
});

/**
 * D160 — every unfinished BUY_X_GET_Y blocks, and says so the same way.
 *
 * ## What changed, and why these assertions were rewritten
 *
 * D155 shipped a same-product prompt that deliberately did NOT block payment,
 * reasoning that five ties at full price is a real sale. Two assertions here
 * pinned that: one required Proceed to Payment to stay ENABLED, and one
 * required the muted prompt to be suppressed while a debt was live.
 *
 * The PO reversed the decision: a customer who qualified for a free item must
 * not leave without it, and every reward offer behaves identically whether the
 * free item is the same product or a different one. So both assertions now
 * state the opposite, deliberately (D16 forbids editing assertions to
 * accommodate a REFACTOR; this is an intentional behaviour change with a
 * decision record behind it).
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * "Both shapes behave the same" is the claim, so it is asserted as a PAIR
 * against the same component: a same-product offer and a cross-product one,
 * each one unit short, must produce the same wording and the same disabled
 * button. A test that only checked the same-product case would pass a till
 * that had started blocking EVERYTHING, which is a worse defect.
 *
 * The two "says nothing" cases are what stop that: a basket that is nowhere
 * near an offer, and one where the reward has already landed, must both pay
 * freely. Without them, "blocks payment" would pass for a till whose button
 * is simply always disabled.
 */
describe('D160 — unfinished offers block, whichever shape they are', () => {
  /** Buy 5 get 1 on ONE product: six for the price of five. */
  const sameProductOffer = {
    id: 'r_tie',
    name: 'Tie Offer',
    type: 'BUY_X_GET_Y' as const,
    buyQuantity: 5,
    getQuantity: 1,
    percentageOff: 100,
    stackable: false,
    items: [
      { productId: PRODUCT.id, role: 'BUY' as const, quantity: 1 },
      { productId: PRODUCT.id, role: 'GET' as const, quantity: 1 },
    ],
  };

  /** Buy 2 of ours, get 1 of something we are NOT holding. */
  const crossOffer = {
    id: 'r_cross',
    name: 'Buy 2 Get 1',
    type: 'BUY_X_GET_Y' as const,
    buyQuantity: 2,
    getQuantity: 1,
    percentageOff: 100,
    stackable: false,
    items: [
      { productId: PRODUCT.id, role: 'BUY' as const, quantity: 1 },
      { productId: 'p_other', role: 'GET' as const, quantity: 1 },
    ],
  };

  const payButton = () => screen.getByRole('button', { name: /Proceed to Payment/i });

  /** The whole notice, read off the element that owns it. */
  const notice = () =>
    screen
      .getAllByText((_, el) => /to complete this offer/.test(el?.textContent ?? ''))
      .pop()?.textContent ?? '';

  function withCart(quantity: number, rules: unknown[]) {
    cart.items = [{ ...ITEM, quantity }];
    checkout.promotionRules = rules as never;
  }

  afterEach(() => {
    cart.items = [ITEM];
    checkout.promotionRules = [];
  });

  it('a same-product offer one unit short blocks payment', () => {
    /*
     * The reversal, stated as an assertion. D155 required the opposite here.
     * The accepted cost: a customer who wants exactly five ties cannot be
     * served until the sixth — which is free — is added.
     */
    withCart(5, [sameProductOffer]);
    renderCheckout();

    expect(notice()).toMatch(/Add\s*1\s*Floor Tile 60x60\s*to complete this offer/);
    expect(screen.getByText(/Payment is unavailable/i)).toBeTruthy();
    expect(payButton()).toHaveProperty('disabled', true);
  });

  it('and it is the SAME notice a cross-product offer gets', () => {
    /*
     * The point of the change, and the half that makes the case above mean
     * something: "handle it like the shirt/tie offer" is a claim about
     * sameness, so the two are read off the same component and compared.
     */
    withCart(5, [sameProductOffer]);
    renderCheckout();
    const sameProduct = notice();
    const sameProductGift = screen.getByText(/🎁/).textContent;

    cleanup();
    withCart(2, [crossOffer]);
    renderCheckout();

    // Same sentence shape, same gift, same refusal wording.
    expect(notice()).toMatch(/Add\s*1\s*.+\s*to complete this offer/);
    expect(sameProduct).toMatch(/Add\s*1\s*.+\s*to complete this offer/);
    expect(sameProductGift).toMatch(/🎁/);
    expect(screen.getByText(/🎁/).textContent).toMatch(/🎁/);
    expect(payButton()).toHaveProperty('disabled', true);
  });

  it('counts how many are still needed, not just "one"', () => {
    /*
     * Every other case here happens to need exactly one, so a till that
     * hard-coded "1" would pass all of them — found by mutating the count and
     * watching nothing fail. "Buy 2 get 2" with two in the basket needs two
     * more, and exercises the plural at the same time.
     */
    const buyTwoGetTwo = {
      ...sameProductOffer,
      id: 'r_two',
      name: 'Two For Two',
      buyQuantity: 2,
      getQuantity: 2,
    };
    withCart(2, [buyTwoGetTwo]);
    renderCheckout();

    expect(notice()).toMatch(/Add\s*2\s*Floor Tile 60x60s\s*to complete this offer/);
    expect(payButton()).toHaveProperty('disabled', true);
  });

  it('names both offers when both are short, rather than hiding one', () => {
    /*
     * D155 suppressed the same-product prompt while a debt was live, so the
     * cashier read one instruction at a time and the blocking one won. Both
     * block now, so both are named: hiding one would leave the cashier
     * completing an offer and finding the button still disabled with no
     * explanation for the second.
     */
    withCart(5, [sameProductOffer, crossOffer]);
    renderCheckout();

    const names = screen.getAllByText(/🎁/).map((el) => el.textContent);
    expect(names).toHaveLength(2);
    expect(names.join(' ')).toMatch(/Tie Offer/);
    expect(names.join(' ')).toMatch(/Buy 2 Get 1/);
    expect(payButton()).toHaveProperty('disabled', true);
  });

  it('says nothing once the reward has landed, and payment opens', () => {
    // Six units: the sixth is already free. This is the control that stops
    // "blocks payment" passing for a till whose button is always disabled.
    withCart(6, [sameProductOffer]);
    renderCheckout();

    expect(screen.queryByText(/to complete this offer/i)).toBeNull();
    expect(screen.queryByText(/Payment is unavailable/i)).toBeNull();
    expect(payButton()).toHaveProperty('disabled', false);
  });

  it('says nothing when the basket is nowhere near an offer', () => {
    /*
     * The other control, and the one that keeps the change proportionate.
     * Two units against a buy-five offer has qualified for nothing, so there
     * is nothing to complete — blocking here would refuse every small basket
     * in the shop.
     */
    withCart(2, [sameProductOffer]);
    renderCheckout();

    expect(screen.queryByText(/to complete this offer/i)).toBeNull();
    expect(payButton()).toHaveProperty('disabled', false);
  });
});
