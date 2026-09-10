import { OrderChannel, Prisma, RestaurantOrderChannel } from '@hardware-pos/database';

import { computeDocumentTotals } from '../../common/money/document-totals';

/**
 * D52 — the one place restaurant bill money is computed.
 *
 * Pure and dependency-free (the `split-shares.ts` pattern) so the rules are
 * provable without a database, and shared by every channel so dine-in and
 * takeaway cannot drift — which is exactly what happened before this existed:
 * dine-in levied a service charge and takeaway silently did not.
 */

export interface RestaurantChargeConfig {
  serviceChargePercent: Prisma.Decimal;
  /** Channels that levy the service charge. Default is dine-in only. */
  serviceChargeChannels: RestaurantOrderChannel[];
  /** Whether the service charge sits inside the taxable base (jurisdictional). */
  serviceChargeTaxable: boolean;
  /** Flat per-order packaging charge for TAKEAWAY / ONLINE. */
  packagingChargeAmount: Prisma.Decimal;
  /** From the tenant's `AppSettings.taxRatePercent`. 0 disables tax. */
  taxRatePercent: number;
}

/**
 * What the promotion pass took off this bill, if anything.
 *
 * Split in two because the two halves land at different points in the
 * arithmetic, exactly as they do on a retail sale:
 *
 * - `lineDiscount` reduces the goods, so the service charge and the tax follow
 *   what the customer actually pays for food. `document-totals` was written
 *   anticipating this ("when promotions reach the bill the charges follow what
 *   the customer actually pays, in one place").
 * - `orderDiscount` is D126's cart-level promotion, and comes off AFTER tax —
 *   the asymmetry `sales.service` records as PO-confirmed. Restaurant bills
 *   copy it rather than inventing a second rule for the same promotion.
 */
export interface RestaurantPromotionDiscounts {
  lineDiscount: Prisma.Decimal;
  orderDiscount: Prisma.Decimal;
}

export interface RestaurantTotals {
  subtotal: Prisma.Decimal;
  /** Σ of the line-level promotion discounts. Zero when none applied. */
  promotionLineDiscount: Prisma.Decimal;
  /** D126 — the cart-level promotion, off the total after tax. */
  promotionOrderDiscount: Prisma.Decimal;
  serviceChargeAmount: Prisma.Decimal;
  packagingCharge: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Channels that pay a packaging charge — the food leaves the building. */
const PACKAGED_CHANNELS: readonly RestaurantOrderChannel[] = ['TAKEAWAY', 'ONLINE'];

/**
 * Compute a restaurant bill's charges from its item subtotal.
 *
 * Order of operations, and why:
 *   service charge  — a percentage of the item subtotal, only on configured
 *                     channels.
 *   packaging       — a flat amount, only where the food is packed to leave.
 *   tax             — a percentage of the taxable base, which always includes
 *                     the items and packaging, and includes the service charge
 *                     only when the branch says it does.
 *
 * Every intermediate is rounded to 2dp before it is added, so the stored
 * columns sum to the stored total exactly. A bill whose parts do not add up is
 * unpayable: the payment path refuses a tender above the balance.
 */
export function computeRestaurantTotals(
  subtotal: Prisma.Decimal,
  channel: RestaurantOrderChannel,
  config: RestaurantChargeConfig,
  promotions?: RestaurantPromotionDiscounts,
): RestaurantTotals {
  const lineDiscount = promotions?.lineDiscount ?? new Prisma.Decimal(0);
  const orderDiscount = promotions?.orderDiscount ?? new Prisma.Decimal(0);

  /*
   * D59: delegated to the ONE document-totals engine. This wrapper keeps the
   * D52 call shape (a pre-summed subtotal, restaurant channel values) and its
   * spec passing verbatim — which is the parity proof that the shared engine
   * reproduces the food-service pipeline exactly.
   *
   * The promotion pass arrives as a single FIXED line discount on that
   * synthetic line, which is what makes the engine's `chargeBase` — and so the
   * service charge and the tax — follow the discounted goods. Absent a
   * promotion the discount is null and every figure is byte-identical to the
   * D52 behaviour, which is why that spec still passes untouched.
   */
  const totals = computeDocumentTotals(
    [
      {
        unitPrice: subtotal,
        quantity: 1,
        discountType: lineDiscount.greaterThan(0) ? 'FIXED' : null,
        discountValue: lineDiscount.greaterThan(0) ? lineDiscount : null,
        discountBasis: 'LINE',
      },
    ],
    channel as OrderChannel,
    {
      taxRatePercent: config.taxRatePercent,
      serviceChargePercent: config.serviceChargePercent,
      serviceChargeChannels: config.serviceChargeChannels as readonly OrderChannel[],
      serviceChargeTaxable: config.serviceChargeTaxable,
      packagingChargeAmount: config.packagingChargeAmount,
      packagedChannels: PACKAGED_CHANNELS as readonly OrderChannel[],
    },
  );

  /*
   * The cart-level promotion can never take more than is left to pay. Without
   * the clamp a "Rs 2,000 off" on a Rs 1,500 bill would produce a negative
   * total, and a negative balance is a bill the payment path would let a guest
   * be refunded against.
   */
  const orderTaken = Prisma.Decimal.min(orderDiscount, totals.total);

  return {
    subtotal,
    promotionLineDiscount: totals.totalLineDiscount,
    promotionOrderDiscount: orderTaken,
    serviceChargeAmount: totals.serviceChargeAmount,
    packagingCharge: totals.packagingCharge,
    taxAmount: totals.taxAmount,
    total: totals.total.minus(orderTaken),
  };
}
