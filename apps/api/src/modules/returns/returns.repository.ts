import { Injectable } from '@nestjs/common';
import { PrintJob, Prisma, QuickBooksReturnDocumentType } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { AccountingSubmissionResult, StockLine } from '../providers/provider.types';
import { PersistReturnInput, ReturnsListFilter } from './returns.types';

/**
 * Hand a persisted return to the accounting provider the **original sale** was
 * filed under, inside the return transaction.
 *
 * A callback for the same reason as `PostAccounting` on the sale side: the
 * repository keeps owning the transaction but stops deciding the destination, so
 * it needs no provider import and no `if (quickbooks)`.
 */
export type PostReturnAccounting = (
  tx: Prisma.TransactionClient,
  returnId: string,
) => Promise<AccountingSubmissionResult<QuickBooksReturnDocumentType>>;

/**
 * Restore stock for the return lines the caller has already decided are eligible,
 * inside the return transaction.
 *
 * The caller passes only eligible lines. Whether an item is GOOD, DAMAGED, OPENED
 * or marked RETURN_TO_STOCK is **return-domain** logic and stays in
 * `ReturnsService`; an inventory provider must not be given condition or
 * disposition to reason about, or two layers end up owning the same rule.
 */
export type RestoreStock = (
  tx: Prisma.TransactionClient,
  lines: StockLine[],
  /** 1a.21 — the return this restock belongs to, for the ledger's `refId`. */
  returnId: string,
) => Promise<void>;

/** A return with everything the detail screen and receipt need. */
export type ReturnWithRelations = Prisma.ReturnGetPayload<{
  include: {
    items: true;
    refundPayments: true;
    tenant: { select: { name: true } };
    originalSale: {
      select: {
        id: true;
        saleNumber: true;
        total: true;
        returnedAmount: true;
        paymentStatus: true;
      };
    };
    customer: { select: { id: true; name: true; phone: true } };
    createdBy: { select: { id: true; name: true } };
    approvedBy: { select: { id: true; name: true } };
    branch: { select: { id: true; name: true } };
    register: { select: { id: true; name: true } };
  };
}>;

/** A return row for the history list. */
export type ReturnListRow = Prisma.ReturnGetPayload<{
  include: {
    originalSale: { select: { saleNumber: true; paymentStatus: true } };
    customer: { select: { name: true } };
    createdBy: { select: { name: true } };
    _count: { select: { items: true } };
  };
}>;

/** The original sale + lines needed to validate and price a return. */
export type SaleForReturn = Prisma.SaleGetPayload<{
  include: {
    items: {
      include: {
        product: {
          select: {
            id: true;
            name: true;
            sku: true;
            type: true;
          };
        };
      };
    };
    customer: true;
    payments: true;
    branch: true;
    register: true;
    tenant: true;
  };
}>;

const returnInclude = {
  items: true,
  refundPayments: true,
  tenant: { select: { name: true } },
  originalSale: {
    select: { id: true, saleNumber: true, total: true, returnedAmount: true, paymentStatus: true },
  },
  customer: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
  register: { select: { id: true, name: true } },
} satisfies Prisma.ReturnInclude;

const returnListInclude = {
  // `paymentStatus` is read so the list row can derive its LOCAL document kind
  // without a second query — the same decision the receipt makes.
  originalSale: { select: { saleNumber: true, paymentStatus: true } },
  customer: { select: { name: true } },
  createdBy: { select: { name: true } },
  _count: { select: { items: true } },
} satisfies Prisma.ReturnInclude;

const saleForReturnInclude = {
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true, type: true } },
    },
  },
  customer: true,
  payments: true,
  branch: true,
  register: true,
  tenant: true,
} satisfies Prisma.SaleInclude;

/** Threshold for comparing Decimal(12,3) quantities (half of the last digit). */
const QTY_EPSILON = 0.0005;

@Injectable()
export class ReturnsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── reads ────────────────────────────────────────────────────────────────

  findSaleForReturn(tenantId: string, saleId: string): Promise<SaleForReturn | null> {
    return this.prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: saleForReturnInclude,
    });
  }

  findByIdForTenant(tenantId: string, id: string): Promise<ReturnWithRelations | null> {
    return this.prisma.return.findFirst({ where: { id, tenantId }, include: returnInclude });
  }

  findByIdempotencyKey(tenantId: string, key: string): Promise<ReturnWithRelations | null> {
    return this.prisma.return.findFirst({
      where: { tenantId, idempotencyKey: key },
      include: returnInclude,
    });
  }

  findManyByTenant(
    tenantId: string,
    filter: ReturnsListFilter,
    skip: number,
    take: number,
  ): Promise<[ReturnListRow[], number]> {
    const where: Prisma.ReturnWhereInput = {
      tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.refundStatus ? { refundStatus: filter.refundStatus } : {}),
      ...(filter.syncStatus ? { syncStatus: filter.syncStatus } : {}),
      ...(filter.refundMethod ? { refundMethod: filter.refundMethod } : {}),
      ...(filter.originalSaleId ? { originalSaleId: filter.originalSaleId } : {}),
      ...(filter.dateFrom || filter.dateTo
        ? {
            createdAt: {
              ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
              ...(filter.dateTo ? { lte: filter.dateTo } : {}),
            },
          }
        : {}),
      ...(filter.search
        ? {
            OR: [
              { returnNumber: { contains: filter.search, mode: 'insensitive' } },
              { originalSale: { is: { saleNumber: { contains: filter.search, mode: 'insensitive' } } } },
              { customer: { is: { name: { contains: filter.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    return this.prisma.$transaction([
      this.prisma.return.findMany({
        where,
        include: returnListInclude,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.return.count({ where }),
    ]);
  }

  /** Returns for a specific sale, newest first (Sale-detail "Returns" section). */
  findBySale(tenantId: string, saleId: string): Promise<ReturnWithRelations[]> {
    return this.prisma.return.findMany({
      where: { tenantId, originalSaleId: saleId },
      include: returnInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * Persist a COMPLETED return atomically: the Return + its items + the refund
   * payment, the per-line and per-sale return-status roll-up, the local restock,
   * the accounting submission, and an audit log — all in one transaction. On
   * failure the whole thing rolls back and nothing is written.
   *
   * `postAccounting` is the Slice 6B seam. Where this used to call
   * `syncQueue.enqueueReturnSync` unconditionally — which is what made every
   * return QuickBooks-shaped regardless of tenant — it now invokes whatever the
   * caller resolved from the *original sale's* provenance.
   */
  async createCompleted(
    input: PersistReturnInput,
    postAccounting: PostReturnAccounting,
    restoreStock: RestoreStock,
  ): Promise<ReturnWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const returnNumber = await this.nextReturnNumber(tx, input.tenantId);

      const created = await tx.return.create({
        data: {
          tenantId: input.tenantId,
          branchId: input.branchId,
          registerId: input.registerId,
          originalSaleId: input.originalSaleId,
          customerId: input.customerId,
          createdByUserId: input.createdByUserId,
          approvedByUserId: input.approvedByUserId,
          approvalToken: input.approvalToken,
          returnNumber,
          status: 'COMPLETED',
          completedAt: new Date(),
          subtotal: input.subtotal,
          productDiscountAdjustment: input.productDiscountAdjustment,
          orderDiscountAdjustment: input.orderDiscountAdjustment,
          taxAdjustment: input.taxAdjustment,
          refundTotal: input.refundTotal,
          refundMethod: input.refundMethod,
          refundReference: input.refundReference,
          refundStatus: 'COMPLETED',
          quickbooksDocumentType: input.quickbooksDocumentType,
          syncStatus: input.syncStatus,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          items: {
            create: input.items.map((it) => ({
              originalSaleItemId: it.originalSaleItemId,
              productId: it.productId,
              // D99 (1a.20) — these three columns have existed since D44 built
              // them and had never been written.
              //
              // The scalar FK, not `productVariant: { connect }`: `productId` is
              // set as a scalar here, which puts this nested create into Prisma's
              // *unchecked* shape, and that shape accepts foreign keys rather than
              // relations. The connect form typechecked only because it was
              // spread from a conditional — a spread suppresses excess-property
              // checking — and failed at runtime.
              productVariantId: it.productVariantId,
              variantSkuSnapshot: it.variantSkuSnapshot,
              variantNameSnapshot: it.variantNameSnapshot,
              productNameSnapshot: it.productNameSnapshot,
              skuSnapshot: it.skuSnapshot,
              imageUrlSnapshot: it.imageUrlSnapshot,
              originalUnitPrice: it.originalUnitPrice,
              purchasedQuantity: it.purchasedQuantity,
              previouslyReturnedQuantity: it.previouslyReturnedQuantity,
              returnQuantity: it.returnQuantity,
              returnReason: it.returnReason,
              itemCondition: it.itemCondition,
              stockDisposition: it.stockDisposition,
              note: it.note,
              originalLineSubtotal: it.originalLineSubtotal,
              productDiscountAdjustment: it.productDiscountAdjustment,
              orderDiscountAdjustment: it.orderDiscountAdjustment,
              taxAdjustment: it.taxAdjustment,
              refundableAmount: it.refundableAmount,
            })),
          },
          refundPayments: {
            create: [
              {
                tenantId: input.tenantId,
                processedByUserId: input.createdByUserId,
                method: input.refundMethod,
                amount: input.refundTotal,
                reference: input.refundReference,
                metadata: (input.refundMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
                syncStatus: 'NOT_SYNCED',
              },
            ],
          },
        },
        include: returnInclude,
      });

      // Per-line return-status roll-up on the original SaleItems.
      for (const it of input.items) {
        const newReturned = it.previouslyReturnedQuantity + it.returnQuantity;
        const fully = newReturned >= it.purchasedQuantity - QTY_EPSILON;
        await tx.saleItem.update({
          where: { id: it.originalSaleItemId },
          data: {
            returnedQuantity: newReturned,
            returnStatus: fully ? 'FULLY_RETURNED' : 'PARTIALLY_RETURNED',
          },
        });
      }

      // Eager restock — symmetric with how a sale decrements stock on completion,
      // and still DECOUPLED from the QuickBooks push (which stays async/retryable)
      // so stock is correct regardless of QuickBooks connectivity.
      //
      // Slice 6C-A: which lines restock is decided by `ReturnsService` and passed
      // in; where the stock lives is decided by the tenant's `InventoryProvider`.
      // The `type: 'Inventory'` predicate that kept Service products out lives in
      // the provider, unchanged.
      await restoreStock(tx, input.restockLines, created.id);

      // Per-sale return-status roll-up (recomputed from the fresh line states).
      const saleItems = await tx.saleItem.findMany({
        where: { saleId: input.originalSaleId },
        select: { quantity: true, returnedQuantity: true },
      });
      const anyReturned = saleItems.some((si) => Number(si.returnedQuantity) > QTY_EPSILON);
      const allFully = saleItems.every(
        (si) => Number(si.returnedQuantity) >= Number(si.quantity) - QTY_EPSILON,
      );
      const saleReturnStatus = allFully
        ? 'FULLY_RETURNED'
        : anyReturned
          ? 'PARTIALLY_RETURNED'
          : 'NOT_RETURNED';

      await tx.sale.update({
        where: { id: input.originalSaleId },
        data: {
          returnStatus: saleReturnStatus,
          returnedAmount: { increment: input.refundTotal },
          // A fully-returned sale is reflected as REFUNDED for reporting parity.
          ...(allFully ? { status: 'REFUNDED' as const } : {}),
        },
      });

      await this.postAccountingChecked(postAccounting, tx, created.id, input);

      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.createdByUserId,
          action: 'return.completed',
          entityType: 'Return',
          entityId: created.id,
          metadata: {
            returnNumber,
            originalSaleId: input.originalSaleId,
            refundTotal: input.refundTotal,
            refundMethod: input.refundMethod,
            itemCount: input.items.length,
            approvedByUserId: input.approvedByUserId,
          } as Prisma.InputJsonValue,
        },
      });

      return created;
    });
  }

  /**
   * Run the accounting submission inside the return transaction and check that its
   * answer matches what was just persisted.
   *
   * Mirrors the sale-side invariant, and catches the same class of bug: a return
   * stored with a QuickBooks document type whose provider reported `NOT_REQUIRED`
   * (so QuickBooks keeps revenue that was refunded), or a return stored with no
   * document type whose provider claims it queued a push (so a credit note is
   * filed against a sale QuickBooks never saw). Both abort the return rather than
   * commit a half-truth.
   */
  private async postAccountingChecked(
    postAccounting: PostReturnAccounting,
    tx: Prisma.TransactionClient,
    returnId: string,
    input: PersistReturnInput,
  ): Promise<void> {
    const submission = await postAccounting(tx, returnId);
    const expectedExternal = input.quickbooksDocumentType !== null;
    const reportedExternal = submission.disposition === 'QUEUED';

    if (expectedExternal !== reportedExternal) {
      throw new Error(
        `Accounting submission disagreed with the persisted return: stored document type ` +
          `${input.quickbooksDocumentType ?? 'null'} but provider reported ` +
          `${submission.disposition}. Refusing to commit.`,
      );
    }
  }

  /** Create a RETURN_RECEIPT print job (issued at completion and on reprint). */
  createReceiptPrintJob(data: {
    tenantId: string;
    saleId: string;
    returnId: string;
    html: string;
    createdByUserId: string | null;
  }): Promise<PrintJob> {
    return this.prisma.printJob.create({
      data: {
        tenantId: data.tenantId,
        saleId: data.saleId,
        returnId: data.returnId,
        type: 'RETURN_RECEIPT',
        html: data.html,
        createdByUserId: data.createdByUserId,
      },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async nextReturnNumber(
    client: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    return `R-${padSequence(await nextDocumentNumber(client, tenantId, 'RETURN'))}`;
  }
}
