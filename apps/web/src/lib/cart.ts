import type { ClientProduct, ClientVariant } from './catalog';
import { round2 } from './utils';
import {
  applyPromotions,
  taxableBase,
  type OrderPromotionResult,
  type PromotionRule,
} from '@hardware-pos/shared';

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
  return priceCart(items, promotionRules).lines;
}

/**
 * D105 — lines AND the cart-level promotion from ONE `applyPromotions` call.
 *
 * `computeTotals` needs both, and the threshold a cart-level promotion is
 * measured against depends on what the line promotions took. Calling the applier
 * twice would evaluate that threshold against a basket priced by a different
 * invocation — the two would agree today and drift the first time anything about
 * ordering changed. One call, both answers.
 */
function priceCart(
  items: CartItem[],
  promotionRules: readonly PromotionRule[],
): { lines: CartLineTotals[]; orderPromotion: OrderPromotionResult | null } {
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

  const lines = base.map(({ item, line }) => {
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

  return { lines, orderPromotion: promo.orderPromotion };
}

/**
 * D102 open decision 3 (PO-confirmed 2026-09-04) — a manual discount that costs
 * the customer MORE than it saves them.
 *
 * A manually discounted line is invisible to promotions (D102): the cashier is
 * acting deliberately, usually under an approval limit, and a promotion stacking
 * on top would push the total past a figure nobody approved. The maths is right.
 * What was missing is that nobody was told: knock Rs 50 off a line carrying a
 * Rs 500 promotion and the customer quietly pays Rs 450 more, with the till
 * showing a discount either way.
 *
 * This reports it. It does not block, and it does not "helpfully" pick the
 * better one — the cashier may have every reason to honour the manual price, and
 * silently overriding them is how a till stops being trustworthy.
 */
export interface ForgonePromotion {
  lineKey: CartLineKey;
  productName: string;
  /** What the cashier took off. */
  manualDiscountAmount: number;
  /** What the line would have received instead, and lost. */
  promotionDiscountAmount: number;
  promotionName: string;
}

/**
 * Lines whose manual discount displaced a LARGER promotion.
 *
 * Works by re-pricing the basket with every manual discount removed and
 * comparing. All of them, not just the line in question: a bundle needs its
 * whole set, so a line can only learn what it gave up in a basket where nothing
 * is suppressed. That also means the figure is "what this basket would have
 * earned", which is the number a cashier can act on.
 *
 * Returns only the cases that cost the customer money — `promotion > manual`.
 * A manual discount that beats the promotion is the cashier being generous and
 * needs no warning.
 */
export function forgonePromotions(
  items: CartItem[],
  promotionRules: readonly PromotionRule[] = [],
): ForgonePromotion[] {
  if (promotionRules.length === 0) return [];

  const discounted = items.filter((i) => computeLine(i).discountAmount > 0);
  if (discounted.length === 0) return [];

  // The same basket with the cashier's hand taken off it.
  const withoutManual = items.map((i) => ({ ...i, discount: undefined }));
  const wouldBe = new Map(
    priceCart(withoutManual, promotionRules).lines.map((l) => [l.lineKey, l]),
  );

  const out: ForgonePromotion[] = [];
  for (const item of discounted) {
    const hypothetical = wouldBe.get(item.lineKey);
    if (!hypothetical || !hypothetical.promotionName) continue;
    const manualDiscountAmount = computeLine(item).discountAmount;
    if (hypothetical.promotionDiscountAmount <= manualDiscountAmount) continue;
    out.push({
      lineKey: item.lineKey,
      productName: item.product.name,
      manualDiscountAmount,
      promotionDiscountAmount: hypothetical.promotionDiscountAmount,
      promotionName: hypothetical.promotionName,
    });
  }
  return out;
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
  /**
   * D105 — a CART-LEVEL promotion (money off the whole order once it reaches a
   * threshold), separate from `totalDiscount` because it never touches a line.
   * 0 when none applies.
   */
  promotionOrderDiscountAmount: number;
  /** The promotion behind that figure, so the till can name it. Null when none. */
  promotionOrderName: string | null;
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
  const { lines, orderPromotion } = priceCart(items, promotionRules);
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
  /*
   * D105 — the cart-level promotion, capped at what is left after the manual
   * order discount so a total can never go negative.
   *
   * It is applied AFTER `taxBase` above and is deliberately absent from it: the
   * PO confirmed tax is computed as it always was and this comes off afterwards.
   * `sales.service` carries the same asymmetry in the same order, which is what
   * keeps the till's preview equal to the server's charge.
   */
  const promotionOrderDiscountAmount = round2(
    Math.min(orderPromotion?.discountAmount ?? 0, Math.max(0, discountedSubtotal - orderDiscountAmount)),
  );

  const netTotal = round2(
    discountedSubtotal - orderDiscountAmount - promotionOrderDiscountAmount,
  );

  return {
    itemCount,
    subtotal,
    totalDiscount,
    orderDiscountAmount,
    promotionOrderDiscountAmount,
    promotionOrderName:
      promotionOrderDiscountAmount > 0 ? (orderPromotion?.promotionName ?? null) : null,
    taxAmount,
    total: round2(netTotal + taxAmount),
    hasStockIssue,
  };
}

/** A product to add to the cart maps 1:1 to a starting cart line. */
export function newCartItem(product: ClientProduct, variant: ClientVariant | null = null): CartItem {
  return { lineKey: cartLineKey(product.id, variant?.id ?? null), product, variant, quantity: 1 };
}
