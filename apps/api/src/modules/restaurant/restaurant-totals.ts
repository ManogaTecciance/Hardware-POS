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

export interface RestaurantTotals {
  subtotal: Prisma.Decimal;
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
): RestaurantTotals {
  /*
   * D59: delegated to the ONE document-totals engine. This wrapper keeps the
   * D52 call shape (a pre-summed subtotal, restaurant channel values) and its
   * spec passing verbatim — which is the parity proof that the shared engine
   * reproduces the food-service pipeline exactly. A bill has no line or
   * order discounts yet (D52 deferral), so the subtotal passes through as a
   * single undiscounted line.
   */
  const totals = computeDocumentTotals(
    [{ unitPrice: subtotal, quantity: 1 }],
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
  return {
    subtotal,
    serviceChargeAmount: totals.serviceChargeAmount,
    packagingCharge: totals.packagingCharge,
    taxAmount: totals.taxAmount,
    total: totals.total,
  };
}
