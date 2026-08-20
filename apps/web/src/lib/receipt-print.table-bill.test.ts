/**
 * D69 — the printed table bill.
 *
 * ## Why this is asserted on the emitted HTML
 *
 * The bill is the one customer-facing document the app produces, and every
 * failure mode here is silent: a missing currency, a fabricated tax line, or
 * a "Balance due" printed on a bill the guest already settled all look fine
 * in code review and wrong on paper. So the assertions read the document.
 *
 * Each is paired: the zero-value rows must be ABSENT when zero and PRESENT
 * when not, because a template that dropped the row unconditionally would
 * satisfy a one-sided test.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ api: { post: vi.fn() } }));
vi.mock('./document-template-service', () => ({
  getCachedDocumentProfile: () => ({ companyName: 'Axlo Cafe' }),
}));
vi.mock('./cart', () => ({ computeLine: () => ({ lineTotal: 0 }) }));
vi.mock('./utils', () => ({ formatMoney: (v: number) => `LKR ${v.toFixed(2)}` }));

const opened: string[] = [];
vi.stubGlobal('window', {
  open: () => {
    const doc = { open: () => {}, write: (h: string) => opened.push(h), close: () => {} };
    return { document: doc, focus: () => {}, print: () => {} };
  },
  clearTimeout: () => {},
  setTimeout: () => 0,
});

const { printTableBill } = await import('./receipt-print');

const base = {
  storeName: 'Axlo Cafe',
  saleNumber: 'S-000005',
  items: [
    { name: 'Beef Steak', variantName: null, quantity: '2.000', lineTotal: '6400.00' },
    { name: 'Garlic Bread', variantName: 'Large', quantity: '1.000', lineTotal: '450.00' },
  ],
  subtotal: '6850.00',
  serviceCharge: '0.00',
  packagingCharge: '0.00',
  total: '6850.00',
  paidAmount: '0.00',
  balanceAmount: '6850.00',
};

beforeEach(() => {
  opened.length = 0;
});

describe('printTableBill', () => {
  it('prints every line with its variant, quantity and money', () => {
    printTableBill(base);
    const html = opened[0]!;
    expect(html).toContain('Axlo Cafe');
    expect(html).toContain('S-000005');
    expect(html).toContain('Beef Steak');
    // "2.000" reads as machinery on a bill.
    expect(html).toContain('× 2');
    expect(html).not.toContain('× 2.000');
    // The variant is what distinguishes a Large from a Small on the paper.
    expect(html).toContain('(Large)');
    expect(html).toContain('LKR 6400.00');
  });

  it('omits zero charges but prints them when they are real', () => {
    printTableBill(base);
    // NEGATIVE — no zero rows.
    expect(opened[0]!).not.toContain('Service charge');
    expect(opened[0]!).not.toContain('Packaging');
    // Tax is never printed on a table bill: BillView carries none, so any
    // figure here would be invented.
    expect(opened[0]!).not.toContain('Tax');

    opened.length = 0;
    // POSITIVE — the same template DOES print them when nonzero, so the
    // absence above is a condition and not a missing row.
    printTableBill({ ...base, serviceCharge: '685.00', packagingCharge: '50.00' });
    expect(opened[0]!).toContain('Service charge');
    expect(opened[0]!).toContain('LKR 685.00');
    expect(opened[0]!).toContain('Packaging');
  });

  it('shows a balance only while one is owed', () => {
    printTableBill(base);
    expect(opened[0]!).toContain('Balance due');

    opened.length = 0;
    printTableBill({ ...base, paidAmount: '6850.00', balanceAmount: '0.00' });
    // A settled bill handed to a guest must not say they still owe money.
    expect(opened[0]!).not.toContain('Balance due');
    expect(opened[0]!).toContain('Paid');
  });

  it('escapes item names rather than letting them close a tag', () => {
    printTableBill({
      ...base,
      items: [{ name: '<script>x</script>', variantName: null, quantity: '1', lineTotal: '1.00' }],
    });
    expect(opened[0]!).not.toContain('<script>x</script>');
    expect(opened[0]!).toContain('&lt;script&gt;');
  });
});
