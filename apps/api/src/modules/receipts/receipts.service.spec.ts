import { ReceiptsService } from './receipts.service';
import type { ReceiptsRepository, SaleForReceipt } from './receipts.repository';
import type { SettingsService } from '../settings/settings.service';

/**
 * D165 — a reprint keeps the tender the first print recorded.
 *
 * ## What was reported
 *
 * D162–D164 put "Cash" and "Balance" on the receipt printed at the till, and
 * viewing the same bill from Sales still showed `Balance 0.00`.
 *
 * ## The cause, and why no migration was needed
 *
 * The number was already on disk. `Receipt.content` is a JSON column and the
 * receipt data is spread into it, so the FIRST print stored `amountTendered`
 * without anyone designing for it. But `upsertReceipt` overwrites `content` on
 * every print, and a reprint arrives with no tender of its own — so the first
 * reprint erased the record and then rendered without it.
 *
 * The fix reads the stored value back when the caller supplies none. Nothing
 * was missing from the schema; the bug was that we were deleting it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Each case is asserted on the RENDERED HTML, not on the argument passed
 * inward, because the defect was a value that survived one call and not the
 * next — an assertion on the call would have passed throughout.
 *
 * The "no stored tender" case is the one that stops the fix over-reaching: a
 * card sale, a credit sale and a restaurant bill have nothing stored, and must
 * still render exactly as before. And the "supplied wins" case pins the
 * precedence, because a reprint reading a stale tender over a fresh one would
 * be the same class of bug pointing the other way.
 */

type Stub = {
  repo: jest.Mocked<Pick<
    ReceiptsRepository,
    'findSaleForReceipt' | 'findReceiptBySale' | 'upsertReceipt' | 'createPrintJob'
  >>;
  service: ReceiptsService;
  /** The HTML handed to `createPrintJob` on the last call. */
  html: () => string;
};

function makeSale(): SaleForReceipt {
  return {
    id: 'sale_1',
    saleNumber: 'S-000024',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    completedAt: new Date('2026-09-11T04:05:00.000Z'),
    createdAt: new Date('2026-09-11T04:05:00.000Z'),
    quickbooksDocumentType: null,
    subtotal: 3200,
    totalDiscount: 0,
    orderDiscountAmount: 0,
    taxAmount: 576,
    total: 3776,
    paidAmount: 3776,
    balanceAmount: 0,
    customer: null,
    tenant: { name: 'Kandy Apparel' },
    items: [
      {
        productName: 'Test-3',
        variantNameSnapshot: null,
        variantSkuSnapshot: null,
        sku: 'T3',
        promotionNameSnapshot: null,
        promotionDiscountAmount: 0,
        quantity: 1,
        unitOfMeasureSnapshot: null,
        unitPrice: 3200,
        discountAmount: 0,
        discountBasis: null,
        discountValue: null,
        lineTotal: 3200,
      },
    ],
    payments: [{ method: 'CASH', amount: 3776 }],
  } as unknown as SaleForReceipt;
}

function setup(storedContent: unknown): Stub {
  let lastHtml = '';
  const repo = {
    findSaleForReceipt: jest.fn().mockResolvedValue(makeSale()),
    findReceiptBySale: jest
      .fn()
      .mockResolvedValue(storedContent === undefined ? null : { content: storedContent }),
    upsertReceipt: jest.fn().mockResolvedValue({ id: 'rcp_1', receiptNumber: 'RCP-S-000024' }),
    createPrintJob: jest.fn().mockImplementation((data: { html: string }) => {
      lastHtml = data.html;
      return Promise.resolve({ id: 'job_1', html: data.html });
    }),
  } as unknown as Stub['repo'];

  const settings = {
    getSettings: () => ({
      currency: 'LKR',
      receiptFooter: 'Thank you for your purchase!',
      timezone: 'Asia/Colombo',
    }),
  } as unknown as SettingsService;

  return {
    repo,
    service: new ReceiptsService(repo as unknown as ReceiptsRepository, settings),
    html: () => lastHtml,
  };
}

/** The text a person reads off the paper. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('D165 — a reprint keeps the tender', () => {
  it('renders the stored tender when the caller supplies none', async () => {
    // The reported defect: this is the reprint from Sales.
    const s = setup({ amountTendered: 4000 });

    await s.service.generateCustomer('t1', 'sale_1', 'usr_1');

    const out = text(s.html());
    expect(out).toContain('Paid Amount Rs. 4,000.00');
    expect(out).toContain('Bal. Amount Rs. 224.00');
    // …and the figure the ordinary layout would have printed in that same
    // row is absent, so this is genuinely the short layout. Since D167 the
    // two layouts share labels, so the VALUE is what tells them apart.
    expect(out).not.toContain('Paid Amount Rs. 3,776.00');
  });

  it('writes it back, so a second reprint still has it', async () => {
    /*
     * The half that makes the fix durable. `upsertReceipt` overwrites
     * `content` every time; if the carried-forward value were used only for
     * rendering, the second reprint would erase it again and the bug would
     * come back one print later.
     */
    const s = setup({ amountTendered: 4000 });

    await s.service.generateCustomer('t1', 'sale_1', 'usr_1');

    const written = (s.repo.upsertReceipt as jest.Mock).mock.calls[0]?.[2] as {
      amountTendered?: number;
    };
    expect(written.amountTendered).toBe(4000);
  });

  it('a supplied tender wins over the stored one', async () => {
    // The till is the authority for the sale it just took. A stale stored
    // value must never override what the operator just counted.
    const s = setup({ amountTendered: 4000 });

    await s.service.generateCustomer('t1', 'sale_1', 'usr_1', 5000);

    expect(text(s.html())).toContain('Paid Amount Rs. 5,000.00');
    expect(text(s.html())).toContain('Bal. Amount Rs. 1,224.00');
  });

  it('renders as before when nothing is stored and nothing is supplied', async () => {
    /*
     * The isolation case. A card sale, a credit sale, a restaurant bill and
     * every receipt printed before D162 have no tender on disk, and must print
     * exactly what they always printed.
     */
    const s = setup(undefined);

    await s.service.generateCustomer('t1', 'sale_1', 'usr_1');

    const out = text(s.html());
    expect(out).toContain('Paid Amount Rs. 3,776.00');
    expect(out).toContain('Bal. Amount Rs. 0.00');
    expect(out).not.toContain('Paid Amount Rs. 4,000.00');
  });

  it('ignores a stored value that is not a usable number', async () => {
    // `content` is JSON: it is written by this service, but it is still a
    // column anything could have put a shape into. A receipt that cannot be
    // re-rendered is worse than one missing a row.
    for (const junk of [{ amountTendered: 'lots' }, { amountTendered: null }, {}, null]) {
      const s = setup(junk);
      await s.service.generateCustomer('t1', 'sale_1', 'usr_1');

      // It renders the ordinary layout…
      expect(text(s.html())).toContain('Paid Amount Rs. 3,776.00');

      /*
       * …and, the half that makes the check worth having: the junk is NOT
       * written back. `content` is rewritten on every print, so a value
       * that merely fails to render would otherwise be persisted forever,
       * outliving whatever put it there.
       */
      const written = (s.repo.upsertReceipt as jest.Mock).mock.calls[0]?.[2] as Record<
        string,
        unknown
      >;
      expect(written).not.toHaveProperty('amountTendered');
    }
  });
});
