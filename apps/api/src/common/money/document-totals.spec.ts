/**
 * D59 — the one money engine, and the differential proof against the float
 * pipeline it replaced (convergence plan §13.3).
 *
 * ## The legacy reference lives HERE
 *
 * The float pipeline below is a verbatim copy of the arithmetic that shipped
 * in `sales.service.ts` / `quotations.calc.ts` (round2 with the EPSILON
 * nudge, per-step rounding, min-with-base discounts). It is preserved in this
 * spec as the reference so the claim "the Decimal engine agrees with what
 * production charged" is checked against the real formulas, not a memory of
 * them.
 *
 * ## What equality means, exactly (measured, not assumed)
 *
 * Wherever NO pre-rounding figure sits on an exact half-cent, the two
 * engines agree TO THE CENT, unconditionally — asserted over 5,000 seeded
 * carts. At an exact half-cent (x.xx5) the float engine's answer depended on
 * the VALUE'S MAGNITUDE: the `+ Number.EPSILON` nudge rescues small figures
 * (10% of 19.85 rounds up correctly) but is smaller than one ulp for large
 * ones (15% of 15,185.50 → raw 227782.49999999997 → rounds DOWN to
 * 2,277.82). The Decimal engine rounds every mathematical half up. Each
 * atomic rounding differs by at most one cent; derived fields can compound a
 * cent per upstream boundary. That magnitude-dependent misrounding is the
 * defect D-7 named, and its correction is the ONE recorded behaviour change
 * of D59 — pinned below so it can never regress into silence.
 */
import { OrderChannel, Prisma } from '@hardware-pos/database';

import {
  RETAIL_CHARGE_CONFIG,
  computeDocumentLine,
  computeDocumentTotals,
  discountAmountOf,
  type DocumentDiscountType,
} from './document-totals';

// ── the legacy float reference (verbatim formulas) ──────────────────────────

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function sum2(values: number[]): number {
  return round2(values.reduce((acc, v) => acc + v, 0));
}
function legacyDiscount(base: number, type: DocumentDiscountType | null, value: number | null): number {
  if (!type || value == null || value <= 0) return 0;
  if (type === 'PERCENTAGE') return Math.min(base, round2((base * value) / 100));
  return Math.min(base, round2(value));
}

interface LegacyLineInput {
  unitPrice: number;
  quantity: number;
  discountType: DocumentDiscountType | null;
  discountValue: number | null;
}

function legacyTotals(
  lines: LegacyLineInput[],
  orderDiscount: { type: DocumentDiscountType | null; value: number | null },
  taxRatePercent: number,
) {
  const computed = lines.map((l) => {
    const lineSubtotal = round2(l.unitPrice * l.quantity);
    const discountAmount = legacyDiscount(lineSubtotal, l.discountType, l.discountValue);
    return { lineSubtotal, discountAmount, lineTotal: round2(lineSubtotal - discountAmount) };
  });
  const subtotal = sum2(computed.map((l) => l.lineSubtotal));
  const totalDiscount = sum2(computed.map((l) => l.discountAmount));
  const discountedSubtotal = round2(subtotal - totalDiscount);
  const orderDiscountAmount = legacyDiscount(discountedSubtotal, orderDiscount.type, orderDiscount.value);
  const taxable = round2(discountedSubtotal - orderDiscountAmount);
  const taxAmount = taxRatePercent > 0 ? round2((taxable * taxRatePercent) / 100) : 0;
  const total = round2(taxable + taxAmount);
  return { subtotal, totalDiscount, orderDiscountAmount, taxAmount, total };
}

// ── deterministic corpus ────────────────────────────────────────────────────

/** mulberry32 — seeded so a failure names a reproducible case. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Is any half-cent boundary crossed anywhere in the Decimal recomputation? */
function hasHalfCentBoundary(
  lines: LegacyLineInput[],
  orderDiscount: { type: DocumentDiscountType | null; value: number | null },
  taxRatePercent: number,
): boolean {
  const onHalf = (v: Prisma.Decimal) => {
    const scaled = v.mul(100);
    return !scaled.equals(scaled.toDecimalPlaces(0)) && scaled.mul(2).equals(scaled.mul(2).toDecimalPlaces(0));
  };
  const D = (n: number) => new Prisma.Decimal(n);
  let sub = D(0);
  let disc = D(0);
  for (const l of lines) {
    const ls = D(l.unitPrice).mul(l.quantity);
    if (onHalf(ls)) return true;
    const ls2 = ls.toDecimalPlaces(2);
    if (l.discountType === 'PERCENTAGE' && l.discountValue != null) {
      const raw = ls2.mul(l.discountValue).div(100);
      if (onHalf(raw)) return true;
      disc = disc.plus(Prisma.Decimal.min(ls2, raw.toDecimalPlaces(2)));
    } else if (l.discountType === 'FIXED' && l.discountValue != null && l.discountValue > 0) {
      disc = disc.plus(Prisma.Decimal.min(ls2, D(l.discountValue).toDecimalPlaces(2)));
    }
    sub = sub.plus(ls2);
  }
  const base = sub.minus(disc);
  let orderAmt = D(0);
  if (orderDiscount.type === 'PERCENTAGE' && orderDiscount.value != null) {
    const raw = base.mul(orderDiscount.value).div(100);
    if (onHalf(raw)) return true;
    orderAmt = Prisma.Decimal.min(base, raw.toDecimalPlaces(2));
  } else if (orderDiscount.type === 'FIXED' && orderDiscount.value != null && orderDiscount.value > 0) {
    orderAmt = Prisma.Decimal.min(base, D(orderDiscount.value).toDecimalPlaces(2));
  }
  const taxRaw = base.minus(orderAmt).mul(taxRatePercent).div(100);
  return onHalf(taxRaw);
}

function engineFor(lines: LegacyLineInput[], orderDiscount: { type: DocumentDiscountType | null; value: number | null }, taxRatePercent: number) {
  const t = computeDocumentTotals(
    lines,
    OrderChannel.COUNTER,
    { ...RETAIL_CHARGE_CONFIG, taxRatePercent },
    orderDiscount,
  );
  return {
    subtotal: t.subtotal.toNumber(),
    totalDiscount: t.totalLineDiscount.toNumber(),
    orderDiscountAmount: t.orderDiscountAmount.toNumber(),
    taxAmount: t.taxAmount.toNumber(),
    total: t.total.toNumber(),
  };
}

describe('D59 differential: Decimal engine vs the legacy float pipeline', () => {
  it('agrees to the cent everywhere off half-cent boundaries; diverges only ON them, bounded', () => {
    const rand = rng(0xd59);
    let boundaryCases = 0;
    let divergences = 0;
    for (let i = 0; i < 5000; i++) {
      // Mixed corpus: integer-valued and arbitrary-2dp carts both included —
      // integer inputs can still produce half-cent tax bases (15,185.50 at
      // 15% is one), which is exactly why the boundary gate is computed, not
      // assumed from the input shape.
      const twoDp = i % 2 === 1;
      const price = () =>
        twoDp ? Math.round(rand() * 500_00) / 100 : 1 + Math.floor(rand() * 5000);
      const val = () => (twoDp ? Math.round(rand() * 40_00) / 100 : 1 + Math.floor(rand() * 40));
      const lines: LegacyLineInput[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ({
        unitPrice: price(),
        quantity: 1 + Math.floor(rand() * 9),
        discountType: rand() < 0.45 ? (rand() < 0.55 ? 'PERCENTAGE' : 'FIXED') : null,
        discountValue: val(),
      }));
      const orderDiscount = {
        type: (rand() < 0.3 ? 'PERCENTAGE' : null) as DocumentDiscountType | null,
        value: val(),
      };
      const taxRate = [0, 5, 8, 15, 18, 20][Math.floor(rand() * 6)];

      const legacy = legacyTotals(lines, orderDiscount, taxRate);
      const engine = engineFor(lines, orderDiscount, taxRate);
      const boundary = hasHalfCentBoundary(lines, orderDiscount, taxRate);
      if (boundary) boundaryCases += 1;

      const fields = ['subtotal', 'totalDiscount', 'orderDiscountAmount', 'taxAmount', 'total'] as const;
      const diffs = fields.filter((f) => Math.abs(engine[f] - legacy[f]) > 1e-9);

      if (!boundary) {
        // The load-bearing universal: off the boundary, cent-exact equality.
        expect({ i, ...engine }).toEqual({ i, ...legacy });
      } else if (diffs.length > 0) {
        divergences += 1;
        for (const f of fields) {
          // One cent per atomic rounding; `total` sits downstream of the
          // discount and tax roundings and may compound one cent per
          // upstream boundary. Anything beyond that is a real bug.
          const bound = f === 'total' ? 0.0300001 : 0.0200001;
          expect({ i, f, within: Math.abs(engine[f] - legacy[f]) <= bound }).toEqual({
            i,
            f,
            within: true,
          });
        }
      }
    }
    // POSITIVE CONTROLS: both claims quantified over something real.
    expect(boundaryCases).toBeGreaterThan(50);
    expect(divergences).toBeGreaterThan(0);
  });

  it('pins the canonical misrounding: 15% of 15,185.50 — float 2,277.82, Decimal 2,277.83', () => {
    /*
     * 15,185.50 × 15% = 2,277.825 exactly — a mathematical half, so the
     * correct 2dp figure is 2,277.83. In float the product is
     * 227782.49999999997 and the EPSILON nudge (2.2e-16) is far below one
     * ulp at that magnitude, so the legacy engine rounded DOWN. Contrast
     * 10% of 19.85 (= 1.985): at that magnitude the nudge crosses the half
     * and legacy agreed with the mathematical answer. Correctness that
     * depends on how many digits the bill has is the D-7 defect; the engine
     * answers 2,277.83 regardless of magnitude.
     */
    const lines: LegacyLineInput[] = [{ unitPrice: 15185.5, quantity: 1, discountType: null, discountValue: null }];
    const legacy = legacyTotals(lines, { type: null, value: null }, 15);
    const engine = engineFor(lines, { type: null, value: null }, 15);
    expect(legacy.taxAmount).toBe(2277.82);
    expect(engine.taxAmount).toBe(2277.83);

    // The small-magnitude case where the nudge happened to save the float
    // engine — both agree, proving the divergence class is exactly "halves
    // the nudge cannot reach", not "all halves".
    const small: LegacyLineInput[] = [{ unitPrice: 19.85, quantity: 1, discountType: 'PERCENTAGE', discountValue: 10 }];
    expect(legacyTotals(small, { type: null, value: null }, 0).totalDiscount).toBe(1.99);
    expect(engineFor(small, { type: null, value: null }, 0).totalDiscount).toBe(1.99);
  });

  it('parts always sum to total, with every charge in play', () => {
    const rand = rng(0xcafe);
    for (let i = 0; i < 500; i++) {
      const t = computeDocumentTotals(
        [
          { unitPrice: Math.round(rand() * 300_00) / 100, quantity: 1 + Math.floor(rand() * 4), modifierTotal: Math.round(rand() * 20_00) / 100 },
          { unitPrice: Math.round(rand() * 100_00) / 100, quantity: 1 },
        ],
        OrderChannel.TAKEAWAY,
        {
          taxRatePercent: 18,
          serviceChargePercent: 10,
          serviceChargeChannels: [OrderChannel.DINE_IN, OrderChannel.TAKEAWAY],
          serviceChargeTaxable: true,
          packagingChargeAmount: new Prisma.Decimal('50.00'),
          packagedChannels: [OrderChannel.TAKEAWAY, OrderChannel.ONLINE],
        },
        { type: 'PERCENTAGE', value: 5 },
      );
      const parts = t.subtotal
        .minus(t.totalLineDiscount)
        .minus(t.orderDiscountAmount)
        .plus(t.serviceChargeAmount)
        .plus(t.packagingCharge)
        .plus(t.taxAmount);
      expect(parts.equals(t.total)).toBe(true);
    }
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-unit fixed discounts (main, 2026-09-07; merged into the engine)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Main implemented the UNIT basis twice in float arithmetic — once in the sale
 * pipeline, once in the quotation calc, each with a comment saying it had to
 * match the other to the cent. The merge routed both through this engine, so the
 * rule is stated once and proven once, in Decimal.
 */
describe('discount basis', () => {
  it('LINE is the default and the historic meaning: a FIXED amount comes off the line once', () => {
    const withoutBasis = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'FIXED', discountValue: 10 });
    const explicitLine = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'FIXED', discountValue: 10, discountBasis: 'LINE' });
    expect(withoutBasis.discountAmount.toFixed(2)).toBe('10.00');
    expect(explicitLine.discountAmount.toFixed(2)).toBe('10.00');
    expect(withoutBasis.lineTotal.toFixed(2)).toBe('290.00');
  });

  it('UNIT multiplies a FIXED amount by the quantity', () => {
    const line = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'FIXED', discountValue: 10, discountBasis: 'UNIT' });
    expect(line.discountAmount.toFixed(2)).toBe('30.00');
    expect(line.lineTotal.toFixed(2)).toBe('270.00');
  });

  it('UNIT is meaningless for a percentage and changes nothing', () => {
    // The API refuses a UNIT percentage before it reaches here; the engine must
    // not multiply one if it ever does. 10% of 300 is 30 on either basis.
    const unit = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'PERCENTAGE', discountValue: 10, discountBasis: 'UNIT' });
    const line = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'PERCENTAGE', discountValue: 10, discountBasis: 'LINE' });
    expect(unit.discountAmount.toFixed(2)).toBe('30.00');
    expect(unit.discountAmount.toFixed(2)).toBe(line.discountAmount.toFixed(2));
  });

  it('the clamp is load-bearing: a per-unit amount larger than the price floors the line at zero', () => {
    // A Rs. 2,000-per-unit discount on a Rs. 1,000 item must not go negative — a
    // negative line would pay money OUT through the returns reversal.
    const line = computeDocumentLine({ unitPrice: 1000, quantity: 2, discountType: 'FIXED', discountValue: 2000, discountBasis: 'UNIT' });
    expect(line.discountAmount.toFixed(2)).toBe('2000.00');
    expect(line.lineTotal.toFixed(2)).toBe('0.00');
  });

  it('multiplies first and rounds once, so a quotation converts to a sale on the same cent', () => {
    // 0.335 × 3 = 1.005 → 1.01 (round once). Rounding first would give 0.34 × 3 = 1.02.
    const line = computeDocumentLine({ unitPrice: 10, quantity: 3, discountType: 'FIXED', discountValue: 0.335, discountBasis: 'UNIT' });
    expect(line.discountAmount.toFixed(2)).toBe('1.01');
    expect(line.discountAmount.toFixed(2)).not.toBe('1.02');
  });

  it('discountAmountOf is the same arithmetic the line uses — the two former float copies collapse to it', () => {
    const line = computeDocumentLine({ unitPrice: 12.5, quantity: 4, discountType: 'FIXED', discountValue: 3, discountBasis: 'UNIT' });
    const standalone = discountAmountOf(50, 'FIXED', 3, { basis: 'UNIT', units: 4 });
    expect(standalone.toFixed(2)).toBe(line.discountAmount.toFixed(2));
    expect(standalone.toFixed(2)).toBe('12.00');
    // …and with no basis it is the whole-line amount, which is what the order
    // discount and every pre-merge caller mean.
    expect(discountAmountOf(50, 'FIXED', 3).toFixed(2)).toBe('3.00');
  });

  it('the order-level discount never picks up a basis: a cart has no units to be "per"', () => {
    const totals = computeDocumentTotals(
      [{ unitPrice: 100, quantity: 3, discountBasis: 'UNIT' }],
      'COUNTER',
      { ...RETAIL_CHARGE_CONFIG, taxRatePercent: 0 },
      { type: 'FIXED', value: 10 },
    );
    expect(totals.orderDiscountAmount.toFixed(2)).toBe('10.00');
    expect(totals.total.toFixed(2)).toBe('290.00');
  });

  // MUTATION PROOFS (D30), inline: the two ways this could regress, shown to
  // produce a different figure from the engine.
  describe('the basis can actually fail', () => {
    it('M1: ignoring the basis makes UNIT read as LINE', () => {
      const ignored = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'FIXED', discountValue: 10 }).discountAmount;
      const honoured = computeDocumentLine({ unitPrice: 100, quantity: 3, discountType: 'FIXED', discountValue: 10, discountBasis: 'UNIT' }).discountAmount;
      expect(ignored.toFixed(2)).toBe('10.00');
      expect(honoured.toFixed(2)).toBe('30.00');
    });
    it('M2: rounding before multiplying is detectable on a half-cent boundary', () => {
      const roundFirst = (Math.round(0.335 * 100) / 100) * 3; // 0.34 × 3
      expect(roundFirst.toFixed(2)).toBe('1.02');
      expect(computeDocumentLine({ unitPrice: 10, quantity: 3, discountType: 'FIXED', discountValue: 0.335, discountBasis: 'UNIT' }).discountAmount.toFixed(2)).toBe('1.01');
    });
  });
});
