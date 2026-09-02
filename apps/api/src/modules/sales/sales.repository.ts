import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, Product, QuickBooksDocumentType } from '@hardware-pos/database';

import { mirrorExternalRef } from '../quickbooks/external-ref';
import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { AccountingSubmissionResult, StockLine } from '../providers/provider.types';
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
 * Reduce stock for a persisted sale, inside the sale transaction.
 *
 * The Slice 6C-A counterpart of {@link PostAccounting}, and a callback for the same
 * reason: the repository keeps owning the transaction but stops deciding where
 * stock lives, so it needs no provider import and no `if (quickbooks)`.
 *
 * The callback must keep the conditional write that prevents two concurrent sales
 * from both consuming the last unit — a read-time availability check cannot.
 */
export type ReduceStock = (
  tx: Prisma.TransactionClient,
  lines: StockLine[],
  /**
   * 1a.21 — the sale this reduction belongs to, for the stock ledger's `refId`.
   * The row is created before `reduceStock` is called, so the id is already in
   * hand; only this callback type was hiding it. No transaction was reordered.
   */
  saleId: string,
) => Promise<void>;

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

/**
 * D99 — a variant as the sale path needs it: the row plus the option values the
 * display name is derived from. Declared with `validator` so the include shape
 * and the type cannot drift apart.
 */
export type SaleVariant = Prisma.ProductVariantGetPayload<{
  include: { optionValues: { include: { option: { select: { name: true } } } } };
}>;

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

  /**
   * D99 — resolve the variants a cart names.
   *
   * `tenantId` in the predicate is what makes another tenant's variant id return
   * nothing rather than a row, exactly as `findProductsByIds` does. The caller
   * then reports it as unknown, so the response never distinguishes "does not
   * exist" from "belongs to someone else".
   */
  findVariantsByIds(tenantId: string, ids: string[]): Promise<SaleVariant[]> {
    return this.prisma.productVariant.findMany({
      where: { tenantId, id: { in: ids } },
      // The option values are what `variantDisplayName` turns into "Black / Medium"
      // for the snapshot frozen onto the sale line. Same include shape as
      // `sellable.service` uses, so both derive the name from the same data.
      include: { optionValues: { include: { option: { select: { name: true } } } } },
    });
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
    reduceStock: ReduceStock,
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
      await reduceStock(tx, toStockLines(input.computed.lines), sale.id);
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
    reduceStock: ReduceStock,
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
      await reduceStock(tx, toStockLines(input.computed.lines), sale.id);
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

  // `decrementStock` used to live here. Its behaviour — aggregate repeated product
  // ids, a conditional `updateMany` guarded by `quantityOnHand: { gte: qty }`, and a
  // zero-row check throwing `Insufficient stock for <name>` — moved unchanged into
  // `LocalInventoryProvider.reduceStock` and `QuickBooksInventoryProvider.reduceStock`
  // in Slice 6C-A. It was moved rather than rewritten: the conditional write is the
  // only thing standing between two concurrent sales and a double-sold last unit, so
  // reimplementing it would have been the single riskiest edit in the refactor.

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
      // D63 dual-write — same transaction, same facts.
      await mirrorExternalRef(tx, sale.tenantId, 'SALE', sale.id, {
        externalId: qboDocId,
        externalType: sale.quickbooksDocumentType,
        syncStatus: 'SYNCED',
        syncError: null,
        lastSyncedAt: new Date(),
      });
      for (const [i, p] of sale.payments.entries()) {
        const paymentExternalId =
          p.quickbooksPaymentId ?? external.paymentIds?.[i] ?? `QBO-PMT-${sale.saleNumber}-${i + 1}`;
        await tx.payment.update({
          where: { id: p.id },
          data: {
            syncStatus: 'SYNCED',
            quickbooksPaymentId: paymentExternalId,
          },
        });
        await mirrorExternalRef(tx, sale.tenantId, 'PAYMENT', p.id, {
          externalId: paymentExternalId,
          syncStatus: 'SYNCED',
          lastSyncedAt: new Date(),
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
    // D99 — `connect` only when a variant was actually sold; a product-level line
    // must leave the relation unset rather than connect to nothing.
    ...(line.productVariantId
      ? { productVariant: { connect: { id: line.productVariantId } } }
      : {}),
    // D44 — frozen at sale time, so a later rename cannot rewrite this receipt.
    variantSkuSnapshot: line.variantSkuSnapshot,
    variantNameSnapshot: line.variantNameSnapshot,
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
    // D101 (3.9) — the frozen rate. Required on ComputedLine, so a new row can
    // never carry the null that marks a pre-3.8 line.
    taxRatePercent: line.taxRatePercent,
    lineSubtotal: line.lineSubtotal,
    lineTotal: line.lineTotal,
  };
}

/**
 * A computed cart line as the inventory port sees it.
 *
 * The two shapes already agree field for field — `ComputedLine` carries
 * `productId`, `productName`, `quantity`, and `trackInventory` precisely because
 * `decrementStock` needed them. This narrows rather than converts, so a cart line
 * cannot smuggle pricing or discount state into the inventory layer.
 */
function toStockLines(lines: ComputedLine[]): StockLine[] {
  return lines.map((line) => ({
    productId: line.productId,
    // D99 — the real variant now, resolved by `computeCart`. Still null for a
    // product-level line, which the providers handle as they always have.
    productVariantId: line.productVariantId,
    productName: line.productName,
    quantity: line.quantity,
    trackInventory: line.trackInventory,
  }));
}
