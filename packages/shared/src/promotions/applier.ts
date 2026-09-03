/**
 * The promotion applier (D102, 4.2) — the one place a promotion becomes money.
 *
 * ## Why this lives in `shared`
 *
 * The till has shown a promotion BADGE since before this phase, and could not
 * price it. If the maths lived only on the server, a customer would read
 * "Buy 2 Get 1", watch the cart total ignore it, and be charged something else
 * at settlement. That is the defect 3.14 fixed for tax, except worse — with tax
 * the customer saw the wrong number after agreeing; with a promotion they read
 * the offer first.
 *
 * So `sales.service` and `lib/cart.computeTotals` both call THIS function. There
 * is nothing for them to drift from.
 *
 * Consequence: `shared` carries no runtime dependencies so a browser can import
 * it, which rules out `Prisma.Decimal`. Plain numbers with cent rounding, the
 * idiom `tax-breakdown.ts` and `returns.calc` already document. The server wraps
 * the result for persistence; both sides run this arithmetic and agree by
 * construction.
 *
 * ## The rule this encodes (D102)
 *
 * A promotion reduces the LINE it applies to, computed once at sale time and
 * frozen. It is never re-derived at return time.
 *
 * Two shirts at 1,000 and a tie at 500, tie free. Allocating that 500 saving
 * order-wide by line value would give the tie a weight of 500 against the
 * shirts' 2,000, so returning the tie would refund 500 − 100 = 400 on an item
 * the customer paid nothing for. Per line, the tie carries the whole 500 and
 * refunds 0.
 */

/** Mirrors `PromotionType` in the Prisma schema. */
export type PromotionKind =
  | 'BUNDLE_FIXED_PRICE'
  | 'BUY_X_GET_Y'
  | 'PERCENTAGE_DISCOUNT'
  | 'FIXED_AMOUNT_DISCOUNT';

/** Mirrors `PromotionItemRole`. */
export type PromotionItemRole = 'BUY' | 'GET' | 'BUNDLE';

/** One cart line offered to the applier. */
export interface PromotionCartLine {
  /**
   * The caller's own key, echoed back on the result. Opaque here: the till keys
   * by `(productId, variantId)` and the server by array position, and neither
   * concept belongs in `shared`.
   */
  id: string;
  productId: string;
  unitPrice: number;
  quantity: number;
  /** `unitPrice × quantity`, already rounded to cents by the caller. */
  lineSubtotal: number;
  /**
   * A manual discount already on this line. Non-zero means the line is INVISIBLE
   * to promotions (D102): a cashier discounting is acting deliberately, usually
   * under an approval limit, and an automatic promotion stacking on top would
   * push the total past a figure nobody approved.
   */
  manualDiscountAmount: number;
}

/** One product's part in a promotion. */
export interface PromotionRuleItem {
  productId: string;
  role: PromotionItemRole;
  /** Units of this product the promotion consumes per application. */
  quantity: number;
}

/**
 * A promotion already established as ELIGIBLE — in its schedule window, in
 * scope for this branch and channel. `isPromotionActive` answers that on the
 * server, once, for both the badge and the charge; this function never asks it.
 */
export interface PromotionRule {
  id: string;
  name: string;
  type: PromotionKind;
  fixedPrice: number | null;
  percentageOff: number | null;
  amountOff: number | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  /**
   * Promotion-to-promotion stacking (4.4). It cannot mean "two promotions on one
   * line" — `SaleItem` holds a single `promotionId`, so that is already
   * impossible. It means basket-level exclusivity: see `applyPromotions`.
   */
  stackable: boolean;
  items: readonly PromotionRuleItem[];
}

export interface PromotionContext {
  lines: readonly PromotionCartLine[];
  promotions: readonly PromotionRule[];
}

/** What one line won, and from which promotion. */
export interface PromotionLineResult {
  lineId: string;
  promotionId: string;
  promotionName: string;
  discountAmount: number;
}

export interface PromotionResult {
  lines: readonly PromotionLineResult[];
  /** Σ of the line discounts. A convenience mirror, never a second source. */
  totalDiscount: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const toCents = (n: number): number => Math.round((n + Number.EPSILON) * 100);

/**
 * Split `total` across `weights` so the parts sum to `total` EXACTLY.
 *
 * Rounding each share independently loses or invents a cent — three lines
 * sharing 10.00 by thirds round to 3.33 each and lose one. Largest remainder
 * hands the leftover cents to the shares with the biggest fractional parts, so
 * the parts always reconcile with the whole.
 *
 * That property is why a bundle can be split at sale time and frozen: a return
 * reverses `promotionDiscountAmount × frac` and never has to re-divide anything.
 *
 * Ties break toward the lower index, so the same basket always produces the same
 * split — a promotion must not price differently on two tills.
 */
export function distributeByLargestRemainder(
  total: number,
  weights: readonly number[],
): number[] {
  const totalCents = toCents(total);
  const weightSum = weights.reduce((acc, w) => acc + w, 0);

  // No weight to divide by, or nothing to divide: everyone gets zero rather
  // than the whole amount landing arbitrarily on the first line.
  if (weightSum <= 0 || totalCents === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const floors = exact.map((e) => Math.floor(e));
  let remainder = totalCents - floors.reduce((acc, f) => acc + f, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => (b.frac === a.frac ? a.i - b.i : b.frac - a.frac));

  const cents = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    cents[i] = (cents[i] ?? 0) + 1;
    remainder -= 1;
  }

  return cents.map((c) => c / 100);
}

/** Lines a promotion names, in cart order. Manually discounted lines are gone. */
function participatingLines(
  lines: readonly PromotionCartLine[],
  rule: PromotionRule,
  role?: PromotionItemRole,
): PromotionCartLine[] {
  const ids = new Set(
    rule.items.filter((it) => role === undefined || it.role === role).map((it) => it.productId),
  );
  return lines.filter((l) => ids.has(l.productId));
}

/** `productId → units required per application`, for one role. */
function requiredByProduct(rule: PromotionRule, role: PromotionItemRole): Map<string, number> {
  const req = new Map<string, number>();
  for (const it of rule.items) {
    if (it.role !== role) continue;
    req.set(it.productId, (req.get(it.productId) ?? 0) + Math.max(1, it.quantity));
  }
  return req;
}

const quantityOf = (lines: readonly PromotionCartLine[], productId: string): number =>
  lines.filter((l) => l.productId === productId).reduce((acc, l) => acc + l.quantity, 0);

type Claim = { lineId: string; discountAmount: number };

/** A straight percentage off every line the promotion names. No distribution. */
function applyPercentage(lines: readonly PromotionCartLine[], rule: PromotionRule): Claim[] {
  const pct = rule.percentageOff ?? 0;
  if (pct <= 0) return [];

  return participatingLines(lines, rule)
    .map((l) => ({
      lineId: l.id,
      // Capped at the line: a promotion may not discount more than the goods cost.
      discountAmount: Math.min(round2((l.lineSubtotal * pct) / 100), l.lineSubtotal),
    }))
    .filter((c) => c.discountAmount > 0);
}

/**
 * One cash amount off, spread across the lines the promotion names.
 *
 * The amount belongs to the promotion, not to any one line, so it is DISTRIBUTED
 * — proportional to gross line value, largest remainder for the cent. Capped at
 * the participating subtotal so "Rs 500 off" on Rs 300 of goods discounts 300,
 * never 500 with 200 of credit invented.
 */
function applyFixedAmount(lines: readonly PromotionCartLine[], rule: PromotionRule): Claim[] {
  const amount = rule.amountOff ?? 0;
  if (amount <= 0) return [];

  const participating = participatingLines(lines, rule);
  if (participating.length === 0) return [];

  const gross = round2(participating.reduce((acc, l) => acc + l.lineSubtotal, 0));
  const capped = Math.min(amount, gross);

  const shares = distributeByLargestRemainder(
    capped,
    participating.map((l) => l.lineSubtotal),
  );

  return participating
    .map((l, i) => ({ lineId: l.id, discountAmount: shares[i] ?? 0 }))
    .filter((c) => c.discountAmount > 0);
}

/**
 * N named products together for a fixed price.
 *
 * Applies as many WHOLE times as the cart can satisfy — six of a three-item
 * bundle is two bundles, not one — and only the units a bundle consumes are
 * discounted. The saving is the difference between what those units would have
 * cost and the bundle price, distributed by largest remainder.
 *
 * A cart may hold one product on several lines (two variants of one shirt), so
 * consumption is filled line by line in cart order and each line is weighted by
 * what it actually contributed.
 */
function applyBundle(lines: readonly PromotionCartLine[], rule: PromotionRule): Claim[] {
  const fixedPrice = rule.fixedPrice ?? 0;
  const required = requiredByProduct(rule, 'BUNDLE');
  if (fixedPrice < 0 || required.size === 0) return [];

  // How many complete bundles the cart can satisfy. One missing product means
  // no bundle at all — a partial bundle is not a discount, it is a basket.
  let times = Infinity;
  for (const [productId, perBundle] of required) {
    times = Math.min(times, Math.floor(quantityOf(lines, productId) / perBundle));
  }
  if (!Number.isFinite(times) || times < 1) return [];

  // Consume line by line, so each line is weighted by what it contributed.
  const consumed: { line: PromotionCartLine; gross: number }[] = [];
  for (const [productId, perBundle] of required) {
    let outstanding = perBundle * times;
    for (const line of lines) {
      if (outstanding <= 0) break;
      if (line.productId !== productId) continue;
      const take = Math.min(line.quantity, outstanding);
      outstanding -= take;
      consumed.push({ line, gross: round2(line.unitPrice * take) });
    }
  }

  const grossConsumed = round2(consumed.reduce((acc, c) => acc + c.gross, 0));
  const saving = round2(grossConsumed - fixedPrice * times);
  // A "bundle" priced above the goods is not a discount. Charge the goods.
  if (saving <= 0) return [];

  const shares = distributeByLargestRemainder(
    saving,
    consumed.map((c) => c.gross),
  );

  // One line can contribute to two products' consumption only in a malformed
  // rule, but merge defensively so a line never appears twice in the result.
  const byLine = new Map<string, number>();
  consumed.forEach((c, i) => {
    byLine.set(c.line.id, round2((byLine.get(c.line.id) ?? 0) + (shares[i] ?? 0)));
  });

  return [...byLine.entries()]
    .map(([lineId, discountAmount]) => ({ lineId, discountAmount }))
    .filter((c) => c.discountAmount > 0);
}

/**
 * Buy X, get Y free.
 *
 * **The freed units are the CHEAPEST qualifying ones.** That is the conventional
 * retail reading of "buy two get one free" and the one a shopkeeper expects; the
 * schema carries no field to configure it, so it is a choice made here and worth
 * confirming with the PO before the pilot.
 *
 * Two shapes, because they count differently:
 *
 *   • **Distinct products** ("buy 2 shirts, get a tie free") — the buy pool and
 *     the reward pool are separate, so applications are `floor(buyQty / X)` and
 *     the freed units come from the GET lines.
 *   • **Same product** ("buy 2 get 1 free" on one shirt) — the free unit comes
 *     out of the SAME pool, so the customer must hold `X + Y` units for one
 *     application. Counting `floor(qty / X)` here would free a unit at two in
 *     the cart, giving away a third the customer never had.
 */
function applyBuyXGetY(lines: readonly PromotionCartLine[], rule: PromotionRule): Claim[] {
  const buyQty = rule.buyQuantity ?? 0;
  const getQty = rule.getQuantity ?? 0;
  if (buyQty <= 0 || getQty <= 0) return [];

  const buyIds = new Set(requiredByProduct(rule, 'BUY').keys());
  const getIds = new Set(requiredByProduct(rule, 'GET').keys());
  if (getIds.size === 0) return [];

  const overlapping = [...getIds].some((id) => buyIds.has(id));

  /** Units eligible to be freed, cheapest first. */
  const rewardUnits: { lineId: string; unitPrice: number }[] = [];
  let freeUnits = 0;

  if (overlapping) {
    // Same pool: one application costs X + Y units of that product.
    const groupSize = buyQty + getQty;
    for (const productId of getIds) {
      const times = Math.floor(quantityOf(lines, productId) / groupSize);
      if (times < 1) continue;
      freeUnits += times * getQty;
      for (const line of lines.filter((l) => l.productId === productId)) {
        for (let u = 0; u < line.quantity; u += 1) {
          rewardUnits.push({ lineId: line.id, unitPrice: line.unitPrice });
        }
      }
    }
  } else {
    const buyPool = [...buyIds].reduce((acc, id) => acc + quantityOf(lines, id), 0);
    const times = Math.floor(buyPool / buyQty);
    if (times < 1) return [];
    for (const line of participatingLines(lines, rule, 'GET')) {
      for (let u = 0; u < line.quantity; u += 1) {
        rewardUnits.push({ lineId: line.id, unitPrice: line.unitPrice });
      }
    }
    // Never free more reward units than the customer actually holds.
    freeUnits = Math.min(times * getQty, rewardUnits.length);
  }

  if (freeUnits < 1 || rewardUnits.length === 0) return [];

  rewardUnits.sort((a, b) => a.unitPrice - b.unitPrice);

  const byLine = new Map<string, number>();
  for (const unit of rewardUnits.slice(0, freeUnits)) {
    byLine.set(unit.lineId, round2((byLine.get(unit.lineId) ?? 0) + unit.unitPrice));
  }

  return [...byLine.entries()]
    .map(([lineId, discountAmount]) => ({ lineId, discountAmount }))
    .filter((c) => c.discountAmount > 0);
}

function claimsFor(lines: readonly PromotionCartLine[], rule: PromotionRule): Claim[] {
  switch (rule.type) {
    case 'PERCENTAGE_DISCOUNT':
      return applyPercentage(lines, rule);
    case 'FIXED_AMOUNT_DISCOUNT':
      return applyFixedAmount(lines, rule);
    case 'BUNDLE_FIXED_PRICE':
      return applyBundle(lines, rule);
    case 'BUY_X_GET_Y':
      return applyBuyXGetY(lines, rule);
    default: {
      // `PromotionKind` is total over the Prisma enum, so a new member is a
      // compile error here rather than a promotion that silently never applies.
      const exhaustive: never = rule.type;
      return exhaustive;
    }
  }
}

/**
 * Apply every eligible promotion to a basket.
 *
 * **One promotion per line**, which is not a policy but a fact: `SaleItem` holds
 * a single `promotionId`, so a line that claimed two could not be persisted or
 * named on a receipt.
 *
 * Promotions are therefore offered in a deterministic order — largest total
 * saving first, ties broken by id — and each is **all-or-nothing**: if any line
 * it needs is already claimed, it is skipped whole. Taking it partially would
 * apply half a bundle, which is not a smaller discount but a wrong one.
 *
 * Largest-first is the customer-favourable reading, and deterministic ordering
 * means two tills with the same basket produce the same bill.
 *
 * **`stackable` is basket-level exclusivity** (4.4, PO-confirmed). It cannot mean
 * "two promotions on one line" — the single `promotionId` already forbids that.
 * So:
 *
 *   • the best candidate always applies;
 *   • if it is NOT stackable it locks the basket and nothing else applies;
 *   • if it is stackable, further STACKABLE non-overlapping candidates apply in
 *     turn, and non-stackable ones are skipped once anything has applied.
 *
 * Read against the deterministic order above, so "the best one wins, and what it
 * permits alongside it" is the same answer on every till.
 */
export function applyPromotions(context: PromotionContext): PromotionResult {
  // A manually discounted line is invisible to promotions, so it cannot even
  // complete a bundle. Filtering here rather than at each rule keeps "manual
  // wins" stated once.
  const eligibleLines = context.lines.filter((l) => l.manualDiscountAmount <= 0);

  const candidates = context.promotions
    .map((rule) => {
      const claims = claimsFor(eligibleLines, rule);
      return {
        rule,
        claims,
        total: round2(claims.reduce((acc, c) => acc + c.discountAmount, 0)),
      };
    })
    .filter((c) => c.claims.length > 0 && c.total > 0)
    .sort((a, b) => (b.total === a.total ? a.rule.id.localeCompare(b.rule.id) : b.total - a.total));

  const claimedLines = new Set<string>();
  const results: PromotionLineResult[] = [];
  let anyApplied = false;
  let basketLocked = false;

  for (const candidate of candidates) {
    // A non-stackable promotion took the basket; nothing may join it.
    if (basketLocked) break;
    // …and a non-stackable one may not join something already applied.
    if (anyApplied && !candidate.rule.stackable) continue;
    if (candidate.claims.some((c) => claimedLines.has(c.lineId))) continue;
    anyApplied = true;
    // Applied first and not stackable: it takes the whole basket.
    if (!candidate.rule.stackable) basketLocked = true;
    for (const claim of candidate.claims) {
      claimedLines.add(claim.lineId);
      results.push({
        lineId: claim.lineId,
        promotionId: candidate.rule.id,
        promotionName: candidate.rule.name,
        discountAmount: claim.discountAmount,
      });
    }
  }

  return {
    lines: results,
    totalDiscount: round2(results.reduce((acc, r) => acc + r.discountAmount, 0)),
  };
}
