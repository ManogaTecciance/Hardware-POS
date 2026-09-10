import { renderCustomerReceipt, type CustomerReceiptData } from './receipt-templates';

/**
 * D162 — the receipt says what crossed the counter and what went back.
 *
 * ## What was reported
 *
 * A sale totalling Rs 2,478 was paid with Rs 5,000. The payment screen showed
 * "Change Rs 2,522.00" — twice — and the printed bill showed only
 * `Paid 2,478 / Balance 0.00`. The customer had no record of the 5,000 they
 * handed over or the 2,522 they got back.
 *
 * ## Why nothing caught it
 *
 * Nothing tested this renderer. `renderCustomerReceipt` had no spec at all, so
 * every row it prints was unasserted.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The rows are asserted with their VALUES, not their labels. A renderer that
 * printed "Cash received" against the total rather than the tender would pass
 * a label check and be exactly the bug being fixed.
 *
 * Every positive case is paired with the case one step away from it — exact
 * money, under-tender, and no tender at all — because the guard is the whole
 * decision. A renderer that printed the rows unconditionally would satisfy
 * "the rows appear when there is change" and put `Change Rs. 0.00` on every
 * cash receipt in the shop.
 *
 * And each case asserts `Paid` and `Balance` are UNCHANGED in the same render.
 * That is the property the fix turns on: the tender is a receipt fact, and
 * writing it into either of those would put a walk-in customer on the debtors
 * list or overstate the drawer.
 */

/** The reported sale: Rs 2,478 total, settled in cash. */
function makeReceipt(over: Partial<CustomerReceiptData> = {}): CustomerReceiptData {
  return {
    storeName: 'Kandy Apparel',
    saleNumber: 'S-000022',
    dateTime: '10 Sept 2026, 17:38',
    documentType: 'Receipt',
    customerName: null,
    currency: 'LKR',
    items: [
      {
        name: 'Test (XL — White)',
        promotionNote: null,
        sku: 'TST-XL-WHT',
        quantity: '1',
        unitPrice: 2100,
        discountAmount: 0,
        discountBasis: null,
        discountValue: null,
        lineTotal: 2100,
      },
    ],
    subtotal: 2100,
    totalDiscount: 0,
    promotionDiscount: 0,
    orderDiscount: 0,
    taxAmount: 378,
    total: 2478,
    paidAmount: 2478,
    balanceAmount: 0,
    paymentStatus: 'PAID',
    payments: [{ method: 'CASH', amount: 2478 }],
    footer: 'Thank you for your purchase!',
    ...over,
  } as CustomerReceiptData;
}

/** Collapse the markup to the text a person reads off the paper. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('D162 — cash received and change on the customer receipt', () => {
  it('prints both, with the amounts that were actually handed over', () => {
    const out = text(renderCustomerReceipt(makeReceipt({ amountTendered: 5000 })));

    // The reported defect, stated as an assertion: the tender and the change
    // are on the paper, with their real values.
    expect(out).toContain('Cash received Rs. 5,000.00');
    expect(out).toContain('Change Rs. 2,522.00');

    // …and the money the sale settled for is untouched in the same render.
    // Writing the tender into either of these is the failure mode the whole
    // decision exists to avoid.
    expect(out).toContain('Paid Rs. 2,478.00');
    expect(out).toContain('Balance Rs. 0.00');
    expect(out).toContain('Total Rs. 2,478.00');
  });

  it('prints neither when the customer paid the exact amount', () => {
    // The common case. "Change Rs. 0.00" on every cash receipt is a row the
    // reader has to check and discard every single time.
    const out = text(renderCustomerReceipt(makeReceipt({ amountTendered: 2478 })));

    expect(out).not.toContain('Cash received');
    expect(out).not.toContain('Change');
    // …and the receipt still prints, so this cannot pass on an empty render.
    expect(out).toContain('Paid Rs. 2,478.00');
  });

  it('prints neither on an under-tender — that is a balance, not change', () => {
    /*
     * A partial payment. `Paid` and `Balance` above already say it correctly,
     * and a negative "Change" row would be nonsense on paper.
     */
    const out = text(
      renderCustomerReceipt(
        makeReceipt({ amountTendered: 2000, paidAmount: 2000, balanceAmount: 478, paymentStatus: 'PARTIAL' }),
      ),
    );

    expect(out).not.toContain('Cash received');
    expect(out).not.toContain('Change');
    expect(out).toContain('Paid Rs. 2,000.00');
    expect(out).toContain('Balance Rs. 478.00');
  });

  it('prints neither when no tender was passed at all', () => {
    /*
     * The isolation case, and the one that matters most for blast radius: a
     * REPRINT, a card sale, a credit sale and every restaurant bill reach this
     * renderer with no tender, and must print exactly as they did before D162.
     */
    const out = text(renderCustomerReceipt(makeReceipt()));

    expect(out).not.toContain('Cash received');
    expect(out).not.toContain('Change');
    expect(out).toContain('Paid Rs. 2,478.00');
    expect(out).toContain('Balance Rs. 0.00');
  });

  it('derives the change rather than trusting a number it was handed', () => {
    /*
     * The caller sends only what it observed. If the change were sent too, a
     * caller could print a figure that does not follow from the two amounts
     * printed beside it — and the receipt would contradict itself in the
     * customer's hand.
     */
    const out = text(renderCustomerReceipt(makeReceipt({ amountTendered: 3000 })));

    // 3000 − 2478, computed here, not supplied.
    expect(out).toContain('Change Rs. 522.00');
    expect(out).not.toContain('Rs. 2,522.00');
  });

  it('does not print a rounding artefact as change', () => {
    // A tender a fraction of a cent above the total is exact money in every
    // sense a customer cares about. `Rs. 0.00` would be worse than silence.
    const out = text(renderCustomerReceipt(makeReceipt({ amountTendered: 2478.001 })));

    expect(out).not.toContain('Change');
  });
});
