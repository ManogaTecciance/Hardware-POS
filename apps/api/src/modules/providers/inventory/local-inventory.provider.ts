import { Injectable, Logger } from '@nestjs/common';
import { InventoryMode, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  insufficientStockError,
  UnsafeMultiBranchInventoryError,
} from '../provider.errors';
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
