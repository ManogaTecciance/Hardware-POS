import { Injectable } from '@nestjs/common';
import { PrintJob, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import { PersistReturnInput, ReturnsListFilter } from './returns.types';

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
    originalSale: { select: { saleNumber: true } };
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
  originalSale: { select: { saleNumber: true } },
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncQueue: SyncQueueService,
  ) {}

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
   * payment, the per-line and per-sale return-status roll-up, the outbound
   * QuickBooks sync job, and an audit log — all in one transaction. On failure the
   * whole thing rolls back and nothing is written.
   */
  async createCompleted(input: PersistReturnInput): Promise<ReturnWithRelations> {
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
          syncStatus: 'PENDING',
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          items: {
            create: input.items.map((it) => ({
              originalSaleItemId: it.originalSaleItemId,
              productId: it.productId,
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

      // Eager local restock — symmetric with how a sale decrements stock on
      // completion. GOOD items marked RETURN_TO_STOCK re-enter available
      // inventory the instant the return completes; damaged / opened /
      // non-resellable stock never restocks, and only Inventory-type products
      // are stock-tracked. This is deliberately DECOUPLED from the QuickBooks
      // push (which stays async/retryable) so local inventory is correct
      // regardless of QuickBooks connectivity. QuickBooks remains the source of
      // truth; the periodic product pull reconciles to its absolute quantities.
      for (const it of input.items) {
        if (it.itemCondition === 'GOOD' && it.stockDisposition === 'RETURN_TO_STOCK') {
          await tx.product.updateMany({
            where: { id: it.productId, tenantId: input.tenantId, type: 'Inventory' },
            data: { quantityOnHand: { increment: Number(it.returnQuantity) } },
          });
        }
      }

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

      await this.syncQueue.enqueueReturnSync(tx, input.tenantId, created.id);

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
