/**
 * D58 — the settlement projection (convergence plan §13.1,
 * `sale-item-projection`).
 *
 * The projection is a COPY, so most of what can go wrong is a dropped or
 * transformed field. Each field is asserted individually against a fixture
 * whose values are all distinct, so a swapped mapping (name into notes, say)
 * cannot pass. The sum invariant is exercised in both directions — a
 * projection that matched an empty list, or an assertion that never threw,
 * would make the in-transaction guard in closeSession decorative.
 */
import { Prisma, SaleItemSourceKind } from '@hardware-pos/database';

import {
  assertProjectionMatchesSubtotal,
  projectOrderItems,
  type ProjectableOrderItem,
} from './settlement-projection';

const D = (v: string | number) => new Prisma.Decimal(v);

function item(over: Partial<ProjectableOrderItem> = {}): ProjectableOrderItem {
  return {
    id: 'roi_1',
    menuItemName: 'Classic Burger',
    unitPrice: D('1450.00'),
    modifierTotal: D('200.00'),
    quantity: D('2'),
    specialInstructions: 'no onions',
    productId: 'prd_1',
    productVariantId: 'var_1',
    variantNameSnapshot: 'Double',
    modifiers: [
      { modifierOptionId: 'mo_1', optionName: 'Bacon', groupName: 'Extras', priceDelta: D('200.00') },
    ],
    ...over,
  };
}

describe('projectOrderItems', () => {
  it('copies every snapshot field and derives only the line totals', () => {
    const [line] = projectOrderItems([item()]);

    expect(line.sourceKind).toBe(SaleItemSourceKind.RESTAURANT_ORDER_ITEM);
    expect(line.sourceItemId).toBe('roi_1');
    expect(line.productId).toBe('prd_1');
    expect(line.productVariantId).toBe('var_1');
    expect(line.productName).toBe('Classic Burger');
    expect(line.variantNameSnapshot).toBe('Double');
    expect(line.notes).toBe('no onions');
    expect(line.unitPrice.toFixed(2)).toBe('1450.00');
    expect(line.modifierTotal.toFixed(2)).toBe('200.00');
    // (1450 + 200) × 2 — the bill's own formula, not a new one.
    expect(line.lineTotal.toFixed(2)).toBe('3300.00');
    expect(line.lineSubtotal.toFixed(2)).toBe('3300.00');
    expect(line.modifiers).toEqual([
      {
        modifierOptionId: 'mo_1',
        optionName: 'Bacon',
        groupName: 'Extras',
        priceDelta: D('200.00'),
      },
    ]);
  });

  it('a menu-item line with no product projects with null product references', () => {
    const [line] = projectOrderItems([
      item({ productId: null, productVariantId: null, variantNameSnapshot: null }),
    ]);
    expect(line.productId).toBeNull();
    expect(line.productVariantId).toBeNull();
    // The document keeps its meaning through the snapshot.
    expect(line.productName).toBe('Classic Burger');
  });

  it('fractional modifier deltas survive as Decimal — no float drift', () => {
    // The D52 lesson: 0.10 + 0.20 summed as floats is 0.30000000000000004.
    const [line] = projectOrderItems([
      item({ unitPrice: D('0.10'), modifierTotal: D('0.20'), quantity: D('3') }),
    ]);
    expect(line.lineTotal.toFixed(2)).toBe('0.90');
  });
});

describe('assertProjectionMatchesSubtotal', () => {
  const lines = projectOrderItems([
    item(),
    item({ id: 'roi_2', unitPrice: D('500.00'), modifierTotal: D('0'), quantity: D('1') }),
  ]);
  const matching = D('3800.00'); // 3300 + 500

  it('accepts a document whose parts sum to its subtotal', () => {
    expect(() => assertProjectionMatchesSubtotal(lines, matching)).not.toThrow();
  });

  it('refuses one cent of disagreement, naming both figures', () => {
    expect(() => assertProjectionMatchesSubtotal(lines, D('3800.01'))).toThrow(
      /3800\.00.*3800\.01/,
    );
  });

  it('an empty projection only matches a zero subtotal', () => {
    // The vacuity guard: if the projection silently produced no lines, the
    // invariant must fail the close rather than bless an empty document.
    expect(() => assertProjectionMatchesSubtotal([], D('0'))).not.toThrow();
    expect(() => assertProjectionMatchesSubtotal([], matching)).toThrow(/0\.00/);
  });
});
