import type { ClientProduct, ClientVariant } from './catalog';
import { round2 } from './utils';

export type DiscountType = 'PERCENTAGE' | 'FIXED';

export interface LineDiscount {
  type: DiscountType;
  value: number;
  reason?: string;
}

/**
 * D99 — the identity of one cart line.
 *
 * Branded rather than a bare `string` so the compiler refuses a raw `product.id`
 * where a line key is expected. Every cart operation used to take a product id,
 * and the two are indistinguishable to TypeScript without this — which would make
 * "did I update all twelve call sites" a review question instead of a compile
 * error.
 */
export type CartLineKey = string & { readonly __brand: 'CartLineKey' };

/**
 * A line is identified by its product AND the variant chosen, so a Medium and a
 * Large of one shirt are two lines rather than one with quantity 2.
 *
 * A variant-less line keys on the product id alone, unchanged from before
 * variants existed. That is what lets a single-SKU product — grocery loose goods,
 * a service — behave exactly as it always has, and what lets a cart persisted
 * before this change still hydrate (see `pos-cart.tsx`).
 *
 * The variant half is always present, empty when there is none, so the two halves
 * are unambiguous whatever an id contains. Keying a variant-less line on the bare
 * product id instead would collide with a product whose own id happened to hold
 * the delimiter — unlikely with cuids, but the format should not depend on that.
 */
export function cartLineKey(productId: string, variantId: string | null): CartLineKey {
  return `${productId}::${variantId ?? ''}` as CartLineKey;
}

export interface CartItem {
  /** Stable identity of this line. Stored, not derived — see {@link cartLineKey}. */
  lineKey: CartLineKey;
  product: ClientProduct;
  /** D99 — the size/pack chosen, or null for a product sold without variants. */
  variant: ClientVariant | null;
  quantity: number;
  note?: string;
  discount?: LineDiscount;
  /** Manager approval token for an over-limit discount (from /discounts/approve). */
  approvalToken?: string;
  /** The manager who approved the discount. */
  approvedByUserId?: string;
}

export interface LineTotals {
  lineSubtotal: number;
  discountAmount: number;
  lineTotal: number;
  outOfStock: boolean;
}

export function computeDiscount(lineSubtotal: number, discount?: LineDiscount): number {
  if (!discount || discount.value <= 0) return 0;
  if (discount.type === 'PERCENTAGE') {
    return Math.min(lineSubtotal, round2((lineSubtotal * discount.value) / 100));
  }
  return Math.min(lineSubtotal, round2(discount.value));
}

/**
 * The price actually charged for a cart line.
 *
 * D99 — `ClientProduct.unitPrice` is **null when variants own the price**, which
 * the read model states explicitly rather than repeating a number that means
 * nothing for a variant product. Until the cart carries a chosen variant (1c.2),
 * a variant product has no line price and falls to 0 rather than to a wrong
 * number: a visibly free line is a bug someone reports, a plausible-but-wrong
 * price is one that ships.
 */
export function linePrice(item: CartItem): number {
  // A variant owns its price outright — the same rule the server applies
  // (D99): `ClientProduct.unitPrice` is null for a variant product precisely
  // because the number lives on the variant.
  return item.variant ? item.variant.unitPrice : (item.product.unitPrice ?? 0);
}

export function computeLine(item: CartItem): LineTotals {
  const lineSubtotal = round2(linePrice(item) * item.quantity);
  const discountAmount = computeDiscount(lineSubtotal, item.discount);
  return {
    lineSubtotal,
    discountAmount,
    lineTotal: round2(lineSubtotal - discountAmount),
    // D99 — a variant line is short against ITS OWN row, not the product total.
    // Comparing against the product would let 10 Mediums look fine because the
    // Larges make up the number, and the server would then refuse the sale.
    outOfStock: item.variant
      ? item.variant.stockState !== 'UNTRACKED' &&
        item.quantity > (item.variant.quantityOnHand ?? 0)
      : item.quantity > item.product.quantityOnHand,
  };
}

/** Whole-cart discount, applied after per-line (product) discounts. */
export interface OrderDiscount {
  type: DiscountType;
  value: number;
  reason?: string;
}

export interface CartTotals {
  itemCount: number;
  subtotal: number;
  /** Sum of per-line (product) discounts. */
  totalDiscount: number;
  orderDiscountAmount: number;
  taxAmount: number;
  total: number;
  hasStockIssue: boolean;
}

export function computeTotals(
  items: CartItem[],
  taxRatePercent: number,
  orderDiscount?: OrderDiscount,
): CartTotals {
  let subtotal = 0;
  let totalDiscount = 0;
  let itemCount = 0;
  let hasStockIssue = false;

  for (const item of items) {
    const line = computeLine(item);
    subtotal += line.lineSubtotal;
    totalDiscount += line.discountAmount;
    itemCount += item.quantity;
    if (line.outOfStock) hasStockIssue = true;
  }

  subtotal = round2(subtotal);
  totalDiscount = round2(totalDiscount);
  const discountedSubtotal = round2(subtotal - totalDiscount);
  const orderDiscountAmount = computeDiscount(discountedSubtotal, orderDiscount);
  const taxable = round2(discountedSubtotal - orderDiscountAmount);
  const taxAmount = taxRatePercent > 0 ? round2((taxable * taxRatePercent) / 100) : 0;

  return {
    itemCount,
    subtotal,
    totalDiscount,
    orderDiscountAmount,
    taxAmount,
    total: round2(taxable + taxAmount),
    hasStockIssue,
  };
}

/** A product to add to the cart maps 1:1 to a starting cart line. */
export function newCartItem(product: ClientProduct, variant: ClientVariant | null = null): CartItem {
  return { lineKey: cartLineKey(product.id, variant?.id ?? null), product, variant, quantity: 1 };
}
