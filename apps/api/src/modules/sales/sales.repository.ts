import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma, Product } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import { ComputedLine, PersistSaleInput, SalesListFilter } from './sales.types';

export type SaleWithRelations = Prisma.SaleGetPayload<{
  include: {
    items: true;
    payments: true;
    customer: true;
    branch: { select: { id: true; name: true; code: true; address: true; phone: true } };
    register: { select: { id: true; name: true; code: true } };
    cashier: { select: { id: true; name: true } };
  };
}>;

/** Sale row for the history list: base fields + names, payment methods, item count. */
export type SaleListRow = Prisma.SaleGetPayload<{
  include: {
    customer: { select: { name: true } };
    cashier: { select: { name: true } };
    payments: { select: { method: true; createdAt: true } };
    markedPaidBy: { select: { name: true } };
    _count: { select: { items: true } };
  };
}>;

const saleInclude = {
  items: true,
  payments: true,
  customer: true,
  branch: { select: { id: true, name: true, code: true, address: true, phone: true } },
  register: { select: { id: true, name: true, code: true } },
  cashier: { select: { id: true, name: true } },
  markedPaidBy: { select: { name: true } },
} as const;

const saleListInclude = {
  customer: { select: { name: true } },
  cashier: { select: { name: true } },
  payments: { select: { method: true, createdAt: true } },
  markedPaidBy: { select: { name: true } },
  _count: { select: { items: true } },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncQueue: SyncQueueService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async findManyByTenant(
    tenantId: string,
    filter: SalesListFilter,
    skip: number,
    take: number,
  ): Promise<[SaleListRow[], number]> {
    // Sales are filtered and ordered by their BUSINESS date, not the row's
    // creation timestamp: a backdated sale must appear in the period it was
    // dated to, which is what the list and the PDF report both display. Drafts
    // have no `completedAt`, so they fall back to `createdAt`.
    const businessDate: Prisma.SaleWhereInput['AND'] =
      filter.dateFrom || filter.dateTo
        ? [
            {
              OR: [
                {
                  completedAt: {
                    ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
                    ...(filter.dateTo ? { lte: filter.dateTo } : {}),
                  },
                },
                {
                  completedAt: null,
                  createdAt: {
                    ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
                    ...(filter.dateTo ? { lte: filter.dateTo } : {}),
                  },
                },
              ],
            },
          ]
        : [];

    const where: Prisma.SaleWhereInput = {
      tenantId,
      ...(filter.syncStatus ? { syncStatus: filter.syncStatus } : {}),
      // UNPAID means "still on credit": every sale the list shows as Credit, so
      // both wholly unpaid and part-paid, and never one the customer's account
      // has since cleared. PAID means the opposite — paid at the till, or covered
      // by an account settlement. PARTIAL is still accepted on its own for a
      // caller that genuinely wants just those.
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      // These mirror what the badge says, or the list would contradict itself:
      // "Credit" is a sale nobody has accounted for, and "Paid" is one that was
      // paid at the till, covered when the account cleared, OR ticked off on the
      // customer page.
      ...(filter.paymentStatus === 'UNPAID'
        ? {
            paymentStatus: { in: ['UNPAID', 'PARTIAL'] as PaymentStatus[] },
            creditSettledAt: null,
            markedPaidAt: null,
          }
        : filter.paymentStatus === 'PAID'
          ? {
              OR: [
                { paymentStatus: 'PAID' as PaymentStatus },
                { creditSettledAt: { not: null } },
                { markedPaidAt: { not: null } },
              ],
            }
          : filter.paymentStatus
            ? { paymentStatus: filter.paymentStatus }
            : {}),
      // Kept in AND so the date clause's OR cannot collide with the search OR.
      ...(businessDate.length ? { AND: businessDate } : {}),
      // Overdue: the due date has passed and money is still owed. A settled sale
      // is never overdue whatever its date, and one with no due date — a sale
      // paid in full at the till — is not owed at all, so it cannot be late.
      ...(filter.overdueAsOf
        ? {
            paymentDueDate: { not: null, lt: filter.overdueAsOf },
            paymentStatus: { in: ['UNPAID', 'PARTIAL'] as PaymentStatus[] },
            // An invoice that has been accounted for is not overdue, whatever
            // its own due date says.
            creditSettledAt: null,
            markedPaidAt: null,
            status: 'COMPLETED' as const,
          }
        : {}),
      ...(filter.search
        ? {
            OR: [
              { saleNumber: { contains: filter.search, mode: 'insensitive' } },
              { customer: { is: { name: { contains: filter.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    return this.prisma.$transaction([
      this.prisma.sale.findMany({
        where,
        include: saleListInclude,
        // Newest business date first. Drafts have no business date yet; they
        // surface at the top rather than the bottom because a draft is a held
        // sale someone is meant to come back to, and burying it past the last
        // page of history would hide it entirely.
        orderBy: [{ completedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.sale.count({ where }),
    ]);
  }

  findByIdForTenant(tenantId: string, id: string): Promise<SaleWithRelations | null> {
    return this.prisma.sale.findFirst({ where: { id, tenantId }, include: saleInclude });
  }

  findDraftWithItems(tenantId: string, id: string): Promise<SaleWithRelations | null> {
    return this.prisma.sale.findFirst({
      where: { id, tenantId, status: 'DRAFT' },
      include: saleInclude,
    });
  }

  findProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
    return this.prisma.product.findMany({ where: { tenantId, id: { in: ids } } });
  }

  branchExists(tenantId: string, branchId: string): Promise<{ id: string } | null> {
    return this.prisma.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
  }

  registerExists(tenantId: string, registerId: string): Promise<{ id: string } | null> {
    return this.prisma.register.findFirst({
      where: { id: registerId, tenantId },
      select: { id: true },
    });
  }

  customerExists(tenantId: string, customerId: string): Promise<{ id: string } | null> {
    return this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { id: true },
    });
  }


  /**
   * How many OTHER invoices on this customer's account are still uncovered and
   * unticked — i.e. would remain visible as owed if `exceptSaleId` were ticked.
   */
  countUnmarkedCredit(tenantId: string, customerId: string, exceptSaleId: string): Promise<number> {
    return this.prisma.sale.count({
      where: {
        tenantId,
        customerId,
        id: { not: exceptSaleId },
        status: 'COMPLETED',
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] as PaymentStatus[] },
        creditSettledAt: null,
        markedPaidAt: null,
      },
    });
  }

  /** Tick an invoice off, or clear the tick. Touches no money. */
  setMarkedPaid(
    tenantId: string,
    saleId: string,
    mark: { at: Date; byUserId: string } | null,
  ): Promise<SaleWithRelations> {
    return this.prisma.sale.update({
      where: { id: saleId },
      data: {
        markedPaidAt: mark?.at ?? null,
        markedPaidByUserId: mark?.byUserId ?? null,
      },
      include: saleInclude,
    });
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** Persist a new DRAFT sale (no payments, no sync job). */
  async createDraft(input: {
    tenantId: string;
    cashierId: string;
    branchId: string;
    registerId?: string | null;
    customerId?: string | null;
    computed: PersistSaleInput['computed'];
  }): Promise<SaleWithRelations> {
    const saleNumber = await this.nextSaleNumber(this.prisma, input.tenantId);
    const sale = await this.prisma.sale.create({
      data: {
        tenantId: input.tenantId,
        cashierId: input.cashierId,
        branchId: input.branchId,
        registerId: input.registerId ?? null,
        customerId: input.customerId ?? null,
        saleNumber,
        status: 'DRAFT',
        subtotal: input.computed.subtotal,
        totalDiscount: input.computed.totalDiscount,
        orderDiscountType: input.computed.orderDiscountType,
        orderDiscountValue: input.computed.orderDiscountValue,
        orderDiscountAmount: input.computed.orderDiscountAmount,
        orderDiscountReason: input.computed.orderDiscountReason,
        orderDiscountApprovedById: input.computed.orderDiscountApprovedById,
        taxAmount: input.computed.taxAmount,
        total: input.computed.total,
        paidAmount: 0,
        balanceAmount: input.computed.total,
        paymentStatus: 'UNPAID',
        syncStatus: 'NOT_SYNCED',
        items: { create: input.computed.lines.map(toSaleItemCreate) },
      },
      include: saleInclude,
    });
    return sale;
  }

  /** Persist a new COMPLETED sale with payments and an outbound sync job. */
  async createCompleted(input: PersistSaleInput): Promise<SaleWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const saleNumber = await this.nextSaleNumber(tx, input.tenantId);
      const sale = await tx.sale.create({
        data: {
          tenantId: input.tenantId,
          cashierId: input.cashierId,
          branchId: input.branchId,
          registerId: input.registerId ?? null,
          customerId: input.customerId ?? null,
          saleNumber,
          status: 'COMPLETED',
          completedAt: input.saleDate,
          paymentDueDate: input.paymentDueDate,
          subtotal: input.computed.subtotal,
          totalDiscount: input.computed.totalDiscount,
          ...orderDiscountData(input.computed),
          taxAmount: input.computed.taxAmount,
          total: input.computed.total,
          paidAmount: input.paidAmount,
          balanceAmount: input.balanceAmount,
          paymentStatus: input.paymentStatus,
          quickbooksDocumentType: input.quickbooksDocumentType,
          syncStatus: 'PENDING',
          items: { create: input.computed.lines.map(toSaleItemCreate) },
          payments: {
            create: input.payments.map((p) => ({
              tenantId: input.tenantId,
              method: p.method,
              amount: p.amount,
              reference: p.reference ?? null,
              syncStatus: 'NOT_SYNCED' as const,
            })),
          },
        },
        include: saleInclude,
      });
      await this.decrementStock(tx, input.tenantId, input.computed.lines);
      await this.syncQueue.enqueueSaleSync(tx, input.tenantId, sale.id);
      return sale;
    });
  }

  /** Convert an existing DRAFT into a COMPLETED sale (items recomputed). */
  async completeDraft(
    tenantId: string,
    saleId: string,
    input: PersistSaleInput,
  ): Promise<SaleWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      await tx.saleItem.deleteMany({ where: { saleId } });
      const sale = await tx.sale.update({
        where: { id: saleId },
        data: {
          status: 'COMPLETED',
          completedAt: input.saleDate,
          paymentDueDate: input.paymentDueDate,
          customerId: input.customerId ?? null,
          subtotal: input.computed.subtotal,
          totalDiscount: input.computed.totalDiscount,
          ...orderDiscountData(input.computed),
          taxAmount: input.computed.taxAmount,
          total: input.computed.total,
          paidAmount: input.paidAmount,
          balanceAmount: input.balanceAmount,
          paymentStatus: input.paymentStatus,
          quickbooksDocumentType: input.quickbooksDocumentType,
          syncStatus: 'PENDING',
          items: { create: input.computed.lines.map(toSaleItemCreate) },
          payments: {
            create: input.payments.map((p) => ({
              tenantId,
              method: p.method,
              amount: p.amount,
              reference: p.reference ?? null,
              syncStatus: 'NOT_SYNCED' as const,
            })),
          },
        },
        include: saleInclude,
      });
      await this.decrementStock(tx, tenantId, input.computed.lines);
      await this.syncQueue.enqueueSaleSync(tx, tenantId, sale.id);
      return sale;
    });
  }

  /**
   * Decrement on-hand stock for tracked products within the sale transaction.
   * The conditional update is the authoritative guard against overselling under
   * concurrency; a zero-row update rolls the whole sale back.
   */
  private async decrementStock(
    tx: Prisma.TransactionClient,
    tenantId: string,
    lines: ComputedLine[],
  ): Promise<void> {
    // Aggregate per product: a cart may repeat the same productId across lines.
    const totals = new Map<string, { name: string; qty: number }>();
    for (const line of lines) {
      if (!line.trackInventory) continue;
      const prev = totals.get(line.productId);
      totals.set(line.productId, {
        name: line.productName,
        qty: (prev?.qty ?? 0) + line.quantity,
      });
    }
    for (const [productId, { name, qty }] of totals) {
      const res = await tx.product.updateMany({
        where: { id: productId, tenantId, quantityOnHand: { gte: qty } },
        data: { quantityOnHand: { decrement: qty } },
      });
      if (res.count === 0) {
        throw new BadRequestException(`Insufficient stock for ${name}`);
      }
    }
  }

  /**
   * MOCK QuickBooks push. Marks the sale + payments SYNCED, assigns mock QBO
   * document/payment ids, and closes the sync job. Real QBO calls come later.
   */
  async markSynced(sale: SaleWithRelations): Promise<SaleWithRelations> {
    const prefix = sale.quickbooksDocumentType === 'SALES_RECEIPT' ? 'SR' : 'INV';
    const qboDocId = sale.quickbooksDocumentId ?? `QBO-${prefix}-${sale.saleNumber}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.sale.update({
        where: { id: sale.id },
        data: { syncStatus: 'SYNCED', quickbooksDocumentId: qboDocId, syncError: null },
      });
      for (const [i, p] of sale.payments.entries()) {
        await tx.payment.update({
          where: { id: p.id },
          data: {
            syncStatus: 'SYNCED',
            quickbooksPaymentId: p.quickbooksPaymentId ?? `QBO-PMT-${sale.saleNumber}-${i + 1}`,
          },
        });
      }
      await tx.syncJob.updateMany({
        where: {
          tenantId: sale.tenantId,
          entityType: 'SALE',
          entityId: sale.id,
          status: { in: ['PENDING', 'SYNCING', 'FAILED'] },
        },
        data: { status: 'SYNCED', completedAt: new Date() },
      });
      await tx.syncLog.create({
        data: {
          tenantId: sale.tenantId,
          entityType: 'SALE',
          entityId: sale.id,
          direction: 'OUTBOUND',
          status: 'SYNCED',
          message: `Mock QuickBooks sync: ${sale.quickbooksDocumentType} ${qboDocId}`,
        },
      });
      return tx.sale.findFirstOrThrow({ where: { id: sale.id }, include: saleInclude });
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async nextSaleNumber(
    client: Prisma.TransactionClient | PrismaService,
    tenantId: string,
  ): Promise<string> {
    return `S-${padSequence(await nextDocumentNumber(client, tenantId, 'SALE'))}`;
  }
}

/** Order-level discount columns shared by the completed-sale writers. */
function orderDiscountData(computed: PersistSaleInput['computed']) {
  return {
    orderDiscountType: computed.orderDiscountType,
    orderDiscountValue: computed.orderDiscountValue,
    orderDiscountAmount: computed.orderDiscountAmount,
    orderDiscountReason: computed.orderDiscountReason,
    orderDiscountApprovedById: computed.orderDiscountApprovedById,
  };
}

function toSaleItemCreate(line: ComputedLine): Prisma.SaleItemCreateWithoutSaleInput {
  return {
    product: { connect: { id: line.productId } },
    productName: line.productName,
    sku: line.sku,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    discountType: line.discountType,
    discountBasis: line.discountBasis,
    discountValue: line.discountValue,
    discountAmount: line.discountAmount,
    discountReason: line.discountReason,
    ...(line.approvedByUserId
      ? { approvedBy: { connect: { id: line.approvedByUserId } } }
      : {}),
    taxAmount: line.taxAmount,
    lineSubtotal: line.lineSubtotal,
    lineTotal: line.lineTotal,
  };
}
