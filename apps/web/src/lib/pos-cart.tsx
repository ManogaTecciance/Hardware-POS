'use client';

import * as React from 'react';

import {
  cartLineKey,
  newCartItem,
  type CartItem,
  type CartLineKey,
  type LineDiscount,
  type OrderDiscount,
} from './cart';
import type { ClientCustomer, ClientProduct, ClientVariant } from './catalog';

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
 * D99 — repair a cart persisted before lines had a key.
 *
 * sessionStorage survives a deploy, so the first load after this change reads
 * back items with no `lineKey` and no `variant`. Left alone every line would key
 * on `undefined`, and `removeItem(undefined)` would then delete the whole cart at
 * the first tap of a trash icon.
 *
 * An old line had no variant by definition, so it keys on its product id — which
 * is exactly what `cartLineKey` produces for a variant-less line.
 */
function migrate(state: PosCartState): PosCartState {
  if (!Array.isArray(state.items)) return EMPTY;
  return {
    ...state,
    items: state.items.map((it) => ({
      ...it,
      variant: it.variant ?? null,
      lineKey: it.lineKey ?? cartLineKey(it.product.id, null),
    })),
  };
}

/**
 * Maximum sellable quantity for a product: its on-hand stock for Inventory
 * items, or null (no cap) for Service / Non-Inventory items, which aren't
 * stock-tracked and can always be sold.
 */
export function stockCap(product: ClientProduct, variant: ClientVariant | null = null): number | null {
  // D99 — a variant caps against its own branch stock (1b.1 put it on the read
  // model). Without this a cashier can add ten Mediums when three exist and only
  // find out at checkout, where the server refuses with the message 1a.19 built.
  if (variant) {
    return variant.stockState === 'UNTRACKED' ? null : (variant.quantityOnHand ?? 0);
  }
  return product.type === 'Inventory' ? product.quantityOnHand : null;
}

interface PosCartValue extends PosCartState {
  /** True once sessionStorage has been read (avoids empty-cart flash on route load). */
  hydrated: boolean;
  /** D99 — `variant` is optional so pre-picker callers keep working (1c.4 supplies it). */
  addToCart: (product: ClientProduct, variant?: ClientVariant | null) => void;
  changeQty: (lineKey: CartLineKey, delta: number) => void;
  /** Set an item's quantity to an absolute value (typed in). Clamped to >= 1. */
  setQty: (lineKey: CartLineKey, quantity: number) => void;
  removeItem: (lineKey: CartLineKey) => void;
  setNote: (lineKey: CartLineKey, note: string) => void;
  setLineDiscount: (
    lineKey: CartLineKey,
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
      if (raw) setState({ ...EMPTY, ...migrate(JSON.parse(raw) as PosCartState) });
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
    (lineKey: CartLineKey, fn: (item: CartItem) => CartItem) =>
      setState((s) => ({
        ...s,
        items: s.items.map((it) => (it.lineKey === lineKey ? fn(it) : it)),
      })),
    [],
  );

  const value = React.useMemo<PosCartValue>(
    () => ({
      ...state,
      hydrated,
      addToCart: (product, variant = null) =>
        setState((s) => {
          // D99 — the key decides merge-or-append. Two sizes of one shirt produce
          // two keys and therefore two lines; the same size twice still merges.
          const key = cartLineKey(product.id, variant?.id ?? null);
          const found = s.items.find((it) => it.lineKey === key);
          const items = found
            ? s.items.map((it) => (it.lineKey === key ? { ...it, quantity: it.quantity + 1 } : it))
            : [...s.items, newCartItem(product, variant)];
          return { ...s, items };
        }),
      changeQty: (lineKey, delta) =>
        setState((s) => {
          const items = s.items
            .map((it) => {
              if (it.lineKey !== lineKey) return it;
              // Never let an increment push an Inventory item over its stock.
              const cap = stockCap(it.product, it.variant);
              const next = it.quantity + delta;
              return { ...it, quantity: cap != null ? Math.min(next, cap) : next };
            })
            .filter((it) => it.quantity > 0);
          // Drop the order discount if the cart empties.
          return items.length === 0
            ? { ...s, items, orderDiscount: undefined, orderApprovalToken: undefined }
            : { ...s, items };
        }),
      setQty: (lineKey, quantity) =>
        setState((s) => {
          if (!Number.isFinite(quantity)) return s;
          return {
            ...s,
            items: s.items.map((it) => {
              if (it.lineKey !== lineKey) return it;
              // Typed quantity: whole number, minimum 1 (removal is via the
              // trash button), capped at remaining stock for Inventory items.
              const cap = stockCap(it.product, it.variant);
              let q = Math.max(1, Math.floor(quantity));
              if (cap != null) q = Math.min(q, cap);
              return { ...it, quantity: q };
            }),
          };
        }),
      removeItem: (lineKey) =>
        setState((s) => {
          const items = s.items.filter((it) => it.lineKey !== lineKey);
          return items.length === 0
            ? { ...s, items, orderDiscount: undefined, orderApprovalToken: undefined }
            : { ...s, items };
        }),
      setNote: (lineKey, note) => updateItem(lineKey, (it) => ({ ...it, note: note || undefined })),
      setLineDiscount: (lineKey, discount, approvalToken, approvedByUserId) =>
        updateItem(lineKey, (it) => ({ ...it, discount, approvalToken, approvedByUserId })),
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
            // D99 — refresh the VARIANT snapshot too. Without this a size's price
            // and stock go stale while its product updates around them, and the
            // quantity cap would then be enforced against a number another till
            // has already moved.
            const freshVariant = it.variant
              ? (fresh.variants.find((v) => v.id === it.variant!.id) ?? it.variant)
              : null;
            const cur = it.product;
            if (
              cur.quantityOnHand === fresh.quantityOnHand &&
              cur.unitPrice === fresh.unitPrice &&
              cur.name === fresh.name &&
              cur.imageUrl === fresh.imageUrl &&
              it.variant?.unitPrice === freshVariant?.unitPrice &&
              it.variant?.quantityOnHand === freshVariant?.quantityOnHand
            ) {
              return it;
            }
            changed = true;
            return { ...it, product: fresh, variant: freshVariant };
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
