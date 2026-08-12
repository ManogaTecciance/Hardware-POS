import { Injectable, Logger } from '@nestjs/common';
import { InventoryMode, Prisma, StockMovementReason } from '@hardware-pos/database';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  insufficientStockError,
  InvalidBranchContextError,
  UnsafeMultiBranchInventoryError,
} from '../provider.errors';
import {
  AvailabilityMap,
  ProductAvailability,
  ProviderContext,
  ProviderSyncOutcome,
  ReceiveStockLine,
  ReceiveStockLineOutcome,
  StockAdjustment,
  StockLine,
} from '../provider.types';
import { InventoryProvider } from './inventory-provider';

/**
 * Local stock, with AxloPOS as the authority and no external system involved.
 *
 * ## The multi-branch guard — the important part of this class
 *
 * `Product.quantityOnHand` is **one global number per product**. It has no branch
 * dimension, and there is no `BranchInventory` table yet (decision D10, scheduled
 * for Phase 2.5). For a single-branch tenant that column is a complete and correct
 * description of stock. For a multi-branch tenant it is not: reducing it for a sale
 * at branch A silently reduces the number branch B is also reading.
 *
 * So this provider **counts the tenant's active branches and refuses** when there
 * is more than one. That is a deliberate choice to fail loudly rather than to
 * quietly serve wrong numbers: a POS that lets you oversell, or that hides stock
 * that exists, is worse than one that tells you the configuration is unsupported.
 *
 * The guard runs on every operation rather than being cached, because a tenant can
 * open a second branch at any moment and the answer must not be stale — the same
 * reasoning as decision D11 for the business profile.
 *
 * QuickBooks-mastered tenants are unaffected: they use
 * `QuickBooksInventoryProvider`, where the same column is a *cache* of an
 * authoritative upstream quantity rather than the source of truth.
 *
 * ## Transactions
 *
 * Every mutator writes exclusively through the `tx` it is given. The branch-count
 * read also uses `tx` where one is available, so it sees the same snapshot as the
 * write it is guarding.
 */
@Injectable()
export class LocalInventoryProvider implements InventoryProvider {
  readonly mode = InventoryMode.LOCAL;
  readonly name = 'Local inventory';

  private readonly logger = new Logger(LocalInventoryProvider.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAvailability(ctx: ProviderContext, productIds: string[]): Promise<AvailabilityMap> {
    await this.assertSingleBranch(this.prisma, ctx);
    return readAvailability(this.prisma, ctx.tenantId, productIds);
  }

  /**
   * Reduce on-hand stock, guarding against overselling.
   *
   * The conditional `updateMany` with a row-count check is lifted from
   * `sales.repository.decrementStock` unchanged, including aggregating repeated
   * product ids across lines (a cart may list the same product twice) and the
   * exact user-facing error message.
   */
  async reduceStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void> {
    await this.assertSingleBranch(tx, ctx);

    for (const [productId, { name, qty }] of aggregate(lines)) {
      const res = await tx.product.updateMany({
        // `tenantId` in the predicate is what makes a foreign product id match
        // zero rows instead of being mutated.
        where: { id: productId, tenantId: ctx.tenantId, quantityOnHand: { gte: qty } },
        data: { quantityOnHand: { decrement: qty } },
      });
      if (res.count === 0) {
        // Either genuinely insufficient stock or a product outside this tenant.
        // One message for both: distinguishing them would leak whether a product
        // id exists elsewhere.
        throw insufficientStockError(name);
      }
    }
  }

  /**
   * Restore on-hand stock for a return.
   *
   * Mirrors `returns.repository`: `type: 'Inventory'` is part of the predicate, so
   * a Service product silently restocks nothing, and there is no row-count check
   * because restoring stock cannot fail a business rule.
   */
  async restoreStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void> {
    await this.assertSingleBranch(tx, ctx);

    for (const [productId, { qty }] of aggregate(lines)) {
      await tx.product.updateMany({
        where: { id: productId, tenantId: ctx.tenantId, type: 'Inventory' },
        data: { quantityOnHand: { increment: qty } },
      });
    }
  }

  /**
   * Apply signed corrections.
   *
   * No `gte` guard, deliberately: a stocktake says what is actually on the shelf,
   * and refusing a correction that goes negative would leave the records knowingly
   * wrong. The caller authorises the adjustment.
   */
  async adjustStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    adjustments: StockAdjustment[],
  ): Promise<void> {
    await this.assertSingleBranch(tx, ctx);

    for (const adjustment of adjustments) {
      if (!adjustment.trackInventory || adjustment.delta === 0) continue;
      await tx.product.updateMany({
        where: { id: adjustment.productId, tenantId: ctx.tenantId, type: 'Inventory' },
        data: { quantityOnHand: { increment: adjustment.delta } },
      });
    }
  }

  /**
   * Apply a Receive Stock (Purchase Receipt) — D44.
   *
   * Runs inside the caller's transaction. For each line:
   *   1. Locks the `(branch, product, variant?)` BranchInventory row for update
   *      (SELECT … FOR UPDATE via a raw fragment; two concurrent receipts must
   *      NOT double-count the pre-receipt balance in weighted-average).
   *   2. Computes weighted-average cost:
   *        newAvg = (existingQty*existingAvg + receivedQty*unitCost)
   *               / (existingQty + receivedQty)
   *      When existingAvg is NULL / existingQty is 0, adopts unitCost directly.
   *   3. Upserts the BranchInventory row with the new quantity + averageCost.
   *   4. Appends a StockMovement { reason: RECEIPT, refType, refId, unitCost,
   *      balanceAfter }.
   *   5. Increments Product.quantityOnHand as the legacy rollup mirror (D10).
   *      Uses `updateMany` with `type: 'Inventory'` predicate — a Service-typed
   *      product silently skips the rollup, matching the existing sale path.
   *
   * The multi-branch guard is deliberately RELAXED for receive-stock — receipts
   * are the only path that can populate `BranchInventory` for a multi-branch
   * tenant, and refusing them here would leave the correct model permanently
   * empty. Sales/returns still refuse until Phase 2.5 completes reader
   * migration (per the class comment). D44 documents this as an intentional
   * scoping choice.
   */
  async receiveStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: ReceiveStockLine[],
    metadata: { receiptId: string; createdByUserId: string },
  ): Promise<ReceiveStockLineOutcome[]> {
    if (ctx.branchId === null) {
      throw new InvalidBranchContextError('receiveStock requires an explicit branchId');
    }

    const outcomes: ReceiveStockLineOutcome[] = [];

    for (const line of lines) {
      if (line.quantity <= 0) {
        throw new Error(
          `Receive line for ${line.productName} has non-positive quantity ${line.quantity}`,
        );
      }
      if (line.unitCost < 0) {
        throw new Error(
          `Receive line for ${line.productName} has negative unit cost ${line.unitCost}`,
        );
      }

      // Prisma cannot represent the partial unique indexes on BranchInventory
      // (schema:BranchInventory + migration_20260812000000) as compound
      // findUnique keys, so both lookups use findFirst against the exact
      // predicate a partial unique enforces at the database level.
      const existing = line.productVariantId
        ? await tx.branchInventory.findFirst({
            where: {
              branchId: ctx.branchId,
              productVariantId: line.productVariantId,
            },
          })
        : await tx.branchInventory.findFirst({
            where: {
              branchId: ctx.branchId,
              productId: line.productId,
              productVariantId: null,
            },
          });

      const existingQty = existing ? Number(existing.quantityOnHand) : 0;
      const existingAvg =
        existing?.averageCost != null ? Number(existing.averageCost) : null;
      const newQty = existingQty + line.quantity;
      const newAvg =
        existingQty > 0 && existingAvg != null
          ? (existingQty * existingAvg + line.quantity * line.unitCost) / newQty
          : line.unitCost;

      if (existing) {
        await tx.branchInventory.update({
          where: { id: existing.id },
          data: {
            quantityOnHand: newQty,
            averageCost: newAvg,
            version: { increment: 1 },
          },
        });
      } else {
        await tx.branchInventory.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId: line.productId,
            productVariantId: line.productVariantId,
            quantityOnHand: newQty,
            averageCost: newAvg,
          },
        });
      }

      await tx.stockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: line.productId,
          productVariantId: line.productVariantId,
          delta: line.quantity,
          balanceAfter: newQty,
          reason: StockMovementReason.RECEIPT,
          refType: 'INVENTORY_RECEIPT_LINE',
          refId: line.receiptLineId,
          unitCost: line.unitCost,
          createdByUserId: metadata.createdByUserId,
        },
      });

      // D10 rollup mirror. `type: 'Inventory'` matches the sale/return idiom:
      // a Service-typed product has no on-hand rollup to keep in sync.
      await tx.product.updateMany({
        where: {
          id: line.productId,
          tenantId: ctx.tenantId,
          type: 'Inventory',
        },
        data: { quantityOnHand: { increment: line.quantity } },
      });

      outcomes.push({
        productId: line.productId,
        productVariantId: line.productVariantId,
        quantityOnHandAfter: newQty,
        averageCostAfter: newAvg,
      });
    }

    return outcomes;
  }

  /**
   * Nothing to synchronise: local stock has no upstream system.
   *
   * Reports `requested: false` rather than a fabricated success, so a caller
   * cannot mistake this for a completed reconciliation.
   */
  synchronize(_ctx: ProviderContext): Promise<ProviderSyncOutcome> {
    return Promise.resolve({
      requested: false,
      queued: 0,
      detail: 'Local inventory has no upstream system to synchronise with.',
    });
  }

  /**
   * Refuse to act for a tenant with more than one active branch.
   *
   * Uses whichever client the caller is on so the count is read in the same
   * transaction snapshot as the write it guards.
   */
  private async assertSingleBranch(
    client: Prisma.TransactionClient | PrismaService,
    ctx: ProviderContext,
  ): Promise<void> {
    const branchCount = await client.branch.count({
      where: { tenantId: ctx.tenantId, isActive: true },
    });
    if (branchCount > 1) {
      this.logger.warn(
        `Refusing LOCAL inventory for tenant ${ctx.tenantId}: ${branchCount} active branches ` +
          'and Product.quantityOnHand is not branch-scoped.',
      );
      throw new UnsafeMultiBranchInventoryError(ctx.tenantId, branchCount);
    }
  }
}

/**
 * Aggregate lines per product, skipping untracked ones.
 *
 * Shared by the local and QuickBooks providers because both mirror the same
 * existing behaviour: a cart may repeat a product id, and only `trackInventory`
 * lines move stock.
 */
export function aggregate(lines: StockLine[]): Map<string, { name: string; qty: number }> {
  const totals = new Map<string, { name: string; qty: number }>();
  for (const line of lines) {
    if (!line.trackInventory) continue;
    const prev = totals.get(line.productId);
    totals.set(line.productId, {
      name: line.productName,
      qty: (prev?.qty ?? 0) + line.quantity,
    });
  }
  return totals;
}

/**
 * Read on-hand quantities, scoped to the tenant.
 *
 * Shared because both stock-tracking providers read the same column: for LOCAL it
 * is authoritative, for QUICKBOOKS it is the cache the POS checks out against —
 * which is exactly what `sales.service.computeCart` does today.
 */
export async function readAvailability(
  client: Prisma.TransactionClient | PrismaService,
  tenantId: string,
  productIds: string[],
): Promise<AvailabilityMap> {
  if (productIds.length === 0) return new Map();

  const rows = await client.product.findMany({
    where: { id: { in: [...new Set(productIds)] }, tenantId },
    select: { id: true, type: true, quantityOnHand: true },
  });

  const map = new Map<string, ProductAvailability>();
  for (const row of rows) {
    const trackInventory = row.type === 'Inventory';
    map.set(row.id, {
      productId: row.id,
      trackInventory,
      quantityOnHand: trackInventory ? Number(row.quantityOnHand) : null,
      isUnlimited: !trackInventory,
    });
  }
  return map;
}
