import { round2 } from '../../common/money';
import { computeDiscount as saleComputeDiscount } from '../sales/sales.service';
import {
  computeQuotationLine,
  computeQuotationTotals,
  type QuotationLineInput,
} from './quotations.calc';

describe('computeQuotationLine', () => {
  it('multiplies unit price by quantity with no discount', () => {
    const line = computeQuotationLine({ unitPrice: 250, quantity: 3 });
    expect(line.lineSubtotal).toBe(750);
    expect(line.discountAmount).toBe(0);
    expect(line.lineTotal).toBe(750);
  });

  it('applies a percentage line discount', () => {
    const line = computeQuotationLine({
      unitPrice: 100,
      quantity: 4,
      discountType: 'PERCENTAGE',
      discountValue: 10,
    });
    expect(line.lineSubtotal).toBe(400);
    expect(line.discountAmount).toBe(40);
    expect(line.lineTotal).toBe(360);
  });

  it('applies a fixed line discount and never exceeds the line subtotal', () => {
    const line = computeQuotationLine({
      unitPrice: 100,
      quantity: 1,
      discountType: 'FIXED',
      discountValue: 250,
    });
    expect(line.discountAmount).toBe(100); // capped at the 100 subtotal
    expect(line.lineTotal).toBe(0);
  });
});

describe('computeQuotationTotals', () => {
  it('sums lines and needs no discount or tax', () => {
    const totals = computeQuotationTotals(
      [
        { unitPrice: 100, quantity: 2 },
        { unitPrice: 50, quantity: 3 },
      ],
      null,
      0,
    );
    expect(totals.subtotal).toBe(350);
    expect(totals.productDiscountTotal).toBe(0);
    expect(totals.quotationDiscountAmount).toBe(0);
    expect(totals.taxAmount).toBe(0);
    expect(totals.grandTotal).toBe(350);
  });

  it('applies product discounts then an order discount then tax, in order', () => {
    // Two lines, 400 + 200 = 600 subtotal. Line 1 has a 10% (40) discount.
    // discountedSubtotal = 560. Order 10% = 56. taxable = 504. tax 15% = 75.60.
    const totals = computeQuotationTotals(
      [
        { unitPrice: 100, quantity: 4, discountType: 'PERCENTAGE', discountValue: 10 },
        { unitPrice: 100, quantity: 2 },
      ],
      { type: 'PERCENTAGE', value: 10 },
      15,
    );
    expect(totals.subtotal).toBe(600);
    expect(totals.productDiscountTotal).toBe(40);
    expect(totals.quotationDiscountAmount).toBe(56);
    expect(totals.taxAmount).toBe(75.6);
    expect(totals.grandTotal).toBe(579.6); // 504 + 75.60
  });

  it('applies a fixed order discount capped at the discounted subtotal', () => {
    const totals = computeQuotationTotals(
      [{ unitPrice: 100, quantity: 1 }],
      { type: 'FIXED', value: 500 },
      0,
    );
    expect(totals.quotationDiscountAmount).toBe(100);
    expect(totals.grandTotal).toBe(0);
  });

  it('allocates per-line tax so the columns sum back to the order tax exactly', () => {
    const totals = computeQuotationTotals(
      [
        { unitPrice: 33.33, quantity: 1 },
        { unitPrice: 33.33, quantity: 1 },
        { unitPrice: 33.34, quantity: 1 },
      ],
      null,
      15,
    );
    const lineTaxSum = totals.lines.reduce((acc, l) => acc + l.taxAmount, 0);
    expect(Math.round(lineTaxSum * 100) / 100).toBe(totals.taxAmount);
  });

  it('handles an empty quotation', () => {
    const totals = computeQuotationTotals([], null, 15);
    expect(totals.subtotal).toBe(0);
    expect(totals.grandTotal).toBe(0);
    expect(totals.lines).toHaveLength(0);
  });
});


/**
 * A fixed line discount can come off each unit or off the line as a whole.
 *
 * The pre-existing fixed-discount case above uses a quantity of one, where the
 * two are indistinguishable — it proves the clamp, not the basis. These pin the
 * difference, and the last one pins parity with the sale pipeline, since a
 * quotation that converts must land on the same cent.
 */
describe('per-unit vs whole-line fixed discounts', () => {
  const line = (over: Partial<QuotationLineInput> = {}): QuotationLineInput => ({
    unitPrice: 250,
    quantity: 3,
    discountType: 'FIXED',
    discountValue: 100,
    ...over,
  });

  it('takes the amount once when no basis is given', () => {
    const [l] = computeQuotationTotals([line()], null, 0).lines;
    expect(l.discountAmount).toBe(100);
    expect(l.lineTotal).toBe(650);
    expect(l.discountBasis).toBe('LINE');
  });

  it('takes the amount from every unit on a per-unit basis', () => {
    const [l] = computeQuotationTotals([line({ discountBasis: 'UNIT' })], null, 0).lines;
    expect(l.discountAmount).toBe(300);
    expect(l.lineTotal).toBe(450);
  });

  it('floors the line at zero rather than going negative', () => {
    const [l] = computeQuotationTotals(
      [line({ unitPrice: 100, quantity: 2, discountValue: 2000, discountBasis: 'UNIT' })],
      null,
      0,
    ).lines;
    expect(l.discountAmount).toBe(200);
    expect(l.lineTotal).toBe(0);
  });

  it('multiplies before rounding', () => {
    // round2(33.335 * 3) = 100.01; rounding each unit first gives 100.02, and a
    // cent of drift makes a converted sale disagree with the quotation.
    const [l] = computeQuotationTotals(
      [line({ unitPrice: 100, quantity: 3, discountValue: 33.335, discountBasis: 'UNIT' })],
      null,
      0,
    ).lines;
    expect(l.discountAmount).toBe(100.01);
  });

  it('handles a fractional quantity', () => {
    const [l] = computeQuotationTotals(
      [line({ unitPrice: 100, quantity: 2.5, discountValue: 10, discountBasis: 'UNIT' })],
      null,
      0,
    ).lines;
    expect(l.discountAmount).toBe(25);
  });

  it('ignores the basis on a percentage', () => {
    // The calc stays a pure money function; the refusal lives in the service.
    const [l] = computeQuotationTotals(
      [line({ discountType: 'PERCENTAGE', discountValue: 10, discountBasis: 'UNIT' })],
      null,
      0,
    ).lines;
    expect(l.discountAmount).toBe(75);
  });

  it('leaves the whole-quotation discount alone, which has no units', () => {
    // One function serves both the line and the order discount here, so this is
    // the guard that units did not leak into the order-level path.
    const totals = computeQuotationTotals(
      [{ unitPrice: 100, quantity: 5 }],
      { type: 'FIXED', value: 500 },
      0,
    );
    expect(totals.quotationDiscountAmount).toBe(500);
  });

  it('still allocates tax to the cent when a per-unit discount zeroes a line', () => {
    const totals = computeQuotationTotals(
      [
        line({ unitPrice: 100, quantity: 2, discountValue: 500, discountBasis: 'UNIT' }),
        { unitPrice: 100, quantity: 3 },
      ],
      null,
      15,
    );
    expect(totals.lines[0].taxAmount).toBe(0);
    expect(round2(totals.lines[0].taxAmount + totals.lines[1].taxAmount)).toBe(totals.taxAmount);
  });

  it('agrees to the cent with the sale pipeline it converts into', () => {
    const [l] = computeQuotationTotals(
      [line({ unitPrice: 1000, quantity: 3, discountValue: 100, discountBasis: 'UNIT' })],
      null,
      0,
    ).lines;
    expect(l.discountAmount).toBe(
      saleComputeDiscount(3000, 'FIXED', 100, { basis: 'UNIT', quantity: 3 }),
    );
  });
});
