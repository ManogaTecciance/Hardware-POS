'use client';

import * as React from 'react';

import { newCartItem, type CartItem, type LineDiscount, type OrderDiscount } from './cart';
import type { ClientCustomer, ClientProduct } from './catalog';

/**
 * Shared POS cart state. Lives above the /pos and /pos/payment routes and
 * persists to sessionStorage, so navigating to Payment and back preserves the
 * cart, customer, notes, and discounts. Cleared only after a successful sale.
 */
const STORAGE_KEY = 'hpos.poscart';

interface PosCartState {
  items: CartItem[];
  customerId: string;
  /** Customers quick-added during this session (ahead of the loaded list). */
  addedCustomers: ClientCustomer[];
  orderDiscount?: OrderDiscount;
  orderApprovalToken?: string;
}

const EMPTY: PosCartState = { items: [], customerId: '', addedCustomers: [] };

/**
 * Maximum sellable quantity for a product: its on-hand stock for Inventory
 * items, or null (no cap) for Service / Non-Inventory items, which aren't
 * stock-tracked and can always be sold.
 */
export function stockCap(product: ClientProduct): number | null {
  return product.type === 'Inventory' ? product.quantityOnHand : null;
}

interface PosCartValue extends PosCartState {
  /** True once sessionStorage has been read (avoids empty-cart flash on route load). */
  hydrated: boolean;
  addToCart: (product: ClientProduct) => void;
  changeQty: (productId: string, delta: number) => void;
  /** Set an item's quantity to an absolute value (typed in). Clamped to >= 1. */
  setQty: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  setNote: (productId: string, note: string) => void;
  setLineDiscount: (
    productId: string,
    discount: LineDiscount | undefined,
    approvalToken?: string,
    approvedByUserId?: string,
  ) => void;
  setOrderDiscount: (discount: OrderDiscount | undefined, approvalToken?: string) => void;
  setCustomerId: (id: string) => void;
  /** Add a quick-created customer and select it. */
  addCustomer: (customer: ClientCustomer) => void;
  /**
   * Refresh the product snapshots embedded in cart items from a freshly
   * loaded catalog (stock/price may have changed on another register).
   */
  refreshProducts: (products: ClientProduct[]) => void;
  clearCart: () => void;
}

const PosCartContext = React.createContext<PosCartValue | null>(null);

export function PosCartProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<PosCartState>(EMPTY);
  const [hydrated, setHydrated] = React.useState(false);

  // Hydrate from sessionStorage after mount (avoids SSR/client mismatch).
  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw) setState({ ...EMPTY, ...(JSON.parse(raw) as PosCartState) });
    } catch {
      /* ignore malformed storage */
    }
    setHydrated(true);
  }, []);

  // Persist — but never before the stored cart has been read back. Without this
  // guard the mount-time run writes the initial EMPTY state over a saved cart,
  // and under StrictMode's double-invoked effects the second hydration then
  // reads that empty value, losing the cart on every full page load.
  React.useEffect(() => {
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, hydrated]);

  const updateItem = React.useCallback(
    (productId: string, fn: (item: CartItem) => CartItem) =>
      setState((s) => ({
        ...s,
        items: s.items.map((it) => (it.product.id === productId ? fn(it) : it)),
      })),
    [],
  );

  const value = React.useMemo<PosCartValue>(
    () => ({
      ...state,
      hydrated,
      addToCart: (product) =>
        setState((s) => {
          const found = s.items.find((it) => it.product.id === product.id);
          const items = found
            ? s.items.map((it) =>
                it.product.id === product.id ? { ...it, quantity: it.quantity + 1 } : it,
              )
            : [...s.items, newCartItem(product)];
          return { ...s, items };
        }),
      changeQty: (productId, delta) =>
        setState((s) => {
          const items = s.items
            .map((it) => {
              if (it.product.id !== productId) return it;
              // Never let an increment push an Inventory item over its stock.
              const cap = stockCap(it.product);
              const next = it.quantity + delta;
              return { ...it, quantity: cap != null ? Math.min(next, cap) : next };
            })
            .filter((it) => it.quantity > 0);
          // Drop the order discount if the cart empties.
          return items.length === 0
            ? { ...s, items, orderDiscount: undefined, orderApprovalToken: undefined }
            : { ...s, items };
        }),
      setQty: (productId, quantity) =>
        setState((s) => {
          if (!Number.isFinite(quantity)) return s;
          return {
            ...s,
            items: s.items.map((it) => {
              if (it.product.id !== productId) return it;
              // Typed quantity: whole number, minimum 1 (removal is via the
              // trash button), capped at remaining stock for Inventory items.
              const cap = stockCap(it.product);
              let q = Math.max(1, Math.floor(quantity));
              if (cap != null) q = Math.min(q, cap);
              return { ...it, quantity: q };
            }),
          };
        }),
      removeItem: (productId) =>
        setState((s) => {
          const items = s.items.filter((it) => it.product.id !== productId);
          return items.length === 0
            ? { ...s, items, orderDiscount: undefined, orderApprovalToken: undefined }
            : { ...s, items };
        }),
      setNote: (productId, note) => updateItem(productId, (it) => ({ ...it, note: note || undefined })),
      setLineDiscount: (productId, discount, approvalToken, approvedByUserId) =>
        updateItem(productId, (it) => ({ ...it, discount, approvalToken, approvedByUserId })),
      setOrderDiscount: (discount, approvalToken) =>
        setState((s) => ({ ...s, orderDiscount: discount, orderApprovalToken: approvalToken })),
      setCustomerId: (id) => setState((s) => ({ ...s, customerId: id })),
      addCustomer: (customer) =>
        setState((s) => ({
          ...s,
          addedCustomers: [customer, ...s.addedCustomers.filter((c) => c.id !== customer.id)],
          customerId: customer.id,
        })),
      refreshProducts: (products) =>
        setState((s) => {
          if (s.items.length === 0) return s;
          const byId = new Map(products.map((p) => [p.id, p]));
          let changed = false;
          const items = s.items.map((it) => {
            const fresh = byId.get(it.product.id);
            if (!fresh) return it;
            const cur = it.product;
            if (
              cur.quantityOnHand === fresh.quantityOnHand &&
              cur.unitPrice === fresh.unitPrice &&
              cur.name === fresh.name &&
              cur.imageUrl === fresh.imageUrl
            ) {
              return it;
            }
            changed = true;
            return { ...it, product: fresh };
          });
          // Same reference when nothing changed → no re-render, effects can
          // call this idempotently after every catalog load.
          return changed ? { ...s, items } : s;
        }),
      clearCart: () => setState(EMPTY),
    }),
    [state, hydrated, updateItem],
  );

  return <PosCartContext.Provider value={value}>{children}</PosCartContext.Provider>;
}

export function usePosCart(): PosCartValue {
  const ctx = React.useContext(PosCartContext);
  if (!ctx) throw new Error('usePosCart must be used within a PosCartProvider');
  return ctx;
}
