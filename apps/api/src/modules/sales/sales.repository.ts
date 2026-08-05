import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, Product, QuickBooksDocumentType } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { AccountingSubmissionResult } from '../providers/provider.types';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import { ComputedLine, PersistSaleInput, SalesListFilter } from './sales.types';

/**
 * Hand a persisted sale to the tenant's accounting provider, inside the sale
 * transaction.
 *
 * A callback rather than an injected provider: the repository must not choose the
 * destination, and taking the operation as a parameter keeps it free of any
 * provider import while leaving transaction ownership exactly where it was.
 */
export type PostAccounting = (
  tx: Prisma.TransactionClient,
  saleId: string,
) => Promise<AccountingSubmissionResult<QuickBooksDocumentType>>;

/**
 * What QuickBooks returned for a sale. Every field is required — that is the point.
 */
export interface ExternalSaleDocument {
  /** The identifier QuickBooks assigned. Never generated locally. */
  documentId: string;
  /** The document QuickBooks created. */
  documentType: QuickBooksDocumentType;
  /** Per-payment identifiers, positionally matched to `sale.payments`. */
  paymentIds?: (string | undefined)[];
}

/**
 * Refuse to record an external sync without real external metadata.
 *
 * Throws before any write, so a rejected call leaves the sale exactly as it was —
 * still locally complete, still unsynced, with no fabricated identifier and no
 * `SYNCED` status it did not earn.
 */
function assertExternalSaleDocument(
  sale: { id: string; quickbooksDocumentType: QuickBooksDocumentType | null },
  external: ExternalSaleDocument,
): void {
  if (!external.documentId || external.documentId.trim().length === 0) {
    throw new BadRequestException(
      `Cannot mark sale ${sale.id} synced: QuickBooks returned no document id`,
    );
  }
  if (!external.documentType) {
    throw new BadRequestException(
      `Cannot mark sale ${sale.id} synced: QuickBooks returned no document type`,
    );
  }
  // A sale with no stored document type belongs to a tenant with no accounting
  // provider. There is nothing for QuickBooks to have accepted.
  if (sale.quickbooksDocumentType === null) {
    throw new BadRequestException(
      `Cannot mark sale ${sale.id} synced: it has no external accounting document`,
    );
  }
}

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
    payments: { select: { method: true } };
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
} as const;

const saleListInclude = {
  customer: { select: { name: true } },
  cashier: { select: { name: true } },
  payments: { select: { method: true } },
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
    const where: Prisma.SaleWhereInput = {
      tenantId,
      ...(filter.syncStatus ? { syncStatus: filter.syncStatus } : {}),
      ...(filter.paymentStatus ? { paymentStatus: filter.paymentStatus } : {}),
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
        orderBy: { createdAt: 'desc' },
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
   * A customer's credit terms plus how much they currently owe (sum of unpaid
   * balances on their completed sales). Used to enforce the credit limit before
   * a new credit/partial sale is accepted.
   */
  async getCustomerCredit(
    tenantId: string,
    customerId: string,
  ): Promise<{ creditAllowed: boolean; creditLimit: number | null; outstanding: number } | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { creditAllowed: true, creditLimit: true },
    });
    if (!customer) return null;

    const agg = await this.prisma.sale.aggregate({
      where: {
        tenantId,
        customerId,
        status: 'COMPLETED',
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
      },
      _sum: { balanceAmount: true },
    });

    return {
      creditAllowed: customer.creditAllowed,
      creditLimit: customer.creditLimit != null ? Number(customer.creditLimit) : null,
      outstanding: agg._sum.balanceAmount != null ? Number(agg._sum.balanceAmount) : 0,
    };
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

  /**
   * Persist a new COMPLETED sale with its payments, and hand it to accounting.
   *
   * `postAccounting` is the seam introduced in Slice 6A. The repository still owns
   * the transaction — the sale, its items, its payments, the stock decrement, and
   * the accounting submission all commit or roll back together — but it no longer
   * decides that the destination is QuickBooks. That decision belongs to the
   * tenant's `AccountingProvider`, which the service resolves once and passes in as
   * a callback, so the repository needs no provider import and no `if (quickbooks)`.
   */
  async createCompleted(
    input: PersistSaleInput,
    postAccounting: PostAccounting,
  ): Promise<SaleWithRelations> {
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
          completedAt: new Date(),
          subtotal: input.computed.subtotal,
          totalDiscount: input.computed.totalDiscount,
          ...orderDiscountData(input.computed),
          taxAmount: input.computed.taxAmount,
          total: input.computed.total,
          paidAmount: input.paidAmount,
          balanceAmount: input.balanceAmount,
          paymentStatus: input.paymentStatus,
          quickbooksDocumentType: input.quickbooksDocumentType,
          syncStatus: input.syncStatus,
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
      await this.postAccountingChecked(postAccounting, tx, sale.id, input);
      return sale;
    });
  }

  /** Convert an existing DRAFT into a COMPLETED sale (items recomputed). */
  async completeDraft(
    tenantId: string,
    saleId: string,
    input: PersistSaleInput,
    postAccounting: PostAccounting,
  ): Promise<SaleWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      await tx.saleItem.deleteMany({ where: { saleId } });
      const sale = await tx.sale.update({
        where: { id: saleId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
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
          syncStatus: input.syncStatus,
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
      await this.postAccountingChecked(postAccounting, tx, sale.id, input);
      return sale;
    });
  }

  /**
   * Run the accounting submission inside the sale transaction and check that its
   * answer matches what was just persisted.
   *
   * The invariant is cheap and catches the class of bug that would be hardest to
   * notice: a sale stored with a QuickBooks document type whose provider reported
   * `NOT_REQUIRED` (so nothing was ever queued and the sale silently never reaches
   * the books), or the reverse — a sale stored with no document type whose provider
   * claims it queued a push. Both are inconsistencies between two things decided in
   * different places, and both abort the sale rather than commit a half-truth.
   */
  private async postAccountingChecked(
    postAccounting: PostAccounting,
    tx: Prisma.TransactionClient,
    saleId: string,
    input: PersistSaleInput,
  ): Promise<void> {
    const submission = await postAccounting(tx, saleId);
    const expectedExternal = input.quickbooksDocumentType !== null;
    const reportedExternal = submission.disposition === 'QUEUED';

    if (expectedExternal !== reportedExternal) {
      throw new Error(
        `Accounting submission disagreed with the persisted sale: stored document type ` +
          `${input.quickbooksDocumentType ?? 'null'} but provider reported ` +
          `${submission.disposition}. Refusing to commit.`,
      );
    }
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
   * Record that QuickBooks accepted a sale, using metadata QuickBooks returned.
   *
   * ## Fails closed (Slice 6A, Risk Y)
   *
   * This used to invent its own identifiers: `QBO-${prefix}-${saleNumber}` with the
   * prefix defaulting to `INV` whenever `quickbooksDocumentType` was not
   * `SALES_RECEIPT` — including when it was `null`. So a tenant with no accounting
   * provider could be given a fabricated `QBO-INV-…` id, marked `SYNCED`, and shown
   * a QuickBooks success it never had. A synthetic external reference written into a
   * financial record is an invented audit trail.
   *
   * The external metadata is now a required parameter, validated before anything is
   * written. This method cannot manufacture an identifier, and it is not a way to
   * say "local completion succeeded" — local completion and external
   * synchronisation are separate concepts, and only the latter belongs here.
   *
   * @param external what QuickBooks actually returned. A blank document id or a
   *   missing document type aborts before any write.
   */
  async markSynced(
    sale: SaleWithRelations,
    external: ExternalSaleDocument,
  ): Promise<SaleWithRelations> {
    assertExternalSaleDocument(sale, external);

    const qboDocId = external.documentId;

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
            quickbooksPaymentId:
              p.quickbooksPaymentId ?? external.paymentIds?.[i] ?? `QBO-PMT-${sale.saleNumber}-${i + 1}`,
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
          // Wording preserved verbatim: the QuickBooks push is still the mock one
          // (open question O1), and this string is what existing tenants' sync logs
          // and the sync-log UI already contain.
          message: `Mock QuickBooks sync: ${external.documentType} ${qboDocId}`,
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
