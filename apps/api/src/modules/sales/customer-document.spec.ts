import { PaymentStatus, QuickBooksDocumentType } from '@hardware-pos/database';

import {
  CustomerDocumentKind,
  customerDocumentKindOf,
  customerDocumentLabel,
  resolveCustomerDocumentKind,
} from './customer-document';

/**
 * The customer document decision, in isolation.
 *
 * The load-bearing test here is the last block: it proves that the local rule and
 * QuickBooks' own mapping partition payment statuses identically. That equivalence
 * is why the resolver needs no QuickBooks compatibility branch — and if QuickBooks'
 * rule ever changes, this fails and the branch becomes necessary and obvious.
 */
describe('resolveCustomerDocumentKind', () => {
  it('a fully paid sale is a RECEIPT', () => {
    expect(resolveCustomerDocumentKind('PAID')).toBe(CustomerDocumentKind.RECEIPT);
  });

  it.each([['PARTIAL'], ['UNPAID']] as const)('a %s sale is an INVOICE', (paymentStatus) => {
    expect(resolveCustomerDocumentKind(paymentStatus)).toBe(CustomerDocumentKind.INVOICE);
  });

  it('covers every PaymentStatus — a new one cannot be silently unhandled', () => {
    for (const status of Object.values(PaymentStatus)) {
      expect(Object.values(CustomerDocumentKind)).toContain(resolveCustomerDocumentKind(status));
    }
  });

  it('depends on nothing but payment status', () => {
    // No tenant, no provider, no external document type, and no client input. The
    // signature is the guarantee: there is nowhere to pass a document kind in.
    expect(resolveCustomerDocumentKind.length).toBe(1);
  });

  it('REFUNDED is treated as an invoice rather than a receipt', () => {
    // A refunded sale is not "paid" from the customer's point of view, and defaulting
    // an unrecognised status to RECEIPT would be the unsafe direction — it would
    // print "Receipt" on something with money outstanding.
    expect(resolveCustomerDocumentKind('REFUNDED')).toBe(CustomerDocumentKind.INVOICE);
  });
});

describe('customerDocumentKindOf (the QuickBooks mapping)', () => {
  it('SALES_RECEIPT implies a RECEIPT', () => {
    expect(customerDocumentKindOf('SALES_RECEIPT')).toBe(CustomerDocumentKind.RECEIPT);
  });

  it('INVOICE implies an INVOICE', () => {
    expect(customerDocumentKindOf('INVOICE')).toBe(CustomerDocumentKind.INVOICE);
  });

  it('no external document type implies nothing — that is not a failure', () => {
    expect(customerDocumentKindOf(null)).toBeNull();
  });

  it('covers every QuickBooksDocumentType', () => {
    for (const type of Object.values(QuickBooksDocumentType)) {
      expect(customerDocumentKindOf(type)).not.toBeNull();
    }
  });
});

describe('the local rule and the QuickBooks mapping agree', () => {
  /** The QuickBooks rule as `sales.service` applied it before Slice 6A. */
  function legacyQuickBooksDocumentType(paymentStatus: PaymentStatus): QuickBooksDocumentType {
    return paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE';
  }

  it.each(Object.values(PaymentStatus))(
    'for a %s sale, the local kind matches what the QuickBooks type implies',
    (paymentStatus) => {
      const local = resolveCustomerDocumentKind(paymentStatus);
      const viaQuickBooks = customerDocumentKindOf(legacyQuickBooksDocumentType(paymentStatus));

      // This is the compatibility proof: an existing Tile Shop sale gets exactly the
      // document kind its stored QuickBooks type already implied, so introducing the
      // local resolver reclassifies nothing.
      expect(local).toBe(viaQuickBooks);
    },
  );
});

describe('customerDocumentLabel', () => {
  it.each([
    [CustomerDocumentKind.RECEIPT, 'Receipt'],
    [CustomerDocumentKind.INVOICE, 'Invoice'],
  ])('%s renders as "%s"', (kind, label) => {
    expect(customerDocumentLabel(kind)).toBe(label);
  });

  it('never produces a blank label', () => {
    for (const kind of Object.values(CustomerDocumentKind)) {
      expect(customerDocumentLabel(kind).trim().length).toBeGreaterThan(0);
    }
  });

  it('never says QuickBooks', () => {
    for (const kind of Object.values(CustomerDocumentKind)) {
      expect(customerDocumentLabel(kind)).not.toMatch(/quickbooks/i);
    }
  });
});
