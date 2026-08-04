import {
  AccountingProviderKind,
  Prisma,
  QuickBooksDocumentType,
  QuickBooksReturnDocumentType,
} from '@hardware-pos/database';

import {
  AccountingSubmissionResult,
  DocumentTypeDecision,
  ProviderContext,
  ProviderSyncOutcome,
  ReturnFinancialShape,
  SaleFinancialShape,
} from '../provider.types';

/**
 * Which accounting system, if any, receives a tenant's financial documents.
 *
 * ## Scope
 *
 * Every method abstracts something the current code already does:
 *
 * | Method | Existing behaviour it abstracts |
 * |---|---|
 * | `resolveSaleDocumentType` | `sales.service`: `paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE'`, plus the "a customer is required for a credit/partial sale" rule |
 * | `resolveReturnDocumentType` | `returns.service.resolveQboDocType`: `STORE_CREDIT → CREDIT_MEMO`, else paid → `REFUND_RECEIPT`, else `CREDIT_MEMO` |
 * | `postSale` | `sales.repository`: `syncQueue.enqueueSaleSync(tx, …)` inside the sale transaction |
 * | `postReturn` | `returns.repository`: `syncQueue.enqueueReturnSync(tx, …)` inside the return transaction |
 * | `synchronize` | `POST /v1/sync/sales/:id/retry` and the sync status surface |
 *
 * Deliberately **absent**, and both are omissions on purpose:
 *
 *  • **`postPayment`.** `PaymentsService.create` currently throws
 *    `NotImplementedException` — standalone payment recording does not exist.
 *    Payments are created inside the sale transaction and receive their
 *    `quickbooksPaymentId` as part of the sale push, so there is no separate
 *    payment post to abstract. Adding one would model a capability that is not
 *    currently used. It belongs with whichever slice implements
 *    `PaymentsService.create`.
 *  • **`postCreditNote`.** A credit memo is not a different operation from a
 *    refund receipt — it is a different *document type* for the same return push,
 *    already expressed by `QuickBooksReturnDocumentType`. Two methods would imply
 *    two code paths that do not exist.
 *
 * ## Transaction contract
 *
 * `postSale` and `postReturn` write local synchronisation state (`SyncJob` and
 * `SyncLog`) and therefore take the caller's `Prisma.TransactionClient`. This is
 * the transactional outbox: the job row commits atomically with the sale or return
 * it describes, so a QuickBooks outage can never lose a transaction, and a failed
 * sale can never leave an orphan job.
 *
 * An implementation must never open its own transaction, and must never call an
 * external API from inside one. These methods only *enqueue*; the background
 * worker performs the outbound call after the transaction has committed.
 *
 * ## Document types
 *
 * `documentType: null` from a resolver means "this tenant has no external
 * accounting, so there is no document". Both `Sale.quickbooksDocumentType` and
 * `Return.quickbooksDocumentType` are already nullable, so this persists with no
 * migration.
 */
export interface AccountingProvider {
  /** Which `AccountingProviderKind` this implementation serves. */
  readonly provider: AccountingProviderKind;

  /** Human-readable provider name, safe for error messages and logs. */
  readonly name: string;

  /**
   * Which accounting document a completed sale maps to.
   *
   * Returns `requiresCustomer` rather than throwing, so the caller keeps raising
   * its own existing user-facing error with its existing wording. That keeps Slice
   * 6 a pure extraction rather than a change in error behaviour.
   */
  resolveSaleDocumentType(sale: SaleFinancialShape): DocumentTypeDecision<QuickBooksDocumentType>;

  /** Which accounting document a return maps to. */
  resolveReturnDocumentType(
    input: ReturnFinancialShape,
  ): DocumentTypeDecision<QuickBooksReturnDocumentType>;

  /**
   * Hand a completed sale to the accounting layer, inside the caller's transaction.
   *
   * Enqueue only — never an outbound API call.
   *
   * `documentType` is the value the caller already obtained from
   * {@link resolveSaleDocumentType}, passed through rather than re-read so the
   * decision and the submission cannot disagree. `null` means the resolver reported
   * no external document, which is the `NoAccountingProvider` case.
   *
   * Returns an {@link AccountingSubmissionResult} rather than `void`, so a caller
   * can tell a queued push from "no accounting system configured" without
   * inspecting the provider's identity.
   */
  postSale(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    saleId: string,
    documentType: QuickBooksDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksDocumentType>>;

  /**
   * Hand an approved return to the accounting layer, inside the caller's
   * transaction.
   *
   * Covers both refund receipts and credit memos; the document type is decided by
   * {@link resolveReturnDocumentType}.
   */
  postReturn(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    returnId: string,
    documentType: QuickBooksReturnDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksReturnDocumentType>>;

  /**
   * Ask the provider to reconcile with its upstream system.
   *
   * Not transactional, for the same reason as the inventory port.
   */
  synchronize(ctx: ProviderContext): Promise<ProviderSyncOutcome>;
}

/** DI token. */
export const ACCOUNTING_PROVIDER_FACTORY = Symbol('ACCOUNTING_PROVIDER_FACTORY');
