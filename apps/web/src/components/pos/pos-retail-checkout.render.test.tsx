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
 * D155 — the near-miss prompt, on the screen it appears on.
 *
 * ## What makes these assertions non-vacuous
 *
 * `applier.spec.ts` already proves the arithmetic. This proves the two things
 * arithmetic cannot: that the till RENDERS it, and — the one that matters —
 * that rendering it leaves **Proceed to Payment enabled**.
 *
 * The blocking case is asserted in the same file, against the same component,
 * so "payment stayed enabled" cannot pass because the gate broke entirely and
 * now never blocks anything. One offer opens the gate, the other closes it.
 */
describe('D155 — the upsell prompt', () => {
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

  /** Buy 2 of ours, get 1 of something we are NOT holding — a real debt. */
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

  function withCart(quantity: number, rules: unknown[]) {
    cart.items = [{ ...ITEM, quantity }];
    checkout.promotionRules = rules as never;
  }

  afterEach(() => {
    cart.items = [ITEM];
    checkout.promotionRules = [];
  });

  it('offers the free one when the basket is a unit short, and lets them pay anyway', () => {
    withCart(5, [sameProductOffer]);
    renderCheckout();

    /*
     * POSITIVE — the whole sentence, read off the element that owns it. The
     * prompt is built from several spans, so a plain string matcher would find
     * none of it; and a loose /Add/ finds the cart's own "Add order discount".
     */
    const prompt = screen
      .getAllByText((_, el) => /Add\s*1\s*more/.test(el?.textContent ?? ''))
      .pop();
    expect(prompt?.textContent).toMatch(
      /Add\s*1\s*more\s*Floor Tile 60x60\s*and\s*one is free\s*—\s*Tie Offer/,
    );

    // …and THE POINT: five at full price is a real sale.
    expect(payButton()).toHaveProperty('disabled', false);
    // It is an offer, not a requirement, so it must not borrow the debt wording.
    expect(screen.queryByText(/Payment is unavailable/i)).toBeNull();
  });

  it('says nothing once the reward has landed', () => {
    // Six units: the sixth is already free, so asking for a seventh would ask
    // for one that gets charged.
    withCart(6, [sameProductOffer]);
    renderCheckout();

    expect(screen.queryByText(/is free/i)).toBeNull();
    expect(payButton()).toHaveProperty('disabled', false);
  });

  it('says nothing when the basket is nowhere near', () => {
    withCart(2, [sameProductOffer]);
    renderCheckout();

    expect(screen.queryByText(/is free/i)).toBeNull();
  });

  it('a DEBT still blocks payment — the control that proves the gate works', () => {
    /*
     * Without this, every "payment stayed enabled" assertion above would pass
     * against a till whose gate had been removed altogether. Here the customer
     * has earned a product they are not holding, and completing the sale would
     * pocket it.
     */
    withCart(2, [crossOffer]);
    renderCheckout();

    expect(screen.getByText(/Payment is unavailable/i)).toBeTruthy();
    expect(payButton()).toHaveProperty('disabled', true);
  });

  it('a debt outranks an offer: one instruction at a time', () => {
    // Both rules live. The blocking one wins the space, because a cashier
    // reading "add one more, it is free" beside "you cannot pay" acts on the
    // wrong one.
    withCart(5, [sameProductOffer, crossOffer]);
    renderCheckout();

    expect(screen.getByText(/Payment is unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/one is free/i)).toBeNull();
  });
});
