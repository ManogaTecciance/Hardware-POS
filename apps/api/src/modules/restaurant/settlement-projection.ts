import { Prisma, SaleItemSourceKind } from '@hardware-pos/database';

/**
 * D58 — project restaurant order items into settlement lines.
 *
 * A field-for-field COPY of the snapshots frozen at submit time — name, unit
 * price, modifier deltas, variant snapshots — never a recomputation. The one
 * derived value is `lineTotal = (unitPrice + modifierTotal) × quantity`,
 * which is exactly the formula both close paths already use to build the
 * bill's subtotal, so `assertProjectionMatchesSubtotal` below is an identity
 * check on the document, not a second pricing opinion.
 *
 * Pure and transaction-free on purpose: the same mapping serves the live
 * close (inside its transaction) and the historical backfill script, so the
 * two can never diverge.
 */

/** The slice of RestaurantOrderItem (+ modifiers) the projection reads. */
export interface ProjectableOrderItem {
  id: string;
  menuItemName: string;
  unitPrice: Prisma.Decimal;
  modifierTotal: Prisma.Decimal;
  quantity: Prisma.Decimal;
  specialInstructions: string | null;
  productId: string | null;
  productVariantId: string | null;
  variantNameSnapshot: string | null;
  modifiers?: readonly {
    modifierOptionId: string;
    optionName: string;
    groupName: string;
    priceDelta: Prisma.Decimal;
  }[];
}

/** What the promotion pass awarded one order item, keyed by its id. */
export interface ProjectedPromotion {
  promotionDiscountAmount: Prisma.Decimal;
  promotionId: string | null;
  promotionNameSnapshot: string | null;
}

export interface ProjectedSaleItem {
  productId: string | null;
  productVariantId: string | null;
  productName: string;
  variantNameSnapshot: string | null;
  unitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  modifierTotal: Prisma.Decimal;
  notes: string | null;
  sourceKind: SaleItemSourceKind;
  sourceItemId: string;
  promotionDiscountAmount: Prisma.Decimal;
  promotionId: string | null;
  promotionNameSnapshot: string | null;
  lineSubtotal: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  modifiers: {
    modifierOptionId: string | null;
    optionName: string;
    groupName: string;
    priceDelta: Prisma.Decimal;
  }[];
}

export function projectOrderItems(
  items: readonly ProjectableOrderItem[],
  /**
   * Line-level promotion awards, by order-item id. Omitted (or missing an
   * entry) means the line won nothing, which is every line on a bill with no
   * live promotion — the D52-era behaviour, unchanged.
   */
  promotionByItemId?: ReadonlyMap<string, ProjectedPromotion>,
): ProjectedSaleItem[] {
  return items.map((item) => {
    const lineSubtotal = item.unitPrice.plus(item.modifierTotal).mul(item.quantity);
    const promotion = promotionByItemId?.get(item.id);
    const promotionDiscountAmount = promotion?.promotionDiscountAmount ?? new Prisma.Decimal(0);
    return {
      productId: item.productId,
      productVariantId: item.productVariantId,
      productName: item.menuItemName,
      variantNameSnapshot: item.variantNameSnapshot,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      modifierTotal: item.modifierTotal,
      notes: item.specialInstructions,
      sourceKind: SaleItemSourceKind.RESTAURANT_ORDER_ITEM,
      sourceItemId: item.id,
      promotionDiscountAmount,
      promotionId: promotion?.promotionId ?? null,
      promotionNameSnapshot: promotion?.promotionNameSnapshot ?? null,
      /*
       * `lineTotal` is net of the promotion, and that is deliberate: it is what
       * tax and the returns calculation read on a retail line, so a restaurant
       * line must mean the same thing or a refund would reverse money the guest
       * never paid. `promotionDiscountAmount` beside it is the mirror D123
       * describes, never a second authority.
       */
      lineSubtotal,
      lineTotal: lineSubtotal.minus(promotionDiscountAmount),
      modifiers: (item.modifiers ?? []).map((m) => ({
        modifierOptionId: m.modifierOptionId,
        optionName: m.optionName,
        groupName: m.groupName,
        priceDelta: m.priceDelta,
      })),
    };
  });
}

/**
 * The D58 invariant: the projected lines must sum to the subtotal the
 * customer is being billed. A close that fails this aborts rather than
 * persisting a document that disagrees with itself.
 *
 * Stated against `lineSubtotal` rather than `lineTotal` now that a promotion
 * can sit between them — `subtotal` is the goods before any discount on both
 * sides of the comparison, so the identity check is unchanged for a bill with
 * no promotion. The discount is checked as its own identity beside it: the
 * figure the totals were computed from must be the figure the lines carry, or
 * the bill's footer and its lines would tell the guest two different stories.
 */
export function assertProjectionMatchesSubtotal(
  projected: readonly ProjectedSaleItem[],
  subtotal: Prisma.Decimal,
  promotionLineDiscount: Prisma.Decimal = new Prisma.Decimal(0),
): void {
  const sum = projected.reduce((acc, line) => acc.plus(line.lineSubtotal), new Prisma.Decimal(0));
  if (!sum.equals(subtotal)) {
    throw new Error(
      `D58 settlement projection mismatch: Σ lineSubtotal ${sum.toFixed(2)} != subtotal ${subtotal.toFixed(2)}. ` +
        'Refusing to close — the settled document would disagree with the bill.',
    );
  }
  const promotionSum = projected.reduce(
    (acc, line) => acc.plus(line.promotionDiscountAmount),
    new Prisma.Decimal(0),
  );
  if (!promotionSum.equals(promotionLineDiscount)) {
    throw new Error(
      `D58 settlement projection mismatch: Σ promotionDiscountAmount ${promotionSum.toFixed(2)} != ` +
        `bill promotion discount ${promotionLineDiscount.toFixed(2)}. ` +
        'Refusing to close — the settled document would disagree with the bill.',
    );
  }
}
