import { OrderChannel, Prisma } from '@hardware-pos/database';

/**
 * D59 — ONE money engine for every settlement document (convergence plan
 * Phase 2, §8.7).
 *
 * Before this existed there were three calculators: the retail sale and the
 * quotation computed money in binary floating point with `round2()` at each
 * step, and the restaurant bill used `Prisma.Decimal` (D52). They agreed for
 * the tenants in play; that was luck. This module is the superset pipeline —
 * line discounts + order discount (retail/quotations) and service charge +
 * packaging (food service) — in `Prisma.Decimal` throughout.
 *
 * ## The rounding rule, stated once
 *
 * Every intermediate money figure is rounded HALF_UP to 2dp at the same
 * points the legacy pipelines rounded. The one deliberate behaviour change,
 * recorded in D59: at EXACT half-cent boundaries (a 10% discount on 19.85 is
 * 1.985) the float engine's answer depended on binary representation noise
 * and sometimes rounded down; this engine always rounds the mathematical
 * half up. The differential spec proves the two agree everywhere else.
 *
 * ## Callers
 *
 * - `sales.service` (retail) — zero service charge / packaging config.
 * - `quotations.calc` — same, via a number-boundary wrapper.
 * - `restaurant-totals` — no line/order discounts yet (D52 deferral), via a
 *   wrapper that keeps its D52 spec passing verbatim, which is the parity
 *   proof for the food-service half of this pipeline.
 */

const ZERO = new Prisma.Decimal(0);
const D = (v: Prisma.Decimal | number | string): Prisma.Decimal =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
const dp2 = (v: Prisma.Decimal): Prisma.Decimal => v.toDecimalPlaces(2);

export type DocumentDiscountType = 'PERCENTAGE' | 'FIXED';

export interface DocumentLineInput {
  unitPrice: Prisma.Decimal | number;
  quantity: Prisma.Decimal | number;
  /** Modifier price-deltas already summed (food service). Default 0. */
  modifierTotal?: Prisma.Decimal | number;
  discountType?: DocumentDiscountType | null;
  discountValue?: Prisma.Decimal | number | null;
}

export interface ComputedDocumentLine {
  unitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  modifierTotal: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  discountType: DocumentDiscountType | null;
  discountValue: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface DocumentChargeConfig {
  taxRatePercent: Prisma.Decimal | number;
  serviceChargePercent: Prisma.Decimal | number;
  serviceChargeChannels: readonly OrderChannel[];
  serviceChargeTaxable: boolean;
  packagingChargeAmount: Prisma.Decimal | number;
  packagedChannels: readonly OrderChannel[];
}

/** The zero-charge configuration an immediate (retail) sale runs under. */
export const RETAIL_CHARGE_CONFIG: Omit<DocumentChargeConfig, 'taxRatePercent'> = {
  serviceChargePercent: ZERO,
  serviceChargeChannels: [],
  serviceChargeTaxable: false,
  packagingChargeAmount: ZERO,
  packagedChannels: [],
};

export interface DocumentDiscountInput {
  type?: DocumentDiscountType | null;
  value?: Prisma.Decimal | number | null;
}

export interface DocumentTotals {
  lines: ComputedDocumentLine[];
  subtotal: Prisma.Decimal;
  totalLineDiscount: Prisma.Decimal;
  orderDiscountType: DocumentDiscountType | null;
  orderDiscountValue: Prisma.Decimal | null;
  orderDiscountAmount: Prisma.Decimal;
  serviceChargeAmount: Prisma.Decimal;
  packagingCharge: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** A discount can never exceed the base it applies to — both legacy engines agreed. */
function discountOf(
  base: Prisma.Decimal,
  type: DocumentDiscountType | null | undefined,
  value: Prisma.Decimal | number | null | undefined,
): Prisma.Decimal {
  if (!type || value == null) return ZERO;
  const v = D(value);
  if (v.lessThanOrEqualTo(0)) return ZERO;
  const amount = type === 'PERCENTAGE' ? dp2(base.mul(v).div(100)) : dp2(v);
  return Prisma.Decimal.min(base, amount);
}

export function computeDocumentLine(input: DocumentLineInput): ComputedDocumentLine {
  const unitPrice = dp2(D(input.unitPrice));
  const quantity = D(input.quantity);
  const modifierTotal = dp2(D(input.modifierTotal ?? 0));
  const lineSubtotal = dp2(unitPrice.plus(modifierTotal).mul(quantity));
  const type = input.discountType ?? null;
  const value = input.discountValue == null ? null : D(input.discountValue);
  const discountAmount = discountOf(lineSubtotal, type, value);
  return {
    unitPrice,
    quantity,
    modifierTotal,
    lineSubtotal,
    discountType: type,
    discountValue: value,
    discountAmount,
    lineTotal: lineSubtotal.minus(discountAmount),
  };
}

export function computeDocumentTotals(
  lineInputs: readonly DocumentLineInput[],
  channel: OrderChannel,
  config: DocumentChargeConfig,
  orderDiscount?: DocumentDiscountInput | null,
): DocumentTotals {
  const lines = lineInputs.map(computeDocumentLine);

  const subtotal = lines.reduce((acc, l) => acc.plus(l.lineSubtotal), ZERO);
  const totalLineDiscount = lines.reduce((acc, l) => acc.plus(l.discountAmount), ZERO);
  const discountedSubtotal = subtotal.minus(totalLineDiscount);

  const orderType = orderDiscount?.type ?? null;
  const orderValue = orderDiscount?.value == null ? null : D(orderDiscount.value);
  const orderDiscountAmount = discountOf(discountedSubtotal, orderType, orderValue);

  /*
   * The base every charge applies to. With no discounts (food service today)
   * this IS the subtotal, which keeps the D52 behaviour byte-identical; when
   * promotions reach the bill the charges follow what the customer actually
   * pays, in one place.
   */
  const chargeBase = discountedSubtotal.minus(orderDiscountAmount);

  const serviceChargeAmount = config.serviceChargeChannels.includes(channel)
    ? dp2(chargeBase.mul(D(config.serviceChargePercent)).div(100))
    : ZERO;
  const packagingCharge = config.packagedChannels.includes(channel)
    ? dp2(D(config.packagingChargeAmount))
    : ZERO;

  const taxable = chargeBase
    .plus(packagingCharge)
    .plus(config.serviceChargeTaxable ? serviceChargeAmount : ZERO);
  const taxRate = D(config.taxRatePercent);
  const taxAmount = taxRate.greaterThan(0) ? dp2(taxable.mul(taxRate).div(100)) : ZERO;

  return {
    lines,
    subtotal,
    totalLineDiscount,
    orderDiscountType: orderType,
    orderDiscountValue: orderValue,
    orderDiscountAmount,
    serviceChargeAmount,
    packagingCharge,
    taxAmount,
    total: chargeBase.plus(serviceChargeAmount).plus(packagingCharge).plus(taxAmount),
  };
}
