import { Injectable } from '@nestjs/common';
import {
  AccountingProviderKind,
  Prisma,
  QuickBooksDocumentType,
  QuickBooksReturnDocumentType,
} from '@hardware-pos/database';

import { PrismaService } from '../../../prisma/prisma.service';
import { SyncQueueService } from '../../sync/queue/sync-queue.service';
import { ProviderOperationUnavailableError } from '../provider.errors';
import {
  AccountingSubmissionResult,
  DocumentTypeDecision,
  ProviderContext,
  ProviderSyncOutcome,
  ReturnFinancialShape,
  SaleFinancialShape,
} from '../provider.types';
import { AccountingProvider } from './accounting-provider';

/** Store credit is always a credit memo — never money leaving the drawer. */
const STORE_CREDIT = 'STORE_CREDIT';

/**
 * QuickBooks Online accounting — today's production behaviour, adapted to the port
 * with no change in outcome.
 *
 * Every rule here was read out of the existing code rather than re-derived:
 *
 *  • `sales.service`: `paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE'`, and
 *    an Invoice requires a customer because QuickBooks Invoices need a
 *    `CustomerRef`.
 *  • `returns.service.resolveQboDocType`: `STORE_CREDIT → CREDIT_MEMO`; otherwise a
 *    fully-paid original sale → `REFUND_RECEIPT`, and a credit or partial original
 *    sale → `CREDIT_MEMO`.
 *  • `sales.repository` / `returns.repository`: `enqueueSaleSync(tx, …)` and
 *    `enqueueReturnSync(tx, …)`, both inside the surrounding transaction.
 *
 * Row shapes are **not** touched. This class writes `SyncJob` and `SyncLog` only by
 * delegating to `SyncQueueService`, the same calls the repositories make today, so
 * the persisted job type, direction, entity type, status, and log message are
 * necessarily identical — there is no second code path that could drift.
 *
 * No Intuit SDK type appears in any signature. The QuickBooks *document type* enums
 * are Prisma enums owned by this repository's own schema, not vendor types.
 */
@Injectable()
export class QuickBooksAccountingProvider implements AccountingProvider {
  readonly provider = AccountingProviderKind.QUICKBOOKS;
  readonly name = 'QuickBooks Online';

  constructor(
    private readonly syncQueue: SyncQueueService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * A fully paid sale is a Sales Receipt; anything with an outstanding balance is
   * an Invoice, which QuickBooks requires a customer for.
   */
  resolveSaleDocumentType(sale: SaleFinancialShape): DocumentTypeDecision<QuickBooksDocumentType> {
    const documentType: QuickBooksDocumentType =
      sale.paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE';
    return {
      documentType,
      // The caller raises its own existing error; this only states the requirement.
      requiresCustomer: documentType === 'INVOICE',
    };
  }

  /** Refund receipt for a paid sale refunded in money; credit memo otherwise. */
  resolveReturnDocumentType(
    input: ReturnFinancialShape,
  ): DocumentTypeDecision<QuickBooksReturnDocumentType> {
    const documentType: QuickBooksReturnDocumentType =
      input.refundMethod === STORE_CREDIT
        ? 'CREDIT_MEMO'
        : input.originalPaymentStatus === 'PAID'
          ? 'REFUND_RECEIPT'
          : 'CREDIT_MEMO';
    // A credit memo is issued against a customer's account, but the existing
    // returns pipeline derives the customer from the original sale rather than
    // demanding one, so nothing is required of the caller here.
    return { documentType, requiresCustomer: false };
  }

  /**
   * Enqueue the sale push inside the caller's transaction — the transactional
   * outbox. Delegates to the exact call `sales.repository` makes today.
   */
  async postSale(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    saleId: string,
    documentType: QuickBooksDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksDocumentType>> {
    // QuickBooks always resolves a document type, so null here is a wiring mistake
    // rather than a tenant configuration. Refuse instead of substituting one — an
    // invented document type would misfile a real financial record.
    if (documentType === null) {
      throw new ProviderOperationUnavailableError(
        this.name,
        'postSale without a resolved document type',
      );
    }

    await this.syncQueue.enqueueSaleSync(tx, ctx.tenantId, saleId);
    return { disposition: 'QUEUED', provider: 'QUICKBOOKS', externalDocumentType: documentType };
  }

  /** Enqueue the return push inside the caller's transaction. */
  async postReturn(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    returnId: string,
    documentType: QuickBooksReturnDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksReturnDocumentType>> {
    if (documentType === null) {
      throw new ProviderOperationUnavailableError(
        this.name,
        'postReturn without a resolved document type',
      );
    }

    await this.syncQueue.enqueueReturnSync(tx, ctx.tenantId, returnId);
    return { disposition: 'QUEUED', provider: 'QUICKBOOKS', externalDocumentType: documentType };
  }

  /**
   * Report how much work is already waiting in the outbox.
   *
   * Deliberately does not drain the queue: `SyncWorkerService` owns dispatch, and a
   * provider that also drained it would create a second, competing worker.
   *
   * The count is read directly rather than through a new `SyncQueueService` method,
   * because Slice 5 must not modify existing sync orchestration. It is a read-only
   * query on an indexed column (`SyncJob.status`).
   */
  async synchronize(ctx: ProviderContext): Promise<ProviderSyncOutcome> {
    const pending = await this.prisma.syncJob.count({
      where: { tenantId: ctx.tenantId, status: { in: ['PENDING', 'SYNCING'] } },
    });
    return {
      requested: pending > 0,
      queued: pending,
      detail:
        pending > 0
          ? `${pending} QuickBooks sync job(s) pending; the sync worker will dispatch them.`
          : 'No QuickBooks sync jobs pending.',
    };
  }
}
