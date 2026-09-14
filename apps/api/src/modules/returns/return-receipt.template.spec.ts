/**
 * D174 — the shop's logo on the refund slip.
 *
 * D172 put the logo on the sales receipt and the A4 letterhead and **missed
 * this one**, which is the receipt a customer is handed while they are already
 * unhappy and the one they keep as proof the shop took the goods back.
 *
 * ## What makes these non-vacuous (D30)
 *
 * The positive case asserts the bytes arrive as a `data:` URI, not merely that
 * an `<img>` exists. A template emitting `src="/uploads/…"` would satisfy
 * "there is an image" and print a broken icon — that was exactly D172's A4
 * defect, and repeating it here would be repeating it knowingly.
 *
 * The negative case is what stops the change reaching tenants it should not.
 * Every workspace without a logo — which is every workspace until someone
 * uploads one — must print precisely what it printed before, so it asserts no
 * `<img>` at all AND that the shop name is still there.
 *
 * The shop name is asserted in BOTH cases. A logo that replaced it would pass a
 * test that only looked for the image, and a refund slip whose branding failed
 * to render would then carry nothing identifying the shop that owes the money.
 *
 * The refund TOTAL is asserted alongside, because this document's job is not
 * decoration: a change to the header must not disturb the figure the customer
 * is checking.
 */
import { renderReturnReceipt, type ReturnReceiptData } from './return-receipt.template';

/** A 1x1 transparent GIF, inlined the way the service inlines a real logo. */
const LOGO = 'data:image/webp;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function makeReceipt(overrides: Partial<ReturnReceiptData> = {}): ReturnReceiptData {
  return {
    storeName: 'Kandy Apparel',
    branchName: 'Main Branch',
    registerName: 'Register 1',
    returnNumber: 'R-000004',
    originalSaleNumber: 'S-000046',
    dateTime: '14 Sept 2026, 13:46',
    documentType: 'Refund Receipt',
    customerName: null,
    cashierName: 'Nimal Perera',
    approverName: 'Nimal Perera',
    items: [
      {
        name: 'Cotton T-Shirt',
        sku: 'TSH-CRW-03',
        quantity: 1,
        unitPrice: 1850,
        discountAdjustment: 0,
        refundableAmount: 1850,
        reason: 'Damaged',
        condition: 'Damaged',
      },
    ],
    subtotal: 1850,
    productDiscountAdjustment: 0,
    orderDiscountAdjustment: 0,
    taxAdjustment: 0,
    refundTotal: 1850,
    refundMethod: 'Cash',
    refundReference: null,
    remainingSaleValue: 2450,
    syncStatus: null,
    footer: 'Thank you for your purchase!',
    ...overrides,
  };
}

/** The text a person reads off the paper. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('D174 — the logo on the refund slip', () => {
  it('prints the logo as inlined bytes when one is configured', () => {
    const html = renderReturnReceipt(makeReceipt({ logoDataUri: LOGO }));

    expect(html).toContain('<img src="data:image/webp;base64,');
    // Not a path. A src the print iframe cannot resolve is D172's A4 defect.
    expect(html).not.toContain('src="/uploads/');
    expect(text(html)).toContain('Kandy Apparel');
  });

  it('prints no image at all when no logo is configured', () => {
    const html = renderReturnReceipt(makeReceipt());

    expect(html).not.toContain('<img');
    expect(text(html)).toContain('Kandy Apparel');
  });

  it('treats an explicit null the same as an absent logo', () => {
    // `inlineImage` returns null on every failure path, so this is the shape a
    // storage outage produces — not a hypothetical.
    expect(renderReturnReceipt(makeReceipt({ logoDataUri: null }))).not.toContain('<img');
  });

  it('leaves the money on the slip untouched', () => {
    const withLogo = text(renderReturnReceipt(makeReceipt({ logoDataUri: LOGO })));

    // The header is decoration; this document's job is the figure below it.
    expect(withLogo).toContain('Rs. 1,850.00');
    expect(withLogo).toContain('R-000004');
    expect(withLogo).toContain('S-000046');
    expect(withLogo).toContain('Refund Receipt');
  });

  it('keeps the return/refund stamp, which the logo must not push out', () => {
    // The loudest thing on the page, deliberately: a refund slip mistaken for a
    // sales receipt is a slip that can be presented as proof of purchase.
    const html = renderReturnReceipt(makeReceipt({ logoDataUri: LOGO }));
    expect(text(html)).toContain('RETURN / REFUND');
  });
});
