import type { ClientProduct } from './catalog';
import { round2 } from './utils';

export type DiscountType = 'PERCENTAGE' | 'FIXED';

export interface LineDiscount {
  type: DiscountType;
  value: number;
  reason?: string;
}

export interface CartItem {
  product: ClientProduct;
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
 * Maximum sellable quantity for a product: its on-hand stock for Inventory
 * items, or null (no cap) for Service / Non-Inventory items, which aren't
 * stock-tracked and can always be sold.
 *
 * Lives here, in the module that computes the line, so the cart cannot answer
 * "what is this product's cap" one way for the quantity stepper and another way
 * for the out-of-stock warning — which is exactly what it used to do.
 */
export function stockCap(product: ClientProduct): number | null {
  return product.type === 'Inventory' ? product.quantityOnHand : null;
}

export function computeLine(item: CartItem): LineTotals {
  const lineSubtotal = round2(item.product.unitPrice * item.quantity);
  const discountAmount = computeDiscount(lineSubtotal, item.discount);
  const cap = stockCap(item.product);
  return {
    lineSubtotal,
    discountAmount,
    lineTotal: round2(lineSubtotal - discountAmount),
    // No cap means the product is not stock-tracked, so it can never be short.
    // QuickBooks stores 0 on Service and Non-Inventory items as a placeholder,
    // not as an observation, and reading it as "sold out" made all 29 of them
    // unsellable: the warning fired, and with it the Pay button's gate.
    outOfStock: cap != null && item.quantity > cap,
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
export function newCartItem(product: ClientProduct): CartItem {
  return { product, quantity: 1 };
}
