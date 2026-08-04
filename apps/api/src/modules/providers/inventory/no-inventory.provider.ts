import { Injectable } from '@nestjs/common';
import { InventoryMode, Prisma } from '@hardware-pos/database';

import {
  AvailabilityMap,
  ProductAvailability,
  ProviderContext,
  ProviderSyncOutcome,
  StockAdjustment,
  StockLine,
} from '../provider.types';
import { InventoryProvider } from './inventory-provider';

/**
 * Inventory tracking switched off — the right provider for a restaurant selling
 * from a menu, where "how many chicken curries are left" is not a stock question.
 *
 * ## What it does, precisely
 *
 * Every mutator is a **deterministic no-op**: it touches no row, throws nothing,
 * and returns the same way for the same input every time. It takes the `tx`
 * parameter and ignores it, which is intentional — the signature is part of the
 * port contract, and a caller inside a transaction must be able to call this
 * without a special case.
 *
 * `getAvailability` is **explicit rather than silent**: it reports every requested
 * product as `isUnlimited: true` with `quantityOnHand: null`. Returning zero would
 * make callers refuse sales; returning an empty map would make them think the
 * products do not exist. `null` plus `isUnlimited` says "there is no ceiling and I
 * have no number", which is the truth.
 *
 * ## What it must never do
 *
 * - **No `SyncJob` or `SyncLog` rows.** It never touches the outbox at all.
 * - **No QuickBooks call.** It has no QuickBooks dependency to call with — note the
 *   constructor takes nothing.
 * - **Never behave like `LocalInventoryProvider`.** It does not read or write
 *   `Product.quantityOnHand`. A tenant that switched inventory off must not have
 *   stock quietly moving underneath it, and a bug that routed a QuickBooks tenant
 *   here must fail visibly (sales stop being constrained) rather than silently
 *   half-work.
 *
 * It holds no `PrismaService` at all, which is the structural guarantee behind all
 * three of those promises: it has no way to write a row.
 */
@Injectable()
export class NoInventoryProvider implements InventoryProvider {
  readonly mode = InventoryMode.DISABLED;
  readonly name = 'No inventory tracking';

  /**
   * Every product is unlimited. Reported for every id asked about, so a caller
   * never has to guess what an absent entry meant.
   */
  getAvailability(_ctx: ProviderContext, productIds: string[]): Promise<AvailabilityMap> {
    const map = new Map<string, ProductAvailability>();
    for (const productId of new Set(productIds)) {
      map.set(productId, {
        productId,
        trackInventory: false,
        quantityOnHand: null,
        isUnlimited: true,
      });
    }
    return Promise.resolve(map);
  }

  /** No-op. `tx` is accepted and ignored — see the class comment. */
  reduceStock(
    _tx: Prisma.TransactionClient,
    _ctx: ProviderContext,
    _lines: StockLine[],
  ): Promise<void> {
    return Promise.resolve();
  }

  /** No-op. */
  restoreStock(
    _tx: Prisma.TransactionClient,
    _ctx: ProviderContext,
    _lines: StockLine[],
  ): Promise<void> {
    return Promise.resolve();
  }

  /** No-op. */
  adjustStock(
    _tx: Prisma.TransactionClient,
    _ctx: ProviderContext,
    _adjustments: StockAdjustment[],
  ): Promise<void> {
    return Promise.resolve();
  }

  /** Nothing to synchronise, and it says so rather than reporting a success. */
  synchronize(_ctx: ProviderContext): Promise<ProviderSyncOutcome> {
    return Promise.resolve({
      requested: false,
      queued: 0,
      detail: 'Inventory tracking is disabled for this tenant; nothing to synchronise.',
    });
  }
}
