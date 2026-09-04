import type { ClientProduct, ClientVariant } from './catalog';
import { round2 } from './utils';
import { applyPromotions, taxableBase, type PromotionRule } from '@hardware-pos/shared';

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
  /**
   * D45 (4.11) — set when the TILL added this line to claim a promotion the
   * basket had earned, rather than the cashier scanning it.
   *
   * Drives the "Promo item" badge, and stops the line being re-added the moment
   * a cashier deliberately removes it. It is a UI fact only: the server prices
   * the line from the promotion rules like any other, and never sees this flag.
   */
  addedByPromotionId?: string;
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

/**
 * One cart line as a single human string — "Cotton Shirt, Black / Medium".
 *
 * For assistive text and anywhere a line needs to be named in one piece. The
 * visible UI shows the same two facts stacked (name above, size below); this is
 * the flattened form, kept here so the two can never describe a line differently.
 *
 * D99 (1c.8) — the payment screen announced "Increase Cotton Shirt quantity" for
 * two adjacent buttons, giving a screen-reader user no way to tell which size
 * they were changing.
 */
export function lineLabel(item: CartItem): string {
  return item.variant ? `${item.product.name}, ${item.variant.name}` : item.product.name;
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

/** One cart line, priced — including whatever promotion claimed it. */
export interface CartLineTotals extends LineTotals {
  lineKey: string;
  /** D102 (4.4) — already subtracted from `lineTotal`. Kept for display. */
  promotionDiscountAmount: number;
  promotionId: string | null;
  promotionName: string | null;
}

/**
 * D102 (4.4) — the ONE place a cart line's money is derived.
 *
 * A promotion cannot be computed per line: a bundle spans lines and a BOGO counts
 * across them, so it needs the whole basket. That makes `computeLine` alone
 * insufficient the moment promotions exist — and `computeLine` was being called
 * independently in three render paths (the cart list, the payment table, the
 * fallback receipt). Left as they were, each would have shown a PRE-promotion
 * line total under a post-promotion footer, and the cart would visibly not add
 * up. That is the same shape as the four sale-line renderers 2.12 found.
 *
 * So every renderer reads this instead. The one caller that deliberately still
 * uses `computeLine` is the discount-limit check, which asks "how big is this
 * MANUAL discount?" — a question a promotion must not answer.
 *
 * `promotionRules` defaults to empty, so a caller without them prices exactly as
 * before rather than throwing.
 */
export function computeCartLines(
  items: CartItem[],
  promotionRules: readonly PromotionRule[] = [],
): CartLineTotals[] {
  const base = items.map((item) => ({ item, line: computeLine(item) }));

  const promo = applyPromotions({
    lines: base.map(({ item, line }) => ({
      id: item.lineKey,
      productId: item.product.id,
      unitPrice: linePrice(item),
      quantity: item.quantity,
      lineSubtotal: line.lineSubtotal,
      // Precedence lives in the applier: a manually discounted line is invisible
      // to promotions, so it cannot even complete a bundle (D102).
      manualDiscountAmount: line.discountAmount,
    })),
    promotions: [...promotionRules],
  });

  const claimed = new Map(promo.lines.map((l) => [l.lineId, l]));

  return base.map(({ item, line }) => {
    const won = claimed.get(item.lineKey);
    const promotionDiscountAmount = won?.discountAmount ?? 0;
    return {
      ...line,
      lineKey: item.lineKey,
      promotionDiscountAmount,
      promotionId: won?.promotionId ?? null,
      promotionName: won?.promotionName ?? null,
      // The promotion reduces the LINE. Everything downstream — the order
      // discount's base, and `taxableBase` — reads `lineTotal`, so tax follows
      // with no tax code at all (D102).
      lineTotal: round2(line.lineTotal - promotionDiscountAmount),
    };
  });
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
  promotionRules: readonly PromotionRule[] = [],
): CartTotals {
  // D102 (4.4) — one derivation, shared with every renderer. Computing lines
  // here independently is how the footer and the list come to disagree.
  const lines = computeCartLines(items, promotionRules);
  let subtotal = 0;
  let totalDiscount = 0;
  let itemCount = 0;
  let hasStockIssue = false;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const line = lines[i]!;
    subtotal += line.lineSubtotal;
    /*
     * D102 (4.4) — `totalDiscount` is every LINE-level reduction, manual and
     * promotional. It has to be: `discountedSubtotal` is derived from it, and
     * `discountedSubtotal` must equal Σ lineTotal or the order discount is
     * computed on money the customer never owed and the tax base drifts with it.
     *
     * The two are mutually exclusive per line (manual overrides promotion), so
     * this sum never double-counts.
     */
    totalDiscount += line.discountAmount + line.promotionDiscountAmount;
    itemCount += item.quantity;
    if (line.outOfStock) hasStockIssue = true;
  }

  subtotal = round2(subtotal);
  totalDiscount = round2(totalDiscount);
  const discountedSubtotal = round2(subtotal - totalDiscount);
  const orderDiscountAmount = computeDiscount(discountedSubtotal, orderDiscount);
  /*
   * D101 (3.14) — the SHARED base rule, so the till previews exactly what the
   * server will charge.
   *
   * 3.10 narrowed the base on the server and left this alone, so a cashier was
   * quoted 18% on an exempt item the server then charged nothing for — the
   * retail twin of audit item A2, "its cashier quotes a total the server
   * disagrees with". `sales.service` now calls the same function.
   */
  const taxBase = taxableBase(
    lines.map((l, i) => ({ lineTotal: l.lineTotal, taxable: items[i]!.product.taxable })),
    discountedSubtotal,
    orderDiscountAmount,
  );
  const taxAmount = taxRatePercent > 0 ? round2((taxBase * taxRatePercent) / 100) : 0;
  /*
   * The NET the customer owes, which is NOT the taxable base: an exempt line is
   * untaxed, not unsold. Before 3.14 one variable served both, and narrowing it
   * silently dropped exempt goods out of the total — the first version of this
   * change returned `total: 0` for a 2,100 exempt sale. `sales.service` carries
   * the same distinction, in the same words.
   */
  const netTotal = round2(discountedSubtotal - orderDiscountAmount);

  return {
    itemCount,
    subtotal,
    totalDiscount,
    orderDiscountAmount,
    taxAmount,
    total: round2(netTotal + taxAmount),
    hasStockIssue,
  };
}

/** A product to add to the cart maps 1:1 to a starting cart line. */
export function newCartItem(product: ClientProduct, variant: ClientVariant | null = null): CartItem {
  return { lineKey: cartLineKey(product.id, variant?.id ?? null), product, variant, quantity: 1 };
}
