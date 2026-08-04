import { Injectable } from '@nestjs/common';
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
import { AccountingProvider } from './accounting-provider';

/**
 * No external accounting system — the right provider for a restaurant that runs its
 * books elsewhere, or for a tenant that simply has not connected one.
 *
 * ## What it does
 *
 * Both resolvers return `documentType: null`. That is a first-class answer, not a
 * failure: `Sale.quickbooksDocumentType` and `Return.quickbooksDocumentType` are
 * both already nullable, so a sale under this provider persists with no document
 * type and no migration is needed.
 *
 * `requiresCustomer` is always `false`, and this is the one place where the
 * abstraction earns its keep beyond tidiness. The current
 * "a customer is required for a credit/partial sale" rule exists *only* because a
 * QuickBooks Invoice needs a `CustomerRef`. Under this provider that constraint is
 * meaningless, so a restaurant running a tab for an unnamed walk-in is not blocked
 * by an accounting rule that does not apply to it.
 *
 * `postSale` and `postReturn` are deterministic no-ops that accept and ignore the
 * transaction client, so a caller inside a transaction needs no special case.
 *
 * ## What it must never do
 *
 * - **No `SyncJob` rows.**
 * - **No `SyncLog` rows.**
 * - **No fabricated QuickBooks document id.** Not `null`-then-filled-in later, not
 *   a placeholder string — nothing. Writing a synthetic id into a financial record
 *   for a tenant with no accounting integration would be inventing an audit trail.
 * - **Never claim a sync happened.** `synchronize` reports `requested: false`, so a
 *   caller cannot read a successful external reconciliation into it.
 *
 * The structural guarantee for the first three: this class takes **no constructor
 * dependencies at all**. It holds no `PrismaService` and no `SyncQueueService`, so
 * it has no mechanism to write a row even by mistake.
 */
@Injectable()
export class NoAccountingProvider implements AccountingProvider {
  readonly provider = AccountingProviderKind.NONE;
  readonly name = 'No external accounting';

  /** No document, and no customer requirement — see the class comment. */
  resolveSaleDocumentType(
    _sale: SaleFinancialShape,
  ): DocumentTypeDecision<QuickBooksDocumentType> {
    return { documentType: null, requiresCustomer: false };
  }

  /** No document. */
  resolveReturnDocumentType(
    _input: ReturnFinancialShape,
  ): DocumentTypeDecision<QuickBooksReturnDocumentType> {
    return { documentType: null, requiresCustomer: false };
  }

  /**
   * Writes nothing to the outbox, and says so unambiguously.
   *
   * `NOT_REQUIRED` is the whole point of Decision 1: the sale completed locally and
   * completely, and no external synchronisation was needed. It is deliberately not
   * expressible as "synced with no document", which would be read as a successful
   * QuickBooks push by anyone who did not know better.
   *
   * `documentType` is accepted and ignored — this provider's resolver always
   * returns `null`, and honouring a value handed to it anyway would let a caller
   * fabricate an external document type on a tenant that has no external system.
   */
  postSale(
    _tx: Prisma.TransactionClient,
    _ctx: ProviderContext,
    _saleId: string,
    _documentType: QuickBooksDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksDocumentType>> {
    return Promise.resolve({
      disposition: 'NOT_REQUIRED',
      provider: 'NONE',
      externalDocumentType: null,
    });
  }

  /** Writes nothing to the outbox. Same `NOT_REQUIRED` semantics as {@link postSale}. */
  postReturn(
    _tx: Prisma.TransactionClient,
    _ctx: ProviderContext,
    _returnId: string,
    _documentType: QuickBooksReturnDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksReturnDocumentType>> {
    return Promise.resolve({
      disposition: 'NOT_REQUIRED',
      provider: 'NONE',
      externalDocumentType: null,
    });
  }

  /**
   * States plainly that there is nothing to synchronise.
   *
   * `requested: false` with `queued: 0` — never a pretend success.
   */
  synchronize(_ctx: ProviderContext): Promise<ProviderSyncOutcome> {
    return Promise.resolve({
      requested: false,
      queued: 0,
      detail: 'No external accounting is configured for this tenant; nothing to synchronise.',
    });
  }
}
