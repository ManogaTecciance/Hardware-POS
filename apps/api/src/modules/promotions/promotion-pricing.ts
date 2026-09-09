import { Prisma } from '@hardware-pos/database';
import {
  applyPromotions,
  type PromotionCartLine,
  type PromotionRule,
} from '@hardware-pos/shared';

import { isPromotionActive } from './promotions.evaluator';
import type { PromotionWithItems } from './promotions.repository';

/**
 * The one place a stored promotion becomes a priced discount.
 *
 * Two settlement families now charge promotions — the retail sale
 * (`sales.service`) and the restaurant bill (dine-in close, takeaway settle,
 * and both of their previews). Each was going to need the same three steps:
 * filter by schedule/scope, cross the Decimal → number boundary, run the
 * shared applier. Written once here so a fix to any of them is a fix to all,
 * and so a bill and its preview cannot disagree about a discount.
 *
 * `shared` carries no runtime dependency on Prisma, so the applier works in
 * plain numbers with cent rounding; `catalog.ts` performs the mirror-image
 * conversion from the wire strings on the till. This module owns the server
 * half of that boundary.
 */

/**
 * D123 (4.4) — the Decimal → number boundary for promotions, in one place.
 */
export function toPromotionRule(p: PromotionWithItems): PromotionRule {
  return {
    id: p.id,
    name: p.name,
    type: p.type as PromotionRule['type'],
    fixedPrice: p.fixedPrice === null ? null : Number(p.fixedPrice),
    percentageOff: p.percentageOff === null ? null : Number(p.percentageOff),
    amountOff: p.amountOff === null ? null : Number(p.amountOff),
    // D126 — the cart threshold. Null on every rule written before D126, which
    // the applier reads as "no threshold".
    minimumSpend: p.minimumSpend === null ? null : Number(p.minimumSpend),
    buyQuantity: p.buyQuantity,
    getQuantity: p.getQuantity,
    stackable: p.stackable,
    items: p.items.map((it) => ({
      productId: it.productId,
      role: it.role as PromotionRule['items'][number]['role'],
      quantity: it.quantity,
    })),
  };
}

/**
 * The promotions live for this branch and channel, in applier shape.
 *
 * The channel matters and is never assumed: the evaluator refuses a
 * channel-scoped promotion when the context names no channel, so a caller that
 * forgot to pass one would silently price nothing. Restaurant callers pass
 * their `RestaurantOrderChannel`, retail passes `COUNTER`.
 */
export function eligiblePromotionRules(
  promotions: readonly PromotionWithItems[],
  context: { now: Date; branchId: string; channel: string; tenantTimeZone?: string },
): PromotionRule[] {
  return promotions.filter((p) => isPromotionActive(p, context)).map(toPromotionRule);
}

/** One document line offered for pricing, in the money type the server holds. */
export interface PricingLine {
  /** Caller's key, echoed back. */
  id: string;
  /**
   * Null for a line no promotion can name — a legacy MENU_ITEM round item that
   * was never a Product. Such a line is passed through untouched rather than
   * dropped, so the caller's array positions still line up.
   */
  productId: string | null;
  unitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  /** Non-zero makes the line invisible to promotions (D123). Default 0. */
  manualDiscountAmount?: Prisma.Decimal;
  /** D134a — sold by weight/measure; invisible to the quantity-based kinds. */
  isMeasured?: boolean;
}

/** What one line won. Zeroed for a line no promotion claimed. */
export interface PricedLine {
  id: string;
  promotionDiscountAmount: Prisma.Decimal;
  promotionId: string | null;
  promotionNameSnapshot: string | null;
}

export interface PricedDocument {
  lines: PricedLine[];
  /** Σ of the line discounts. Never includes the order-level one (D126). */
  totalLineDiscount: Prisma.Decimal;
  /** D126 — the single cart-level promotion, or nulls when none applied. */
  orderDiscountAmount: Prisma.Decimal;
  orderPromotionId: string | null;
  orderPromotionNameSnapshot: string | null;
}

const ZERO = new Prisma.Decimal(0);

/** Every line unclaimed — the answer when a document has no live promotion. */
export function noPromotions(lines: readonly { id: string }[]): PricedDocument {
  return {
    lines: lines.map((l) => ({
      id: l.id,
      promotionDiscountAmount: ZERO,
      promotionId: null,
      promotionNameSnapshot: null,
    })),
    totalLineDiscount: ZERO,
    orderDiscountAmount: ZERO,
    orderPromotionId: null,
    orderPromotionNameSnapshot: null,
  };
}

/**
 * Price a document's lines against a set of already-eligible rules.
 *
 * Returns one entry per input line, in input order, so a caller can zip the
 * result back onto its own rows without matching on anything.
 */
export function priceLines(
  lines: readonly PricingLine[],
  rules: readonly PromotionRule[],
): PricedDocument {
  if (rules.length === 0) return noPromotions(lines);

  const cartLines: PromotionCartLine[] = lines
    // A line with no productId can never be named by a rule. Filtered out
    // rather than passed with a sentinel id: a fake productId could collide
    // with a real one and hand a discount to the wrong row.
    .filter((l): l is PricingLine & { productId: string } => l.productId !== null)
    .map((l) => ({
      id: l.id,
      productId: l.productId,
      unitPrice: l.unitPrice.toNumber(),
      quantity: l.quantity.toNumber(),
      lineSubtotal: l.lineSubtotal.toNumber(),
      manualDiscountAmount: (l.manualDiscountAmount ?? ZERO).toNumber(),
      isMeasured: l.isMeasured ?? false,
    }));

  const result = applyPromotions({ lines: cartLines, promotions: [...rules] });
  const wonById = new Map(result.lines.map((l) => [l.lineId, l]));

  return {
    lines: lines.map((l) => {
      const won = wonById.get(l.id);
      return {
        id: l.id,
        promotionDiscountAmount: won ? new Prisma.Decimal(won.discountAmount) : ZERO,
        promotionId: won?.promotionId ?? null,
        promotionNameSnapshot: won?.promotionName ?? null,
      };
    }),
    totalLineDiscount: new Prisma.Decimal(result.totalDiscount),
    orderDiscountAmount: new Prisma.Decimal(result.orderPromotion?.discountAmount ?? 0),
    orderPromotionId: result.orderPromotion?.promotionId ?? null,
    orderPromotionNameSnapshot: result.orderPromotion?.promotionName ?? null,
  };
}
