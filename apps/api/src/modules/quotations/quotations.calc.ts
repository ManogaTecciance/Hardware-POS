import { OrderChannel } from '@hardware-pos/database';

import {
  RETAIL_CHARGE_CONFIG,
  computeDocumentLine,
  computeDocumentTotals,
} from '../../common/money/document-totals';
import { round2 } from '../../common/money';

/**
 * Pure quotation money maths. Mirrors the Sale pricing pipeline so a quotation
 * converts to a sale with identical numbers:
 *
 *   lineSubtotal        = unitPrice × quantity
 *   discountAmount      = per-line discount (% of lineSubtotal, a fixed amount off
 *                         the line, or a fixed amount off every unit)
 *   lineTotal           = lineSubtotal − discountAmount           (pre order-discount, pre-tax)
 *   subtotal            = Σ lineSubtotal
 *   productDiscountTotal= Σ discountAmount
 *   discountedSubtotal  = subtotal − productDiscountTotal
 *   quotationDiscount   = order-level discount on discountedSubtotal
 *   taxable             = discountedSubtotal − quotationDiscountAmount
 *   taxAmount           = taxable × taxRatePercent / 100
 *   grandTotal          = taxable + taxAmount
 *
 * All figures are rounded to cents with round2 — never trust client totals; the
 * server always recomputes with this module.
 */

export type DiscountTypeCode = 'PERCENTAGE' | 'FIXED';

/**
 * What a FIXED amount is measured against. String literals rather than the
 * Prisma enum, so this module stays free of Prisma and unit-testable — the same
 * reason DiscountTypeCode is declared here.
 */
export type DiscountBasisCode = 'LINE' | 'UNIT';

export interface QuotationLineInput {
  unitPrice: number;
  quantity: number;
  discountType?: DiscountTypeCode | null;
  discountValue?: number | null;
  /** Absent reads as LINE — what every quotation before this meant. */
  discountBasis?: DiscountBasisCode | null;
}

export interface ComputedQuotationLine {
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  discountType: DiscountTypeCode | null;
  discountValue: number | null;
  discountBasis: DiscountBasisCode;
  discountAmount: number;
  lineTotal: number;
  /** Per-line share of the order tax, allocated by lineTotal (display column). */
  taxAmount: number;
}

export interface QuotationDiscountInput {
  type?: DiscountTypeCode | null;
  value?: number | null;
}

export interface QuotationTotals {
  lines: ComputedQuotationLine[];
  subtotal: number;
  productDiscountTotal: number;
  quotationDiscountType: DiscountTypeCode | null;
  quotationDiscountValue: number | null;
  quotationDiscountAmount: number;
  taxAmount: number;
  grandTotal: number;
}

export function computeQuotationLine(input: QuotationLineInput): ComputedQuotationLine {
  // D59: delegated to the one document-totals engine (Prisma.Decimal). The
  // number boundary is exact: every engine output is a 2dp figure. The UNIT
  // basis (main, 2026-09-07) rides through the same engine, so a per-unit
  // quotation converts to a sale on the same cent.
  const basis = input.discountBasis ?? 'LINE';
  const line = computeDocumentLine({
    unitPrice: round2(input.unitPrice),
    quantity: input.quantity,
    discountType: input.discountType ?? null,
    discountValue: input.discountValue ?? null,
    discountBasis: basis,
  });
  return {
    unitPrice: line.unitPrice.toNumber(),
    quantity: input.quantity,
    lineSubtotal: line.lineSubtotal.toNumber(),
    discountType: line.discountType,
    discountValue: input.discountValue ?? null,
    discountBasis: basis,
    discountAmount: line.discountAmount.toNumber(),
    lineTotal: line.lineTotal.toNumber(),
    taxAmount: 0,
  };
}

export function computeQuotationTotals(
  lineInputs: QuotationLineInput[],
  orderDiscount: QuotationDiscountInput | null | undefined,
  taxRatePercent: number,
): QuotationTotals {
  // D59: the whole pipeline runs in the shared Decimal engine; a quotation is
  // an immediate-fulfilment document with zero service/packaging charges.
  const totals = computeDocumentTotals(
    lineInputs.map((l) => ({
      unitPrice: round2(l.unitPrice),
      quantity: l.quantity,
      discountType: l.discountType ?? null,
      discountValue: l.discountValue ?? null,
      discountBasis: l.discountBasis ?? 'LINE',
    })),
    OrderChannel.COUNTER,
    { ...RETAIL_CHARGE_CONFIG, taxRatePercent },
    { type: orderDiscount?.type ?? null, value: orderDiscount?.value ?? null },
  );

  const lines: ComputedQuotationLine[] = totals.lines.map((line, i) => ({
    unitPrice: line.unitPrice.toNumber(),
    quantity: lineInputs[i].quantity,
    lineSubtotal: line.lineSubtotal.toNumber(),
    discountType: line.discountType,
    // Positional: the engine keeps line order, and the basis is an input
    // property the engine echoes rather than derives.
    discountBasis: lineInputs[i].discountBasis ?? 'LINE',
    discountValue: lineInputs[i].discountValue ?? null,
    discountAmount: line.discountAmount.toNumber(),
    lineTotal: line.lineTotal.toNumber(),
    taxAmount: 0,
  }));

  const subtotal = totals.subtotal.toNumber();
  const productDiscountTotal = totals.totalLineDiscount.toNumber();
  const discountedSubtotal = round2(subtotal - productDiscountTotal);
  const qType = orderDiscount?.type ?? null;
  const qValue = orderDiscount?.value ?? null;
  // No quantity: a whole-quotation discount has no units to be "per".
  const quotationDiscountAmount = totals.orderDiscountAmount.toNumber();
  const taxAmount = totals.taxAmount.toNumber();
  const grandTotal = totals.total.toNumber();

  // Spread the order-level tax across lines proportionally to lineTotal so the
  // per-line tax column sums back to taxAmount exactly (remainder to the last line).
  if (taxAmount > 0 && discountedSubtotal > 0) {
    let allocated = 0;
    const lastIndex = lines.length - 1;
    lines.forEach((line, index) => {
      if (index === lastIndex) {
        line.taxAmount = round2(taxAmount - allocated);
      } else {
        const share = round2(taxAmount * (line.lineTotal / discountedSubtotal));
        line.taxAmount = share;
        allocated = round2(allocated + share);
      }
    });
  }

  return {
    lines,
    subtotal,
    productDiscountTotal,
    quotationDiscountType: qType,
    quotationDiscountValue: qValue,
    quotationDiscountAmount,
    taxAmount,
    grandTotal,
  };
}
