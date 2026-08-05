import { PaymentMethod, PaymentStatus, QuickBooksReturnDocumentType } from '@hardware-pos/database';

/**
 * Which document a customer is handed for a return, decided from **local financial
 * facts** rather than from an external accounting system's document type.
 *
 * The counterpart of `CustomerDocumentKind` on the sale side (Slice 6A), for the
 * same reason: `Return.quickbooksDocumentType` is integration metadata, and a
 * tenant with no accounting provider has none — so it cannot be what decides
 * whether a customer receives a refund receipt or a credit note.
 *
 * Application-level only. No Prisma enum, no migration: this is derived on read
 * from the return's own refund method and the original sale's payment status, so
 * it cannot drift from them.
 */
export enum CustomerReturnDocumentKind {
  /** Money actually went back to the customer. */
  REFUND_RECEIPT = 'REFUND_RECEIPT',
  /** No money left the drawer — store credit, or a balance reduced. */
  CREDIT_NOTE = 'CREDIT_NOTE',
}

/** Store credit never moves money; it issues a claim against the store. */
const STORE_CREDIT: PaymentMethod = 'STORE_CREDIT';

/**
 * The payment statuses where the customer actually handed over money that a
 * refund could give back.
 *
 * An allow-list rather than `!== 'UNPAID'` so the default direction is safe: any
 * status not listed here — including one added to the enum later — produces a
 * credit note, which never claims a refund that did not happen. `REFUNDED` is
 * excluded because the money has already gone back.
 */
const MONEY_WAS_TAKEN = new Set<PaymentStatus>(['PAID', 'PARTIAL']);

/**
 * The return document, from local semantics.
 *
 * Three rules, in order:
 *
 *  1. **Store credit is a credit note.** A claim against the store was issued;
 *     nothing left the drawer.
 *  2. **A sale the customer never paid for produces a credit note.** There is no
 *     money to give back, so the return reduces what they owe. Same for a sale
 *     already marked `REFUNDED` — that money has gone back once already.
 *  3. **Otherwise money genuinely moved**, and that is a refund receipt.
 *
 * ## Where this deliberately disagrees with QuickBooks
 *
 * QuickBooks maps a **partially paid** original sale to a `CREDIT_MEMO` even when
 * the refund is paid out in cash. Locally that is a refund receipt: the customer
 * paid real money, the refund is capped at what they paid
 * (`validateRefundMethod`), and the return does not reduce the sale's outstanding
 * balance — so cash really does leave the drawer.
 *
 * The divergence is confined to `PARTIAL` + a non-store-credit refund method and
 * is asserted explicitly in the tests. It changes nothing a Tile Shop customer
 * sees: whenever an external document type exists it stays authoritative for the
 * printed label, so QuickBooks output is byte-identical. This resolver decides the
 * document only where QuickBooks has no opinion — which is exactly the tenants
 * QuickBooks does not serve.
 */
export function resolveCustomerReturnDocumentKind(input: {
  /**
   * `null` is accepted because `Return.refundMethod` is nullable in the schema,
   * even though every return the service writes has one. A missing method is
   * certainly not store credit, so it falls through to the money-moved rules.
   */
  refundMethod: PaymentMethod | null;
  originalPaymentStatus: PaymentStatus;
}): CustomerReturnDocumentKind {
  if (input.refundMethod === STORE_CREDIT) {
    return CustomerReturnDocumentKind.CREDIT_NOTE;
  }
  return MONEY_WAS_TAKEN.has(input.originalPaymentStatus)
    ? CustomerReturnDocumentKind.REFUND_RECEIPT
    : CustomerReturnDocumentKind.CREDIT_NOTE;
}

/**
 * The same decision as QuickBooks expresses it, so the two can be *compared*
 * rather than assumed equal.
 *
 * Stated independently on purpose: it is what makes the equivalence — and the one
 * documented divergence — a testable property instead of a claim in a comment.
 */
export function customerReturnDocumentKindOf(
  externalDocumentType: QuickBooksReturnDocumentType | null,
): CustomerReturnDocumentKind | null {
  if (externalDocumentType === null) return null;
  return externalDocumentType === 'CREDIT_MEMO'
    ? CustomerReturnDocumentKind.CREDIT_NOTE
    : CustomerReturnDocumentKind.REFUND_RECEIPT;
}

/**
 * The customer-facing label for a locally-decided return document.
 *
 * "Credit Note" rather than QuickBooks' "Credit Memo": a tenant with no accounting
 * provider should not be shown an external system's vocabulary. A QuickBooks
 * tenant keeps "Credit Memo", because their label comes from the stored external
 * document type, not from here.
 */
export function customerReturnDocumentLabel(kind: CustomerReturnDocumentKind): string {
  return kind === CustomerReturnDocumentKind.CREDIT_NOTE ? 'Credit Note' : 'Refund Receipt';
}
