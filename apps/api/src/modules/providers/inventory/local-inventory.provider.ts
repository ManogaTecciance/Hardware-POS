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
  VariantAvailability,
  VariantAvailabilityMap,
} from '../provider.types';
import { InventoryProvider } from './inventory-provider';

/**
 * Local stock, with AxloPOS as the authority and no external system involved.
 *
 * ## The multi-branch guard — the important part of this class
 *
 * `Product.quantityOnHand` is **one global number per product**, with no branch
 * dimension. For a single-branch tenant that column is a complete and correct
 * description of stock. For a multi-branch tenant it is not: reducing it for a sale
 * at branch A silently reduces the number branch B is also reading.
 *
 * `BranchInventory` **does** exist (D44) and is branch- and variant-scoped — this
 * comment claimed otherwise until D99 corrected it. But only receipts and variant
 * sales write it; a product-level sale still moves the global column, so the guard
 * below remains necessary. D10's Phase 2.5, which would move *every* path onto
 * branch-scoped rows, is still outstanding.
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
   * D99 — read-time availability at variant grain, so the courtesy check in
   * `computeCart` speaks about the same rows `reduceStock` will guard.
   *
   * Without this the two disagree: the read sees a product total of 10 across four
   * sizes and passes, then the write finds 0 on the Medium and refuses with the
   * terser transactional message. The cashier gets a bare refusal where a
   * quantities-and-size message was the whole point of checking early.
   *
   * A variant with no `BranchInventory` row is **absent from the map**, matching
   * how an unknown product is absent from {@link getAvailability}. The caller reads
   * absent as zero — D99 decision 8 at read time.
   *
   * Returns an empty map when there is no branch context rather than throwing:
   * this is a read, and `reduceStock` already fails loudly for a variant line with
   * no branch. Refusing here too would turn a courtesy into a second gate.
   */
  async getVariantAvailability(
    ctx: ProviderContext,
    variantIds: string[],
  ): Promise<VariantAvailabilityMap> {
    await this.assertSingleBranch(this.prisma, ctx);
    if (variantIds.length === 0 || ctx.branchId === null) return new Map();

    const rows = await this.prisma.branchInventory.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productVariantId: { in: [...new Set(variantIds)] },
      },
      select: { productVariantId: true, quantityOnHand: true },
    });

    const map = new Map<string, VariantAvailability>();
    for (const row of rows) {
      // The `in` predicate cannot match a null column, so this is narrowing for
      // the type checker rather than a real branch.
      if (row.productVariantId === null) continue;
      map.set(row.productVariantId, {
        productVariantId: row.productVariantId,
        quantityOnHand: Number(row.quantityOnHand),
      });
    }
    return map;
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

    for (const { productId, productVariantId, name, qty } of aggregateByVariant(lines)) {
      // ── product-level line: unchanged since before variants existed ────────
      if (productVariantId === null) {
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
        continue;
      }

      // ── variant line: the row lives in BranchInventory ─────────────────────
      // D99 decision 9 — a variant's stock is branch-scoped, so there is no row to
      // target without a branch. Fail loudly, matching `receiveStock`, rather than
      // quietly reducing product-level stock and hiding the caller's omission.
      if (ctx.branchId === null) {
        throw new InvalidBranchContextError(
          'reduceStock requires an explicit branchId for a variant line',
        );
      }

      // The oversell guard, MOVED not rewritten: the same conditional write, the
      // same row-count check, the same message. `quantityOnHand: { gte: qty }` in
      // the predicate is what makes two concurrent sales of the last unit
      // serialise — one updates the row, the other matches nothing.
      //
      // D99 decision 8 — no row means the variant was never received into this
      // branch, so it matches nothing and reports insufficient stock. Variant
      // stock is created by goods receipts, never by a sale.
      const res = await tx.branchInventory.updateMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productVariantId,
          quantityOnHand: { gte: qty },
        },
        data: { quantityOnHand: { decrement: qty }, version: { increment: 1 } },
      });
      if (res.count === 0) {
        throw insufficientStockError(name);
      }

      // D10 rollup mirror, the exact counterpart of the increment in
      // `receiveStock`. Without it the product-level number only ever climbs —
      // receipts add to it and sales never subtract — and that number is what the
      // product list and the low-stock badge read.
      //
      // No `gte` guard here on purpose: the authoritative check already happened
      // against the BranchInventory row above, and a second conditional on the
      // same logical decrement would fail partially in ways nobody can reason
      // about. `type: 'Inventory'` matches the receive/return idiom.
      await tx.product.updateMany({
        where: { id: productId, tenantId: ctx.tenantId, type: 'Inventory' },
        data: { quantityOnHand: { decrement: qty } },
      });
    }
  }

  /**
   * Restore on-hand stock for a return.
   *
   * `type: 'Inventory'` is part of the product predicate, so a Service product
   * silently restocks nothing, and there is no row-count check because restoring
   * stock cannot fail a business rule.
   *
   * ## D99 (1a.20) — the return goes back to the size that was sold
   *
   * This used to aggregate by product alone and touch `Product.quantityOnHand`
   * only, which left the sell and return paths asymmetric:
   *
   * | Line | Sale decrements | Return incremented |
   * |---|---|---|
   * | product-level | `Product` | `Product` — symmetric |
   * | **variant** | `BranchInventory` **+** `Product` mirror | **`Product` only** |
   *
   * So a returned Medium credited the customer, bumped the product total, and
   * never went back on the shelf. The variant row stayed down and the mirror
   * drifted up a little further with every return.
   *
   * Structure now mirrors `reduceStock` exactly, minus the parts that have no
   * counterpart on this side: **no `gte` guard** (restoring adds — there is
   * nothing to run short of, and the guard exists to prevent overselling), and
   * no row-count check.
   */
  async restoreStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void> {
    await this.assertSingleBranch(tx, ctx);

    for (const { productId, productVariantId, qty } of aggregateByVariant(lines)) {
      // ── product-level line: unchanged since before variants existed ────────
      if (productVariantId === null) {
        await tx.product.updateMany({
          where: { id: productId, tenantId: ctx.tenantId, type: 'Inventory' },
          data: { quantityOnHand: { increment: qty } },
        });
        continue;
      }

      // ── variant line: the row lives in BranchInventory ─────────────────────
      // Same reasoning as `reduceStock` — a variant's stock is branch-scoped, so
      // there is no row to target without a branch.
      if (ctx.branchId === null) {
        throw new InvalidBranchContextError(
          'restoreStock requires an explicit branchId for a variant line',
        );
      }

      // Upsert, not updateMany (decision: 1a.20, option A).
      //
      // The row should always exist: `reduceStock` refuses a variant with no row,
      // so a completed sale is proof one was there. A missing row means it was
      // deleted between the sale and the return — and in that case a cashier is
      // standing at the counter holding the goods. Recording stock that
      // physically exists is truer than silently discarding it, which is what a
      // no-op `updateMany` would do.
      //
      // `averageCost` is left null on a row created this way. That is already its
      // documented pre-receipt state (D44), and a return is not a receipt: it has
      // no purchase cost to weight into an average.
      // `upsert` is not available: uniqueness of (branch, variant) is enforced by
      // paired PARTIAL unique indexes, which Prisma cannot express, so there is no
      // compound `where` unique to upsert against.
      //
      // Update-first rather than `receiveStock`'s find-then-branch, because the
      // conditional write is atomic: a concurrent return cannot slip between a
      // read and a write and cause a lost increment.
      const restored = await tx.branchInventory.updateMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId, productVariantId },
        data: { quantityOnHand: { increment: qty }, version: { increment: 1 } },
      });

      if (restored.count === 0) {
        await tx.branchInventory.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId,
            productVariantId,
            quantityOnHand: qty,
          },
        });
      }

      // D10 rollup mirror — the exact counterpart of the decrement in
      // `reduceStock`. Without it a return would put the size back on the shelf
      // while the product total stayed down.
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
/**
 * D99 — aggregate by (product, variant) rather than by product.
 *
 * A cart holding a Medium and a Large of one shirt must produce two decrements
 * against two rows; keying by product alone would collapse them into one against
 * the wrong grain. Repeated lines of the *same* variant still merge, which is why
 * {@link aggregate} existed in the first place — a cart may list one thing twice.
 *
 * Deliberately a second function rather than a change to {@link aggregate}: the
 * QuickBooks provider also aggregates, and QuickBooks Items have no variant
 * dimension. Widening the shared helper would quietly alter a provider that
 * cannot use the extra key.
 */
export interface VariantStockTotal {
  productId: string;
  productVariantId: string | null;
  name: string;
  qty: number;
}

export function aggregateByVariant(lines: StockLine[]): VariantStockTotal[] {
  const totals = new Map<string, VariantStockTotal>();
  for (const line of lines) {
    if (!line.trackInventory) continue;
    // `::` cannot occur inside a cuid, so the composite key is unambiguous.
    const key = `${line.productId}::${line.productVariantId ?? ''}`;
    const prev = totals.get(key);
    totals.set(key, {
      productId: line.productId,
      productVariantId: line.productVariantId,
      name: line.productName,
      qty: (prev?.qty ?? 0) + line.quantity,
    });
  }
  return [...totals.values()];
}

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
