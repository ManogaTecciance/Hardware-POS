import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductNotFoundInTenantError,
} from '../providers/provider.errors';
import { InventoryProviderFactory } from '../providers/inventory/inventory-provider.factory';
import { ReceiveStockLine } from '../providers/provider.types';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { QueryReceiptsDto } from './dto/query-receipts.dto';
import {
  InventoryReceiptsRepository,
} from './inventory-receipts.repository';
import { computeWeightedAverage } from './weighted-average';

/** Per-line outcome the response echoes back for UI display. */
export interface ReceiptLineResponse {
  id: string;
  productId: string;
  productVariantId: string | null;
  quantityReceived: string;
  unitCost: string;
  lotNumber: string | null;
  expiryDate: Date | null;
  quantityOnHandAfter: number;
  averageCostAfter: number;
}

/** Full receipt response — header, lines with outcomes, and joined names. */
export interface ReceiptResponse {
  id: string;
  receiptNumber: string;
  tenantId: string;
  branchId: string;
  branchName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: Date;
  invoiceReference: string | null;
  grnReference: string | null;
  notes: string | null;
  createdByUserId: string;
  createdByUserName: string | null;
  createdAt: Date;
  lines: ReceiptLineResponse[];
}

/**
 * Purchase Receipt orchestration (D44).
 *
 * ONE public write endpoint (`createReceipt`) — the transaction is the
 * boundary of the whole operation: header + lines + weighted-average +
 * cost mirror refresh + audit row all commit together, or none do. The
 * inventory provider participates in the same transaction (it must, per the
 * `InventoryProvider` contract's transaction rules), so a provider refusal
 * rolls back the receipt rather than leaving a header with no stock move.
 */
@Injectable()
export class InventoryReceiptsService {
  private readonly logger = new Logger(InventoryReceiptsService.name);

  constructor(
    private readonly repo: InventoryReceiptsRepository,
    private readonly prisma: PrismaService,
    private readonly inventoryProviders: InventoryProviderFactory,
  ) {}

  async createReceipt(
    tenantId: string,
    createdByUserId: string,
    dto: CreateReceiptDto,
  ): Promise<ReceiptResponse> {
    // ── 1. Validate lines up front, BEFORE any provider is asked to act ──
    if (dto.lines.length === 0) {
      throw new BadRequestException('A receipt must have at least one line');
    }
    for (const line of dto.lines) {
      if (line.quantityReceived <= 0) {
        throw new BadRequestException(
          `Line for product ${line.productId} has non-positive quantityReceived ${line.quantityReceived}`,
        );
      }
      if (line.unitCost < 0) {
        throw new BadRequestException(
          `Line for product ${line.productId} has negative unitCost ${line.unitCost}`,
        );
      }
    }

    // ── 2. Idempotency short-circuit ──
    if (dto.idempotencyKey) {
      const existing = await this.repo.findByIdempotencyKey(tenantId, dto.idempotencyKey);
      if (existing) {
        return this.readReceiptResponse(tenantId, existing.id);
      }
    }

    // ── 3. Branch + supplier + product/variant identity ──
    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId, isActive: true },
      select: { id: true, name: true },
    });
    if (!branch) {
      throw new BadRequestException(
        `Branch ${dto.branchId} does not belong to this tenant or is inactive`,
      );
    }

    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: dto.supplierId, tenantId },
        select: { id: true },
      });
      if (!supplier) {
        throw new BadRequestException(
          `Supplier ${dto.supplierId} does not belong to this tenant`,
        );
      }
    }

    const productMap = await this.repo.assertProductsAndVariants(
      tenantId,
      dto.lines.map((l) => ({
        productId: l.productId,
        productVariantId: l.productVariantId ?? null,
      })),
    );
    for (const line of dto.lines) {
      if (!productMap.has(line.productId)) {
        throw new ProductNotFoundInTenantError(line.productId);
      }
    }

    // Resolve inventory provider OUTSIDE the transaction — the factory reads
    // BusinessProfileService and we don't want that read holding a write lock.
    const inventory = await this.inventoryProviders.forTenant(tenantId);

    // ── 4. Write header + lines and hand off to the provider inside ONE tx ──
    const receiptId = await this.prisma.$transaction(async (tx) => {
      const seq = await nextDocumentNumber(tx, tenantId, 'RECEIPT');
      const receiptNumber = `RCV-${padSequence(seq)}`;
      const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();

      const receipt = await tx.inventoryReceipt.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          supplierId: dto.supplierId ?? null,
          receiptNumber,
          receivedAt,
          invoiceReference: dto.invoiceReference ?? null,
          grnReference: dto.grnReference ?? null,
          notes: dto.notes ?? null,
          createdByUserId,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
      });

      const providerLines: ReceiveStockLine[] = [];
      for (const line of dto.lines) {
        const inserted = await tx.inventoryReceiptLine.create({
          data: {
            tenantId,
            receiptId: receipt.id,
            productId: line.productId,
            productVariantId: line.productVariantId ?? null,
            quantityReceived: line.quantityReceived,
            unitCost: line.unitCost,
            lotNumber: line.lotNumber ?? null,
            expiryDate: line.expiryDate ? new Date(line.expiryDate) : null,
          },
        });
        providerLines.push({
          productId: line.productId,
          productVariantId: line.productVariantId ?? null,
          productName: productMap.get(line.productId)?.name ?? line.productId,
          variantSku: null,
          quantity: Number(line.quantityReceived),
          unitCost: Number(line.unitCost),
          receiptLineId: inserted.id,
        });
      }

      const outcomes = await inventory.receiveStock(
        tx,
        { tenantId, branchId: dto.branchId },
        providerLines,
        { receiptId: receipt.id, createdByUserId },
      );

      // ── 5. Refresh the tenant-wide cost mirror + latest-cost snapshot ──
      // The provider updated BranchInventory.averageCost per cell; the mirror
      // on ProductVariant.averageCost (or Product.averageCost for legacy
      // variant-less lines) is the tenant-wide roll-up, which is the sum-of-
      // (qty × avg) across every branch divided by sum-of-qty.
      const seenVariantIds = new Set<string>();
      const seenProductIds = new Set<string>();
      for (const [index, line] of dto.lines.entries()) {
        const outcome = outcomes[index];
        if (line.productVariantId) {
          if (!seenVariantIds.has(line.productVariantId)) {
            seenVariantIds.add(line.productVariantId);
            const rollup = await computeVariantAverage(
              tx,
              tenantId,
              line.productVariantId,
            );
            await tx.productVariant.update({
              where: { id: line.productVariantId },
              data: {
                averageCost: rollup,
                costPrice: line.unitCost,
              },
            });
          }
        } else {
          if (!seenProductIds.has(line.productId)) {
            seenProductIds.add(line.productId);
            const rollup = await computeProductAverage(tx, tenantId, line.productId);
            await tx.product.update({
              where: { id: line.productId },
              data: {
                averageCost: rollup,
                costPrice: line.unitCost,
              },
            });
          }
        }
        // Suppress unused-var warning without dropping the outcome — the mirror
        // read above is authoritative; `outcome` is the per-line snapshot the
        // response echoes back, and the read below of the persisted receipt
        // will surface it via BranchInventory.
        void outcome;
      }

      // ── 6. Audit ONE row per receipt (returns.repository.ts:342-358 idiom) ──
      const totalQty = providerLines.reduce((s, l) => s + l.quantity, 0);
      const totalValue = providerLines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: createdByUserId,
          action: 'INVENTORY_RECEIVED',
          entityType: 'InventoryReceipt',
          entityId: receipt.id,
          metadata: {
            receiptNumber: receipt.receiptNumber,
            branchId: dto.branchId,
            supplierId: dto.supplierId ?? null,
            lineCount: providerLines.length,
            totalQty,
            totalValue,
          } as Prisma.InputJsonValue,
        },
      });

      return receipt.id;
    });

    return this.readReceiptResponse(tenantId, receiptId);
  }

  async listReceipts(tenantId: string, query: QueryReceiptsDto) {
    const { items, total } = await this.repo.list(tenantId, query);
    return {
      items: items.map((row) => ({
        id: row.id,
        receiptNumber: row.receiptNumber,
        branchId: row.branchId,
        branchName: row.branch.name,
        supplierId: row.supplierId,
        supplierName: row.supplier?.name ?? null,
        receivedAt: row.receivedAt,
        invoiceReference: row.invoiceReference,
        grnReference: row.grnReference,
        lineCount: row._count.lines,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async getReceipt(tenantId: string, id: string): Promise<ReceiptResponse> {
    return this.readReceiptResponse(tenantId, id);
  }

  private async readReceiptResponse(
    tenantId: string,
    id: string,
  ): Promise<ReceiptResponse> {
    const row = await this.repo.findWithLines(tenantId, id);
    if (!row) throw new NotFoundException(`Receipt ${id} not found`);

    // For the GET path we don't want to re-run `receiveStock`, so the per-line
    // "after" snapshot is read straight off BranchInventory + StockMovement.
    // The most recent RECEIPT movement carries the balance and unit cost the
    // caller committed, so its `balanceAfter` is the truth for the response.
    const lineIds = row.lines.map((l) => l.id);
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        tenantId,
        refType: 'INVENTORY_RECEIPT_LINE',
        refId: { in: lineIds },
      },
      select: { refId: true, balanceAfter: true, unitCost: true },
    });
    const movementByLineId = new Map(
      movements
        .filter((m): m is { refId: string; balanceAfter: Prisma.Decimal; unitCost: Prisma.Decimal | null } => !!m.refId)
        .map((m) => [m.refId, m]),
    );

    // The average-after for each line is best-effort read from BranchInventory
    // because the movement ledger does not carry the recomputed average.
    const branchInventoryKey = (
      productId: string,
      productVariantId: string | null,
    ): string => `${productVariantId ?? `p:${productId}`}`;

    const inventories = await this.prisma.branchInventory.findMany({
      where: {
        tenantId,
        branchId: row.branchId,
        OR: row.lines.map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId ?? null,
        })),
      },
      select: {
        productId: true,
        productVariantId: true,
        quantityOnHand: true,
        averageCost: true,
      },
    });
    const invByKey = new Map(
      inventories.map((i) => [
        branchInventoryKey(i.productId, i.productVariantId),
        i,
      ]),
    );

    return {
      id: row.id,
      receiptNumber: row.receiptNumber,
      tenantId: row.tenantId,
      branchId: row.branchId,
      branchName: row.branch.name,
      supplierId: row.supplierId,
      supplierName: row.supplier?.name ?? null,
      receivedAt: row.receivedAt,
      invoiceReference: row.invoiceReference,
      grnReference: row.grnReference,
      notes: row.notes,
      createdByUserId: row.createdByUserId,
      createdByUserName: row.createdBy?.name ?? null,
      createdAt: row.createdAt,
      lines: row.lines.map((line) => {
        const movement = movementByLineId.get(line.id);
        const inv = invByKey.get(branchInventoryKey(line.productId, line.productVariantId));
        return {
          id: line.id,
          productId: line.productId,
          productVariantId: line.productVariantId,
          quantityReceived: line.quantityReceived.toString(),
          unitCost: line.unitCost.toString(),
          lotNumber: line.lotNumber,
          expiryDate: line.expiryDate,
          quantityOnHandAfter:
            movement != null ? Number(movement.balanceAfter) : Number(inv?.quantityOnHand ?? 0),
          averageCostAfter: inv?.averageCost != null ? Number(inv.averageCost) : Number(line.unitCost),
        };
      }),
    };
  }
}

/**
 * Tenant-wide weighted-average roll-up for a variant across all its branches.
 *
 * A pure repo-scoped read on `tx` so the recompute happens in the same
 * snapshot as the provider's per-branch update. When no branch carries any
 * quantity yet the fallback is the freshly-received unit cost (the caller
 * would otherwise have to invent an ad-hoc value).
 */
async function computeVariantAverage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productVariantId: string,
): Promise<number | null> {
  const rows = await tx.branchInventory.findMany({
    where: { tenantId, productVariantId },
    select: { quantityOnHand: true, averageCost: true },
  });
  return weightedMean(rows);
}

async function computeProductAverage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
): Promise<number | null> {
  const rows = await tx.branchInventory.findMany({
    where: { tenantId, productId, productVariantId: null },
    select: { quantityOnHand: true, averageCost: true },
  });
  return weightedMean(rows);
}

/**
 * Sum-of-(qty × avg) ÷ sum-of-qty across cells.
 *
 * Returns null when there is nothing on hand anywhere — the caller writes
 * `averageCost = NULL` in that case, which is the schema's "never received"
 * sentinel and lets the next receipt seed it fresh (`computeWeightedAverage`
 * handles the NULL branch cleanly).
 */
function weightedMean(
  rows: { quantityOnHand: Prisma.Decimal; averageCost: Prisma.Decimal | null }[],
): number | null {
  let totalQty = 0;
  let weighted = 0;
  for (const row of rows) {
    const qty = Number(row.quantityOnHand);
    if (qty <= 0) continue;
    const avg = row.averageCost != null ? Number(row.averageCost) : null;
    if (avg === null) continue;
    totalQty += qty;
    weighted += qty * avg;
  }
  if (totalQty === 0) return null;
  return computeWeightedAverage(0, null, totalQty, weighted / totalQty);
}
