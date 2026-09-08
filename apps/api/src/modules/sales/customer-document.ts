import { PaymentStatus, QuickBooksDocumentType } from '@hardware-pos/database';

/**
 * What kind of document a customer is handed for a completed sale.
 *
 * Provider-neutral and application-level: **no Prisma enum and no migration**. It
 * is derived on every read from local sale state rather than persisted, so it
 * cannot drift out of step with the sale's payment status, and adding it needed no
 * schema change.
 *
 * This exists because `quickbooksDocumentType` was the only positive statement in
 * the system about what a sale's document *is*, and it is external-integration
 * metadata that is `null` for a tenant with no accounting provider. Asking
 * QuickBooks what kind of receipt to print is the wrong question for a restaurant.
 */
export enum CustomerDocumentKind {
  /** Nothing outstanding — the customer has paid in full. */
  RECEIPT = 'RECEIPT',
  /** Money is still owed: a credit sale, or one only partly paid. */
  INVOICE = 'INVOICE',
}

/**
 * Decide the customer document kind from **local** financial state.
 *
 * The only input is `paymentStatus`, which the server computes from its own
 * totals (`paidAmount >= total`). A client-supplied document kind is never
 * accepted — there is no DTO field for one, so a caller cannot ask for a RECEIPT
 * on an unpaid sale.
 *
 * ## Why there is no separate QuickBooks compatibility branch
 *
 * There would be nothing for it to do. QuickBooks maps `PAID → SALES_RECEIPT` and
 * everything else to `INVOICE`; this maps `PAID → RECEIPT` and everything else to
 * `INVOICE`. The two partitions are identical, so a legacy or QuickBooks tenant
 * gets exactly the document kind its external type already implied.
 *
 * That equivalence is not an assumption — {@link customerDocumentKindOf} expresses
 * the QuickBooks mapping independently, and a test asserts the two agree for every
 * payment status. If QuickBooks' rule ever diverges, that test fails and a
 * compatibility branch becomes necessary and obvious. Writing the branch now, while
 * the mappings coincide, would mean shipping a path no test could distinguish.
 */
export function resolveCustomerDocumentKind(paymentStatus: PaymentStatus): CustomerDocumentKind {
  return paymentStatus === 'PAID' ? CustomerDocumentKind.RECEIPT : CustomerDocumentKind.INVOICE;
}

/**
 * The customer document kind a QuickBooks document type implies.
 *
 * Deliberately a separate function from {@link resolveCustomerDocumentKind}: it
 * describes QuickBooks' mapping, not AxloPOS's, and keeping them apart is what
 * makes the equivalence between them testable rather than tautological. Returns
 * `null` when there is no external document, which is not a failure — it is the
 * normal state for a tenant with no accounting provider.
 */
export function customerDocumentKindOf(
  externalDocumentType: QuickBooksDocumentType | null,
): CustomerDocumentKind | null {
  if (externalDocumentType === null) return null;
  return externalDocumentType === 'SALES_RECEIPT'
    ? CustomerDocumentKind.RECEIPT
    : CustomerDocumentKind.INVOICE;
}

/** Customer-facing label. Used only where no external document type exists. */
export function customerDocumentLabel(kind: CustomerDocumentKind): string {
  return kind === CustomerDocumentKind.RECEIPT ? 'Receipt' : 'Invoice';
}
