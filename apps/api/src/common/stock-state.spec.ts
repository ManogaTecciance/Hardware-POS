import { Prisma } from '@hardware-pos/database';

import { aggregateVariantStock, stockStateFor, type VariantStockCell } from './stock-state';
import {
  aggregate,
  aggregateByVariant,
} from '../modules/providers/inventory/local-inventory.provider';

/**
 * D99 (1c.6) — a product with variants derives its stock from the variant rows.
 *
 * The rule this pins is "stock is tracked by variant id, not product id". The
 * parent's own `quantityOnHand` is the D10 rollup mirror and had drifted to 350
 * against 22 real units; the till showed the 350. Per D30 each case asserts the
 * expected state positively AND that the wrong one is not produced.
 */

const d = (n: number) => new Prisma.Decimal(n);

function cell(qty: number, reorderLevel: number | null = null): VariantStockCell {
  return { qty: d(qty), reorderLevel: reorderLevel === null ? null : d(reorderLevel) };
}

describe('aggregateVariantStock — quantity', () => {
  it('sums across sizes', () => {
    // The real shape of the drift: four sizes holding 22 between them.
    const { quantity } = aggregateVariantStock([cell(12), cell(7), cell(0), cell(3)]);

    expect(quantity.toFixed(3)).toBe('22.000');
    // Negative assertion: the mirror's 350 must not be reachable from here. The
    // helper is never given the parent number, and this is what says so.
    expect(quantity.equals(d(350))).toBe(false);
  });

  it('sums fractional quantities without a float boundary (D59)', () => {
    // 0.1 + 0.2 is the classic float trap; Decimal must give exactly 0.3.
    const { quantity } = aggregateVariantStock([cell(0.1), cell(0.2)]);

    expect(quantity.toFixed(3)).toBe('0.300');
  });
});

describe('aggregateVariantStock — state', () => {
  it('is OUT only when EVERY size is out', () => {
    expect(aggregateVariantStock([cell(0), cell(0)]).state).toBe('OUT');
  });

  it('is IN_STOCK when one size remains, even if the others are gone', () => {
    // The behaviour that matters on the shop floor: a shirt with no Mediums is
    // still a sellable shirt. Greying the card would hide the Larges.
    const { state } = aggregateVariantStock([cell(0), cell(0), cell(4)]);

    expect(state).toBe('IN_STOCK');
    expect(state).not.toBe('OUT');
  });

  it('is LOW when every size is at or below its OWN reorder point', () => {
    // Each size is asked against its own threshold — a product-level threshold
    // could not express "3 brushes is low but 3 tins is not".
    const { state } = aggregateVariantStock([cell(2, 5), cell(1, 10)]);

    expect(state).toBe('LOW');
    expect(state).not.toBe('IN_STOCK');
  });

  it('is IN_STOCK when one size is comfortable and another is low', () => {
    expect(aggregateVariantStock([cell(2, 5), cell(50, 10)]).state).toBe('IN_STOCK');
  });

  it('never returns UNTRACKED — that question is settled before it is called', () => {
    // The first version of this helper had an `every(UNTRACKED)` branch and a
    // test named for it that asserted OUT. The branch was unreachable
    // (`stockStateFor` cannot return UNTRACKED) and the test proved nothing.
    //
    // The honest assertion is a total one: across zeros, lows and healthy
    // quantities, UNTRACKED is not among the outcomes. A tenant that tracks no
    // stock is answered by the caller's `tracksStock` guard, never here.
    const cases: VariantStockCell[][] = [
      [cell(0)],
      [cell(0), cell(0)],
      [cell(2, 5)],
      [cell(9, 5)],
      [cell(0), cell(4)],
      [],
    ];

    const states = cases.map((c) => aggregateVariantStock(c).state);

    expect(states).not.toContain('UNTRACKED');
    // Positive half — the set of states it DOES produce, exactly (D30 prefers an
    // exact set to a count).
    expect(new Set(states)).toEqual(new Set(['OUT', 'LOW', 'IN_STOCK']));
  });

  it('treats a product with no variant rows as OUT, not IN_STOCK', () => {
    // A variant product whose sizes have no BranchInventory rows has genuinely
    // nothing to sell. Defaulting the other way would let it be added to a cart
    // and refused at checkout.
    const { state, quantity } = aggregateVariantStock([]);

    expect(state).toBe('OUT');
    expect(quantity.toFixed(3)).toBe('0.000');
  });
});

describe('stockStateFor is the single threshold rule', () => {
  it('classifies each size the same way the aggregate does', () => {
    // Guards against the aggregate growing its own copy of "low" — the drift
    // that would badge a variant differently from its product on one screen.
    expect(stockStateFor(d(0), null)).toBe('OUT');
    expect(stockStateFor(d(3), d(5))).toBe('LOW');
    expect(stockStateFor(d(9), d(5))).toBe('IN_STOCK');

    expect(aggregateVariantStock([cell(3, 5)]).state).toBe('LOW');
    expect(aggregateVariantStock([cell(9, 5)]).state).toBe('IN_STOCK');
  });
});

/**
 * D99 (2.15) — the restaurant path through `restoreStock` did not change.
 *
 * 1a.20 switched `restoreStock` from `aggregate` (keyed by product) to
 * `aggregateByVariant` (keyed by product+variant). RESTAURANT tenants run LOCAL
 * inventory, so they go through this provider, and `RoundDepletionService`
 * restores voided items through it.
 *
 * Their lines always carry `productVariantId: null` (D65 — rounds deplete
 * through components at product level), so the two functions must agree
 * exactly for that shape. Asserted rather than reasoned about, because "it
 * looks equivalent" is how a shared-code change breaks somebody else's module.
 */
describe('aggregateByVariant matches aggregate for product-level lines', () => {
  const line = (productId: string, name: string, quantity: number, trackInventory = true) => ({
    productId,
    productVariantId: null,
    productName: name,
    quantity,
    trackInventory,
  });

  it('produces the same products, quantities and names', () => {
    const lines = [
      line('bun', 'Bun', 2),
      line('patty', 'Patty', 1),
      line('bun', 'Bun', 3), // same product twice — must sum, not overwrite
    ];

    const old = aggregate(lines);
    const now = aggregateByVariant(lines);

    expect(now.map((t) => t.productId).sort()).toEqual([...old.keys()].sort());
    for (const t of now) {
      expect(t.qty).toBe(old.get(t.productId)!.qty);
      expect(t.name).toBe(old.get(t.productId)!.name);
      // The restaurant shape: never a variant.
      expect(t.productVariantId).toBeNull();
    }
    expect(now.find((t) => t.productId === 'bun')!.qty).toBe(5);
  });

  it('skips untracked lines identically', () => {
    // D65 — a SERVICE line or an unmigrated null-product line moves nothing.
    const lines = [line('bun', 'Bun', 2, false), line('patty', 'Patty', 1)];

    expect(aggregateByVariant(lines).map((t) => t.productId)).toEqual([...aggregate(lines).keys()]);
    expect(aggregateByVariant(lines)).toHaveLength(1);
  });

  it('an empty round aggregates to nothing on both', () => {
    expect(aggregateByVariant([])).toEqual([]);
    expect(aggregate([]).size).toBe(0);
  });
});
