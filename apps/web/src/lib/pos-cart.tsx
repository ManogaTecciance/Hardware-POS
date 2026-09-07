'use client';

import * as React from 'react';

import { DEFAULT_TIME_ZONE, safeTimeZone, todayInTimeZone } from '@hardware-pos/shared';

import {
  newCartItem,
  stockCap,
  type CartItem,
  type LineDiscount,
  type OrderDiscount,
} from './cart';
import { isValidYmd } from './dates';
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
  /**
   * Exactly what the invoice-date input shows, as `YYYY-MM-DD`. Held raw —
   * including the empty string a date input emits mid-edit — so typing into the
   * field is not fought by the controlled value. Seeded to today on hydration and
   * rolled forward at midnight while it is still the untouched default.
   */
  saleDate: string;
}

const EMPTY: PosCartState = { items: [], customerId: '', addedCustomers: [], saleDate: '' };

// Defined in ./cart alongside computeLine, which has to agree with it; re-exported
// here because the POS screens have always imported it from the cart provider.
export { stockCap };

interface PosCartValue extends PosCartState {
  /** True once sessionStorage has been read (avoids empty-cart flash on route load). */
  hydrated: boolean;
  /**
   * The invoice date exactly as the input shows it — may be empty or partial
   * mid-edit, so check `saleDateValid` before using it.
   */
  saleDate: string;
  /**
   * Today as `YYYY-MM-DD` in the SHOP's timezone — the newest date the picker may
   * offer. Deliberately not the browser's day: the API judges an invoice date
   * against the shop's calendar, so a till whose browser is a day ahead would
   * otherwise offer a date the server rejects. Empty until hydration.
   */
  today: string;
  /** Tell the cart which zone the shop trades in (from settings). */
  setShopTimeZone: (tz: string) => void;
  /** True when `saleDate` is a real calendar day that is not in the future. */
  saleDateValid: boolean;
  /**
   * The date to send to the API: omitted (undefined) when the user left the
   * default alone, so the server keeps deciding "now" for the ordinary case.
   */
  submittedSaleDate: string | undefined;
  setSaleDate: (date: string) => void;
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
  // Client-only: "today" can only be resolved after mount, or the server render
  // would disagree with the browser and trip a hydration mismatch.
  const [today, setToday] = React.useState('');
  // Defaulted until settings load; the POS pages push the real value in.
  const [shopTz, setShopTz] = React.useState(DEFAULT_TIME_ZONE);

  // Tracks the day the UI currently believes it is, so the interval below can
  // tell a real rollover from a no-op tick without re-running the effect.
  const todayRef = React.useRef('');

  // Hydrate from sessionStorage after mount (avoids SSR/client mismatch).
  React.useEffect(() => {
    const t = todayInTimeZone(shopTz);
    todayRef.current = t;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      const restored = raw ? ({ ...EMPTY, ...(JSON.parse(raw) as PosCartState) } as PosCartState) : EMPTY;
      // A cart restored from a session left open overnight can carry a stale
      // date. Keep it only when it is usable AND there is a sale in progress to
      // keep it for — an empty cart's date is just yesterday's default, and
      // silently backdating the next customer's sale to it would be a bug.
      const keep =
        isValidYmd(restored.saleDate) &&
        restored.saleDate <= t &&
        (restored.items.length > 0 || restored.saleDate === t);
      setState({ ...restored, saleDate: keep ? restored.saleDate : t });
    } catch {
      /* ignore malformed storage */
      setState({ ...EMPTY, saleDate: t });
    }
    setToday(t);
    setHydrated(true);
  }, []);

  // A till is the one machine that is never closed, so the page outlives the
  // day. Without this the picker's max stays on yesterday after midnight and
  // refuses the actual current date.
  React.useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      const t = todayInTimeZone(shopTz);
      const prev = todayRef.current;
      if (prev === t) return;
      todayRef.current = t;
      setToday(t);
      // An untouched selector follows the clock; a deliberate backdate does not.
      setState((s) => (s.saleDate === prev || !s.saleDate ? { ...s, saleDate: t } : s));
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [hydrated, shopTz]);

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
      today,
      saleDateValid: isValidYmd(state.saleDate) && Boolean(today) && state.saleDate <= today,
      // Only sent when the user actually backdated; leaving the default alone
      // keeps the pre-existing "server decides now()" path and its timezone.
      submittedSaleDate:
        isValidYmd(state.saleDate) && state.saleDate !== today ? state.saleDate : undefined,
      // Stored verbatim, empty string included — a controlled date input that
      // snaps back to a default on every partial value cannot be typed into.
      setSaleDate: (date: string) => setState((s) => ({ ...s, saleDate: date })),
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
              //
              // The floor is applied LAST, on purpose. Capping second let a
              // cap of 0 — an Inventory line another register had just sold out
              // — drive the quantity to 0, which read as "not over stock", so
              // the warning cleared, the Pay button came alive, and a
              // zero-quantity line reached the API to be refused there instead.
              // Staying at 1 keeps the line visibly short, which is the truth.
              const cap = stockCap(it.product);
              let q = Math.floor(quantity);
              if (cap != null) q = Math.min(q, cap);
              return { ...it, quantity: Math.max(1, q) };
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
      // Reseeded from the clock rather than EMPTY: a module-level constant would
      // hand back a stale day on a till left open overnight. `today` is advanced
      // in the same breath — seeding the date from a clock the validator has not
      // caught up with yet would mark the fresh cart future-dated until the next
      // rollover tick.
      setShopTimeZone: (tz: string) => setShopTz(safeTimeZone(tz)),
      clearCart: () => {
        const t = todayInTimeZone(shopTz);
        todayRef.current = t;
        setToday(t);
        setState({ ...EMPTY, saleDate: t });
      },
    }),
    [state, hydrated, today, shopTz, updateItem],
  );

  return <PosCartContext.Provider value={value}>{children}</PosCartContext.Provider>;
}

export function usePosCart(): PosCartValue {
  const ctx = React.useContext(PosCartContext);
  if (!ctx) throw new Error('usePosCart must be used within a PosCartProvider');
  return ctx;
}
