/**
 * `8.4` — the report tax allocator, and its parity with the printed document.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The property that matters is not "the numbers look right", it is **the report
 * and the receipt divide the same tax the same way**. That is asserted by
 * running BOTH implementations over the same inputs and comparing, not by
 * restating the expected figures twice — a shared expectation would pass even if
 * both drifted together, but a shared expectation is not what this does: the
 * document helper is the one that ships today and is the reference.
 *
 * The parity cases are chosen to exercise the remainder rule (a recorded tax
 * that cannot divide evenly), the order-discount share, and multiple rates.
 * Single-rate parity is asserted NEGATIVELY and deliberately: the document
 * prints nothing there, this allocator must still allocate, and a test that
 * demanded agreement would enshrine the wrong behaviour.
 */

import { Prisma } from '@hardware-pos/database';
import { taxBreakdownForDocument, type TaxableLine } from '@hardware-pos/shared';

import { allocateSaleTax, type AllocatableLine, type AllocatableSale } from './report-tax-allocation';

const d = (v: number | string): Prisma.Decimal => new Prisma.Decimal(v);

/** Σ lineTotal is the discounted subtotal by construction (D123). */
function saleOf(lines: AllocatableLine[], tax: number, orderDiscount = 0): AllocatableSale {
  const subtotal = lines.reduce((acc, l) => acc.plus(d(l.lineTotal as number)), d(0));
  return {
    subtotal,
    totalDiscount: 0,
    orderDiscountAmount: orderDiscount,
    taxAmount: tax,
  };
}

describe('allocateSaleTax', () => {
  it('gives the whole tax to the only rated line', () => {
    const lines = [{ lineTotal: 1000, taxRatePercent: 18 }];
    const out = allocateSaleTax(lines, saleOf(lines, 180));

    expect(out).toHaveLength(1);
    expect(out[0]!.tax.toFixed(2)).toBe('180.00');
    expect(out[0]!.taxable.toFixed(2)).toBe('1000.00');
    expect(out[0]!.ratePercent!.toFixed(2)).toBe('18.00');
  });

  it('splits by taxable × rate, not by taxable alone', () => {
    // Equal amounts at 18% and 8%: an implementation weighting by amount only
    // would give 90/90 and pass any "sums to 180" assertion. The correct split
    // is 18:8, i.e. 124.62 / 55.38.
    const lines = [
      { lineTotal: 1000, taxRatePercent: 18 },
      { lineTotal: 1000, taxRatePercent: 8 },
    ];
    const out = allocateSaleTax(lines, saleOf(lines, 180));

    expect(out.map((o) => o.tax.toFixed(2))).toEqual(['124.62', '55.38']);
    expect(out[0]!.tax.plus(out[1]!.tax).toFixed(2)).toBe('180.00');
  });

  it('charges a zero-rated line nothing while it still appears', () => {
    const lines = [
      { lineTotal: 1000, taxRatePercent: 18 },
      { lineTotal: 500, taxRatePercent: 0 },
    ];
    const out = allocateSaleTax(lines, saleOf(lines, 180));

    expect(out[1]!.tax.toFixed(2)).toBe('0.00');
    // Positively: the exempt line is still reported, with its taxable value, so
    // "we sold 500 at zero rate" is a fact the report can state. Dropping it
    // would make an exempt shop's report look empty rather than zero-rated.
    expect(out[1]!.taxable.toFixed(2)).toBe('500.00');
    expect(out[1]!.ratePercent!.toFixed(2)).toBe('0.00');
    expect(out[0]!.tax.toFixed(2)).toBe('180.00');
  });

  it('takes the order discount out of the taxable base, proportionally', () => {
    // 100 off a 2000 basket: each 1000 line carries 50 of it.
    const lines = [
      { lineTotal: 1000, taxRatePercent: 18 },
      { lineTotal: 1000, taxRatePercent: 18 },
    ];
    const out = allocateSaleTax(lines, saleOf(lines, 342, 100));

    expect(out.map((o) => o.taxable.toFixed(2))).toEqual(['950.00', '950.00']);
    expect(out.map((o) => o.tax.toFixed(2))).toEqual(['171.00', '171.00']);
  });

  it('makes the parts add up when the split does not divide evenly', () => {
    // 0.01 across three equal lines cannot divide into thirds. Each rounds to
    // 0.00 and the largest absorbs the whole cent, so the sum is still 0.01.
    const lines = [
      { lineTotal: 100, taxRatePercent: 18 },
      { lineTotal: 100, taxRatePercent: 18 },
      { lineTotal: 100, taxRatePercent: 18 },
    ];
    const out = allocateSaleTax(lines, saleOf(lines, 0.01));

    const total = out.reduce((acc, o) => acc.plus(o.tax), d(0));
    expect(total.toFixed(2)).toBe('0.01');
    // And it is one line that carries it, not a third of a cent spread about.
    expect(out.filter((o) => !o.tax.isZero())).toHaveLength(1);
  });

  it('refuses to attribute a pre-3.8 sale, rather than guessing', () => {
    // `null` is "written before 3.8", not "zero-rated". Attributing this sale's
    // tax to the standard rate would put money in a row that cannot be
    // substantiated from the sale itself.
    const lines = [
      { lineTotal: 1000, taxRatePercent: null },
      { lineTotal: 500, taxRatePercent: 18 },
    ];
    const out = allocateSaleTax(lines, saleOf(lines, 180));

    expect(out.map((o) => o.ratePercent)).toEqual([null, null]);
    expect(out.map((o) => o.tax.toFixed(2))).toEqual(['0.00', '0.00']);
    // The taxable amounts are still known and still reported — only the
    // ATTRIBUTION is unavailable.
    expect(out.map((o) => o.taxable.toFixed(2))).toEqual(['1000.00', '500.00']);
  });

  it('divides nothing when the sale charged no tax', () => {
    const lines = [{ lineTotal: 1000, taxRatePercent: 0 }];
    const out = allocateSaleTax(lines, saleOf(lines, 0));
    expect(out[0]!.tax.toFixed(2)).toBe('0.00');
  });

  it('returns nothing for a sale with no lines', () => {
    // A restaurant Sale carries no SaleItem rows. It must not throw here.
    expect(allocateSaleTax([], saleOf([], 180))).toEqual([]);
  });

  it('is exact where a float would not be', () => {
    // 1/3 of a cent, ten thousand times over. Accumulating this in a double
    // drifts; in Decimal each step is exact and the total is the recorded tax
    // to the cent.
    const lines = Array.from({ length: 3 }, () => ({ lineTotal: 33.33, taxRatePercent: 18 }));
    let running = d(0);
    for (let i = 0; i < 10_000; i += 1) {
      const out = allocateSaleTax(lines, saleOf(lines, 17.99));
      running = out.reduce((acc, o) => acc.plus(o.tax), running);
    }
    expect(running.toFixed(2)).toBe('179900.00');
  });
});

/**
 * The parity proof.
 *
 * `taxBreakdownForDocument` is what prints on an A4 note today. If these two
 * ever divide a sale's tax differently, a manager reconciling the report against
 * a customer's receipt finds a discrepancy that neither document explains.
 */
describe('parity with the printed document breakdown', () => {
  const CASES: { name: string; lines: AllocatableLine[]; tax: number; orderDiscount?: number }[] = [
    {
      name: 'two rates, clean division',
      lines: [
        { lineTotal: 1000, taxRatePercent: 18 },
        { lineTotal: 1000, taxRatePercent: 8 },
      ],
      tax: 180,
    },
    {
      name: 'two rates, remainder to absorb',
      lines: [
        { lineTotal: 333.33, taxRatePercent: 18 },
        { lineTotal: 666.67, taxRatePercent: 5 },
      ],
      tax: 93.34,
    },
    {
      name: 'three rates including a zero-rated line',
      lines: [
        { lineTotal: 1200, taxRatePercent: 18 },
        { lineTotal: 800, taxRatePercent: 8 },
        { lineTotal: 450, taxRatePercent: 0 },
      ],
      tax: 280.0,
    },
    {
      name: 'two rates under an order discount',
      lines: [
        { lineTotal: 1500, taxRatePercent: 18 },
        { lineTotal: 500, taxRatePercent: 8 },
      ],
      tax: 315.5,
      orderDiscount: 200,
    },
  ];

  it.each(CASES)('divides "$name" exactly as the document does', ({ lines, tax, orderDiscount }) => {
    const sale = saleOf(lines, tax, orderDiscount ?? 0);

    // The document's own input shape: line net less its share of the order
    // discount, in plain numbers.
    const discountedSubtotal = Number(sale.subtotal) - Number(sale.totalDiscount);
    const docLines: TaxableLine[] = lines.map((l) => {
      const lineTotal = Number(l.lineTotal);
      const share =
        discountedSubtotal > 0 ? ((orderDiscount ?? 0) * lineTotal) / discountedSubtotal : 0;
      return { taxable: lineTotal - share, taxRatePercent: Number(l.taxRatePercent) };
    });
    const documentRows = taxBreakdownForDocument(docLines, tax);

    // POSITIVE CONTROL: the document really did produce rows for this case. Every
    // case here is multi-rate for exactly this reason — a case that produced `[]`
    // would make the comparison below vacuously true.
    expect(documentRows.length).toBeGreaterThan(1);

    // Roll the per-line allocation up per rate, which is the shape the document
    // reports in.
    const allocated = allocateSaleTax(lines, sale);
    const byRate = new Map<string, Prisma.Decimal>();
    allocated.forEach((a) => {
      const key = a.ratePercent!.toFixed(2);
      byRate.set(key, (byRate.get(key) ?? d(0)).plus(a.tax));
    });

    for (const row of documentRows) {
      const mine = byRate.get(d(row.ratePercent).toFixed(2));
      expect({ rate: row.ratePercent, tax: mine?.toFixed(2) }).toEqual({
        rate: row.ratePercent,
        tax: row.taxAmount.toFixed(2),
      });
    }
    // Same set of rates on both sides — the loop above would pass if this
    // allocator invented an extra rate nobody printed.
    expect([...byRate.keys()].sort()).toEqual(
      documentRows.map((r) => d(r.ratePercent).toFixed(2)).sort(),
    );
  });

  it('DIVERGES on a single-rate sale, deliberately', () => {
    // The document prints nothing: a breakdown that repeats the one total
    // already printed adds a row and no information. A period report is the
    // opposite case, so this allocator must still produce the figure.
    const lines = [
      { lineTotal: 1000, taxRatePercent: 18 },
      { lineTotal: 500, taxRatePercent: 18 },
    ];
    const sale = saleOf(lines, 270);

    expect(
      taxBreakdownForDocument(
        lines.map((l) => ({ taxable: Number(l.lineTotal), taxRatePercent: 18 })),
        270,
      ),
    ).toEqual([]);

    const allocated = allocateSaleTax(lines, sale);
    expect(allocated.reduce((acc, a) => acc.plus(a.tax), d(0)).toFixed(2)).toBe('270.00');
    expect(allocated.map((a) => a.tax.toFixed(2))).toEqual(['180.00', '90.00']);
  });
});
