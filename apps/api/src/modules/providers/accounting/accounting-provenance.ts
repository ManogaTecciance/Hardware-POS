import {
  AccountingProviderKind,
  QuickBooksDocumentType,
  QuickBooksReturnDocumentType,
  SyncStatus,
} from '@hardware-pos/database';

import { AmbiguousAccountingProvenanceError } from '../provider.errors';

/**
 * Which accounting provider a **already-persisted** document was created under.
 *
 * ## Why provenance is not the same question as "which provider does this tenant
 * use today"
 *
 * A return reverses an accounting entry that already exists. If a tenant switches
 * from QuickBooks to NONE, a return against a sale that *is* in QuickBooks must
 * still reverse it there, or QuickBooks keeps revenue that was refunded. If a
 * tenant switches from NONE to QuickBooks, a return against a sale QuickBooks has
 * never seen must not be pushed, or QuickBooks receives a credit note for revenue
 * it never recorded. Both mistakes come from the same shortcut: resolving the
 * provider from `TenantBusinessProfile` at *return* time.
 *
 * So provenance is read from the sale row itself, never from the current profile.
 *
 * ## What the evidence is, and why it is sufficient today
 *
 * `Sale.quickbooksDocumentType` is the record of where a sale was filed. It is
 * sufficient because it is *complete* and *exclusive*:
 *
 *  • **Complete** — every path that produces a returnable sale writes it. There are
 *    exactly two `sale.create` call sites, both in `sales.repository`.
 *    `createDraft` leaves it null but produces a `DRAFT`, and returns are refused
 *    for anything that is not `COMPLETED`. `createCompleted` and `completeDraft`
 *    both write the provider's decision. Quotation conversion calls
 *    `SalesService.complete`, so it inherits the same decision.
 *  • **Exclusive** — before Slice 6A the field was typed non-nullable and was
 *    always `SALES_RECEIPT` or `INVOICE`, so every historical sale carries one.
 *    After Slice 6A a null is written only by `NoAccountingProvider`, and
 *    `postAccountingChecked` refuses to commit a sale whose stored document type
 *    disagrees with what the provider reported.
 *
 * Verified against the production-shaped development database: of 317 sales and 36
 * returns, zero had a null document type.
 *
 * ## Forward compatibility
 *
 * This infers "external" from a document type, then maps external to the single
 * external provider that has an implementation. That inference holds only while
 * there *is* exactly one. {@link EXTERNAL_DOCUMENT_WRITERS} is exhaustive over
 * `AccountingProviderKind`, so adding a kind fails to compile until it is
 * classified; and if a second writer is ever enabled, {@link externalWriters}
 * returns two and provenance resolution refuses instead of guessing. That is the
 * point at which a persisted provenance column becomes necessary — the design
 * makes that requirement surface loudly rather than silently misfiling documents.
 */

/**
 * Whether a provider kind can be the origin of a persisted external accounting
 * document.
 *
 * Exhaustive over `AccountingProviderKind` deliberately: a new kind is a
 * compile error here, which is exactly when someone must decide what it means for
 * provenance.
 *
 * `FUTURE_EXTERNAL` is `false` because it has **no implementation** —
 * `AccountingProviderFactory` throws for it, so no sale or return can ever have
 * been filed under it. When it (or any new kind) gains an implementation, flip it
 * to `true`; provenance inference will then correctly refuse to guess.
 */
const EXTERNAL_DOCUMENT_WRITERS: Record<AccountingProviderKind, boolean> = {
  [AccountingProviderKind.QUICKBOOKS]: true,
  [AccountingProviderKind.NONE]: false,
  [AccountingProviderKind.FUTURE_EXTERNAL]: false,
};

/** The provider kinds that could have written a persisted external document. */
export function externalWriters(): AccountingProviderKind[] {
  return (Object.keys(EXTERNAL_DOCUMENT_WRITERS) as AccountingProviderKind[]).filter(
    (kind) => EXTERNAL_DOCUMENT_WRITERS[kind],
  );
}

/** The stored accounting evidence on a sale. Nothing else is consulted. */
export interface SaleAccountingFacts {
  id: string;
  quickbooksDocumentType: QuickBooksDocumentType | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatus;
}

/** The stored accounting evidence on a return. */
export interface ReturnAccountingFacts {
  id: string;
  quickbooksDocumentType: QuickBooksReturnDocumentType | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatus;
}

/**
 * The provider a persisted document was filed under.
 *
 * Fails closed in both directions rather than defaulting:
 *
 *  • **Contradictory evidence** — no document type, yet an external document id or
 *    a synchronisation status that only an external push produces. That row cannot
 *    be interpreted, and either answer risks a wrong financial entry, so it raises.
 *  • **More than one possible external writer** — see the module comment.
 */
function resolveProvenance(
  entity: 'sale' | 'return',
  facts: {
    id: string;
    documentType: string | null;
    documentId: string | null;
    syncStatus: SyncStatus;
  },
): AccountingProviderKind {
  if (facts.documentType !== null) {
    const writers = externalWriters();
    if (writers.length !== 1) {
      throw new AmbiguousAccountingProvenanceError(
        entity,
        facts.id,
        `${writers.length} accounting providers can write external documents, so the ` +
          'provider that produced this one cannot be inferred from its document type',
      );
    }
    return writers[0];
  }

  // No document type means no external accounting. Anything that contradicts that
  // is a row we refuse to interpret rather than one we guess about.
  if (facts.documentId !== null) {
    throw new AmbiguousAccountingProvenanceError(
      entity,
      facts.id,
      'it has an external document id but no external document type',
    );
  }
  if (facts.syncStatus !== 'NOT_SYNCED') {
    throw new AmbiguousAccountingProvenanceError(
      entity,
      facts.id,
      `it has no external document type but its sync status is ${facts.syncStatus}`,
    );
  }

  return AccountingProviderKind.NONE;
}

/**
 * Which accounting provider this sale was completed under.
 *
 * The `?? null` normalisations are deliberate. The fields are typed non-optional,
 * but an object that omits them would otherwise satisfy `!== null` and be read as
 * "external" — inferring QuickBooks from *absent* evidence, which is the one
 * inference this module exists to prevent. Normalised, missing evidence instead
 * trips the contradiction checks and raises.
 */
export function saleAccountingProvenance(sale: SaleAccountingFacts): AccountingProviderKind {
  return resolveProvenance('sale', {
    id: sale.id,
    documentType: sale.quickbooksDocumentType ?? null,
    documentId: sale.quickbooksDocumentId ?? null,
    syncStatus: sale.syncStatus,
  });
}

/**
 * Which accounting provider this return was filed under.
 *
 * A return inherits its provenance from its original sale at creation time, so
 * this and {@link saleAccountingProvenance} necessarily agree. It exists so that
 * operations acting on a return alone — retrying a sync, or the sync worker — do
 * not have to re-load the sale to know whether an external system is involved.
 */
export function returnAccountingProvenance(ret: ReturnAccountingFacts): AccountingProviderKind {
  return resolveProvenance('return', {
    id: ret.id,
    documentType: ret.quickbooksDocumentType ?? null,
    documentId: ret.quickbooksDocumentId ?? null,
    syncStatus: ret.syncStatus,
  });
}
