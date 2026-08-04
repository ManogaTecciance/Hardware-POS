import { Injectable, Logger } from '@nestjs/common';
import { InventoryMode, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../../prisma/prisma.service';
import { SyncQueueService } from '../../sync/queue/sync-queue.service';
import { insufficientStockError } from '../provider.errors';
import {
  AvailabilityMap,
  ProviderContext,
  ProviderSyncOutcome,
  StockAdjustment,
  StockLine,
} from '../provider.types';
import { InventoryProvider } from './inventory-provider';
import { aggregate, readAvailability } from './local-inventory.provider';

/**
 * QuickBooks-mastered inventory — today's production behaviour, unchanged.
 *
 * ## Why this looks so much like the local provider
 *
 * Because that is what the code does today, and Slice 5 adapts rather than
 * redesigns. QuickBooks Online is the authority for stock, but the POS keeps a
 * **cached** `Product.quantityOnHand` so checkout is fast and works during a
 * QuickBooks outage. A sale decrements the cache locally and inside the sale
 * transaction; QuickBooks reduces the real quantity later as a side effect of the
 * Sales Receipt or Invoice the outbox pushes; the periodic product pull reconciles
 * the cache back to QuickBooks' absolute numbers.
 *
 * So the local write is not a duplicate of the QuickBooks write — it is a cache
 * update, and it is the reason overselling is impossible even while offline.
 *
 * The crucial difference from `LocalInventoryProvider` is what is **absent**: no
 * multi-branch guard. The number here is a cache of an upstream total, not a claim
 * about branch-level stock, so a multi-branch QuickBooks tenant is exactly as
 * correct (and exactly as approximate) as it is today. Adding a guard would break
 * every existing multi-branch tenant, which is precisely the outcome Phase 1
 * forbids.
 *
 * ## No QuickBooks types cross the port
 *
 * This class talks to `SyncQueueService` and Prisma only. It imports nothing from
 * the QuickBooks client, and no Intuit type appears in any signature — the port
 * stays clean even though this implementation is the QuickBooks one.
 */
@Injectable()
export class QuickBooksInventoryProvider implements InventoryProvider {
  readonly mode = InventoryMode.QUICKBOOKS;
  readonly name = 'QuickBooks inventory';

  private readonly logger = new Logger(QuickBooksInventoryProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncQueue: SyncQueueService,
  ) {}

  /** Reads the cached quantity, exactly as `computeCart` does today. */
  getAvailability(ctx: ProviderContext, productIds: string[]): Promise<AvailabilityMap> {
    return readAvailability(this.prisma, ctx.tenantId, productIds);
  }

  /**
   * Decrement the local cache with the anti-oversell guard.
   *
   * Byte-for-byte the behaviour of `sales.repository.decrementStock`: aggregate
   * repeated product ids, conditional `updateMany` with `gte`, row-count check,
   * and the same user-facing message. A zero-row update throws so the whole sale
   * rolls back.
   */
  async reduceStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void> {
    for (const [productId, { name, qty }] of aggregate(lines)) {
      const res = await tx.product.updateMany({
        where: { id: productId, tenantId: ctx.tenantId, quantityOnHand: { gte: qty } },
        data: { quantityOnHand: { decrement: qty } },
      });
      if (res.count === 0) {
        throw insufficientStockError(name);
      }
    }
  }

  /**
   * Restore the local cache for a return.
   *
   * Mirrors `returns.repository`'s eager restock, including the `type: 'Inventory'`
   * predicate. Deliberately decoupled from the QuickBooks push, which stays async
   * and retryable, so local stock is right regardless of QuickBooks connectivity.
   */
  async restoreStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void> {
    for (const [productId, { qty }] of aggregate(lines)) {
      await tx.product.updateMany({
        where: { id: productId, tenantId: ctx.tenantId, type: 'Inventory' },
        data: { quantityOnHand: { increment: qty } },
      });
    }
  }

  /**
   * Correct the local cache.
   *
   * Note the honest limitation: QuickBooks is the authority, so an adjustment made
   * here is a cache correction that the next product pull will overwrite. Making it
   * authoritative means pushing an inventory adjustment to QuickBooks, which the
   * repository cannot do today — `SyncJobType` has `SALES_SYNC`, `RETURN_SYNC`, and
   * `PRODUCT_SYNC` only. Recorded as a Slice 5 limitation rather than faked.
   */
  async adjustStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    adjustments: StockAdjustment[],
  ): Promise<void> {
    for (const adjustment of adjustments) {
      if (!adjustment.trackInventory || adjustment.delta === 0) continue;
      await tx.product.updateMany({
        where: { id: adjustment.productId, tenantId: ctx.tenantId, type: 'Inventory' },
        data: { quantityOnHand: { increment: adjustment.delta } },
      });
    }
  }

  /**
   * Queue an outbound product sync per product, which is what
   * `POST /v1/sync/products/refresh` does today.
   *
   * `enqueueProductSync` returns `false` when the tenant has no active
   * `QuickBooksConnection`, and that is reported honestly as `requested: false`
   * with zero queued rather than as a success.
   */
  async synchronize(ctx: ProviderContext): Promise<ProviderSyncOutcome> {
    const products = await this.prisma.product.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      select: { id: true },
    });

    let queued = 0;
    for (const product of products) {
      if (await this.syncQueue.enqueueProductSync(ctx.tenantId, product.id)) {
        queued += 1;
      }
    }

    if (queued === 0) {
      this.logger.log(
        `No product sync queued for tenant ${ctx.tenantId} ` +
          `(${products.length} active product(s); QuickBooks may not be connected).`,
      );
      return {
        requested: false,
        queued: 0,
        detail: 'QuickBooks is not connected for this tenant; nothing was queued.',
      };
    }
    return { requested: true, queued, detail: `Queued ${queued} product sync job(s).` };
  }
}
