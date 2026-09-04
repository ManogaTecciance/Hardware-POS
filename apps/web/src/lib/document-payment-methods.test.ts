import { describe, expect, it } from 'vitest';

import { CREDIT_METHOD_LABEL, documentPaymentMethods } from '@hardware-pos/shared';

/**
 * `packages/shared` has no runner of its own, so the rule that decides how a
 * bill states its payment method is covered here — apps/web renders the A4 bill
 * the shop actually prints, and already runs vitest.
 *
 * The rule in one line: while money is owed the sale is running on credit and
 * the document says so; once it is settled the document names what the customer
 * really paid with.
 */
describe('payment method on a customer document', () => {
  it('reads Credit for a sale taken entirely on credit', () => {
    expect(documentPaymentMethods([], 1500)).toBe('Credit');
  });

  it('names the method for a sale paid in full at the counter', () => {
    expect(documentPaymentMethods([{ method: 'CARD' }], 0)).toBe('Card');
  });

  it('names what was tendered AND the credit, for a part payment', () => {
    // The customer did pay cash for part of it; saying only "Credit" would deny
    // a payment they made, and only "Cash" would deny the balance they owe.
    expect(documentPaymentMethods([{ method: 'CASH' }], 750)).toBe('Cash, Credit');
  });

  it('drops Credit once the sale is settled, leaving the real methods', () => {
    const payments = [{ method: 'CASH' }, { method: 'BANK_TRANSFER' }];
    expect(documentPaymentMethods(payments, 400)).toBe('Cash, Bank transfer, Credit');
    // Same sale, reprinted after the balance was cleared.
    expect(documentPaymentMethods(payments, 0)).toBe('Cash, Bank transfer');
  });

  it('dedupes repeated methods', () => {
    // A split across two cards is one method, not two.
    expect(documentPaymentMethods([{ method: 'CARD' }, { method: 'CARD' }], 0)).toBe('Card');
  });

  it('keeps the order money came in, with credit last', () => {
    expect(documentPaymentMethods([{ method: 'CHECK' }, { method: 'CASH' }], 10)).toBe(
      'Cheque, Cash, Credit',
    );
  });

  it('labels every known method rather than printing the raw code', () => {
    expect(documentPaymentMethods([{ method: 'BANK_TRANSFER' }], 0)).toBe('Bank transfer');
    expect(documentPaymentMethods([{ method: 'QR_PAYMENT' }], 0)).toBe('QR payment');
    expect(documentPaymentMethods([{ method: 'STORE_CREDIT' }], 0)).toBe('Store credit');
  });

  it('falls back to the raw code for a method it does not know', () => {
    expect(documentPaymentMethods([{ method: 'CRYPTO' }], 0)).toBe('CRYPTO');
  });

  it('shows a dash rather than lying when there is nothing to state', () => {
    // Nothing tendered and nothing owed should not occur; "Credit" would be wrong.
    expect(documentPaymentMethods([], 0)).toBe('—');
  });

  it('treats a negative balance as settled, not as credit', () => {
    // Over-tendered cash leaves change owed to the customer, not credit owed to the shop.
    expect(documentPaymentMethods([{ method: 'CASH' }], -50)).toBe('Cash');
  });

  it('exports the credit label so surfaces cannot each invent their own wording', () => {
    expect(CREDIT_METHOD_LABEL).toBe('Credit');
  });
});
