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
  lineSubtotal: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  modifiers: {
    modifierOptionId: string | null;
    optionName: string;
    groupName: string;
    priceDelta: Prisma.Decimal;
  }[];
}

export function projectOrderItems(items: readonly ProjectableOrderItem[]): ProjectedSaleItem[] {
  return items.map((item) => {
    const lineTotal = item.unitPrice.plus(item.modifierTotal).mul(item.quantity);
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
      // Restaurant lines carry no line-level discount today (D52's deferral),
      // so subtotal and total coincide. When promotions reach the bill they
      // land here, in one place.
      lineSubtotal: lineTotal,
      lineTotal,
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
 */
export function assertProjectionMatchesSubtotal(
  projected: readonly ProjectedSaleItem[],
  subtotal: Prisma.Decimal,
): void {
  const sum = projected.reduce((acc, line) => acc.plus(line.lineTotal), new Prisma.Decimal(0));
  if (!sum.equals(subtotal)) {
    throw new Error(
      `D58 settlement projection mismatch: Σ lineTotal ${sum.toFixed(2)} != subtotal ${subtotal.toFixed(2)}. ` +
        'Refusing to close — the settled document would disagree with the bill.',
    );
  }
}
