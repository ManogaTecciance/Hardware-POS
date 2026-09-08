import { PaymentMethod, PaymentStatus, QuickBooksReturnDocumentType } from '@hardware-pos/database';

import { QuickBooksAccountingProvider } from '../providers/accounting/quickbooks-accounting.provider';
import {
  CustomerReturnDocumentKind,
  customerReturnDocumentKindOf,
  customerReturnDocumentLabel,
  resolveCustomerReturnDocumentKind,
} from './customer-return-document';

const ALL_METHODS: PaymentMethod[] = [
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'QR_PAYMENT',
  'CHECK',
  'STORE_CREDIT',
  'OTHER',
];
const ALL_STATUSES: PaymentStatus[] = ['UNPAID', 'PARTIAL', 'PAID', 'REFUNDED'];
const MONEY_METHODS = ALL_METHODS.filter((m) => m !== 'STORE_CREDIT');

describe('resolveCustomerReturnDocumentKind', () => {
  it.each(ALL_STATUSES)('store credit is a credit note whatever the sale status (%s)', (status) => {
    expect(
      resolveCustomerReturnDocumentKind({
        refundMethod: 'STORE_CREDIT',
        originalPaymentStatus: status,
      }),
    ).toBe(CustomerReturnDocumentKind.CREDIT_NOTE);
  });

  it.each(MONEY_METHODS)('a fully-paid sale refunded by %s is a refund receipt', (method) => {
    expect(
      resolveCustomerReturnDocumentKind({ refundMethod: method, originalPaymentStatus: 'PAID' }),
    ).toBe(CustomerReturnDocumentKind.REFUND_RECEIPT);
  });

  it.each(MONEY_METHODS)('an unpaid sale is a credit note even by %s — no money to give back', (method) => {
    expect(
      resolveCustomerReturnDocumentKind({ refundMethod: method, originalPaymentStatus: 'UNPAID' }),
    ).toBe(CustomerReturnDocumentKind.CREDIT_NOTE);
  });

  it.each(MONEY_METHODS)('an already-REFUNDED sale is a credit note by %s — the money went back once', (method) => {
    expect(
      resolveCustomerReturnDocumentKind({ refundMethod: method, originalPaymentStatus: 'REFUNDED' }),
    ).toBe(CustomerReturnDocumentKind.CREDIT_NOTE);
  });

  it('a partially-paid sale refunded in money is a refund receipt: cash really left the drawer', () => {
    expect(
      resolveCustomerReturnDocumentKind({ refundMethod: 'CASH', originalPaymentStatus: 'PARTIAL' }),
    ).toBe(CustomerReturnDocumentKind.REFUND_RECEIPT);
  });

  it('a missing refund method is not store credit', () => {
    expect(
      resolveCustomerReturnDocumentKind({ refundMethod: null, originalPaymentStatus: 'PAID' }),
    ).toBe(CustomerReturnDocumentKind.REFUND_RECEIPT);
  });

  it('is total: every method × status pair resolves to a kind', () => {
    for (const refundMethod of ALL_METHODS) {
      for (const originalPaymentStatus of ALL_STATUSES) {
        expect(
          Object.values(CustomerReturnDocumentKind),
        ).toContain(resolveCustomerReturnDocumentKind({ refundMethod, originalPaymentStatus }));
      }
    }
  });

  it('takes no input a client could supply — the signature is the guarantee', () => {
    // Two server-owned facts: the refund method the server validated, and the
    // original sale's persisted payment status. No DTO field reaches this.
    expect(resolveCustomerReturnDocumentKind).toHaveLength(1);
  });
});

describe('customerReturnDocumentKindOf (the QuickBooks mapping, stated independently)', () => {
  it('maps CREDIT_MEMO to a credit note and REFUND_RECEIPT to a refund receipt', () => {
    expect(customerReturnDocumentKindOf('CREDIT_MEMO')).toBe(CustomerReturnDocumentKind.CREDIT_NOTE);
    expect(customerReturnDocumentKindOf('REFUND_RECEIPT')).toBe(
      CustomerReturnDocumentKind.REFUND_RECEIPT,
    );
  });

  it('has no opinion when there is no external document', () => {
    expect(customerReturnDocumentKindOf(null)).toBeNull();
  });
});

/**
 * The local decision and QuickBooks' decision compared across the whole input
 * space, so both the agreement and the single disagreement are facts rather than
 * claims in a comment.
 */
describe('local semantics vs the QuickBooks mapping', () => {
  const quickbooks = new QuickBooksAccountingProvider(null as never, null as never);

  const pairs = ALL_METHODS.flatMap((refundMethod) =>
    ALL_STATUSES.map((originalPaymentStatus) => ({ refundMethod, originalPaymentStatus })),
  );

  function compare(input: { refundMethod: PaymentMethod; originalPaymentStatus: PaymentStatus }) {
    const local = resolveCustomerReturnDocumentKind(input);
    const external = quickbooks.resolveReturnDocumentType(input)
      .documentType as QuickBooksReturnDocumentType;
    return { local, viaQuickBooks: customerReturnDocumentKindOf(external) };
  }

  it('agrees everywhere except a partially-paid sale refunded in money', () => {
    const disagreements = pairs.filter((p) => {
      const { local, viaQuickBooks } = compare(p);
      return local !== viaQuickBooks;
    });

    expect(disagreements).toEqual(
      MONEY_METHODS.map((refundMethod) => ({ refundMethod, originalPaymentStatus: 'PARTIAL' })),
    );
  });

  it('states the disagreement precisely: QuickBooks says credit memo, local says refund receipt', () => {
    const input = { refundMethod: 'CASH' as PaymentMethod, originalPaymentStatus: 'PARTIAL' as PaymentStatus };
    expect(quickbooks.resolveReturnDocumentType(input).documentType).toBe('CREDIT_MEMO');
    expect(resolveCustomerReturnDocumentKind(input)).toBe(CustomerReturnDocumentKind.REFUND_RECEIPT);
    // It changes nothing a QuickBooks customer sees: whenever an external document
    // type exists it stays authoritative for the printed label. Proven end-to-end
    // in return-accounting-adoption.spec.ts.
  });

  it('agrees for every status other than PARTIAL', () => {
    for (const p of pairs.filter((x) => x.originalPaymentStatus !== 'PARTIAL')) {
      const { local, viaQuickBooks } = compare(p);
      expect({ ...p, local }).toEqual({ ...p, local: viaQuickBooks });
    }
  });
});

describe('customerReturnDocumentLabel', () => {
  it('uses "Credit Note", not QuickBooks\' "Credit Memo"', () => {
    expect(customerReturnDocumentLabel(CustomerReturnDocumentKind.CREDIT_NOTE)).toBe('Credit Note');
  });

  it('uses "Refund Receipt"', () => {
    expect(customerReturnDocumentLabel(CustomerReturnDocumentKind.REFUND_RECEIPT)).toBe(
      'Refund Receipt',
    );
  });

  it('never emits an external system name', () => {
    for (const kind of Object.values(CustomerReturnDocumentKind)) {
      expect(customerReturnDocumentLabel(kind)).not.toMatch(/quickbooks|qbo|memo/i);
    }
  });
});
