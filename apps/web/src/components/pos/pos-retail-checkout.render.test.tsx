/**
 * D141 — clearing the retail cart asks first, and the asking is the guard.
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

describe('PosRetailCheckout — clearing the cart (D141)', () => {
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
