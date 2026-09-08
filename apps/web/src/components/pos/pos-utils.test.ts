/**
 * The draft-line merge rule (2026-08-18, PO decision): adding the same item
 * twice bumps the existing line's quantity instead of stacking duplicate
 * rows — but ONLY when the configuration is byte-identical.
 *
 * D30 in both directions: the one positive (identical lines merge, quantity
 * sums, the existing row and key survive) is paired with a negative for
 * every clause of the identity — variant, modifier set, instructions,
 * discount, price snapshot, and source kind — so a mergeKey that quietly
 * dropped a clause fails the specific test that names it.
 */
import { describe, expect, it } from 'vitest';

import type { DraftLine } from './pos-types';
import { addDraftLine, draftLineMergeKey } from './pos-utils';

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: over.key ?? 'k1',
    menuItemId: 'prod-steak',
    name: 'Beef Steak',
    unitPrice: '3200.00',
    quantity: 1,
    specialInstructions: '',
    modifiers: [],
    sourceKind: 'PRODUCT',
    productId: 'prod-steak',
    ...over,
  };
}

const CHEESE = { optionId: 'opt-cheese', optionName: 'Extra cheese', groupName: 'Add-ons', priceDelta: '150.00' };
const BACON = { optionId: 'opt-bacon', optionName: 'Bacon', groupName: 'Add-ons', priceDelta: '200.00' };

describe('addDraftLine — the merge rule', () => {
  it('an identical add bumps the existing line: one row, summed quantity, key preserved', () => {
    const rows = addDraftLine([line({ key: 'first', quantity: 2 })], line({ key: 'second' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(3);
    // The EXISTING row absorbed the add — no re-mount, no reorder.
    expect(rows[0]!.key).toBe('first');
  });

  it('identical modifier SETS merge regardless of pick order', () => {
    const a = line({ key: 'a', modifiers: [CHEESE, BACON] });
    const b = line({ key: 'b', modifiers: [BACON, CHEESE] });
    const rows = addDraftLine([a], b);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(2);
  });

  it('a different VARIANT stays a separate line (Medium ≠ Large)', () => {
    const medium = line({ key: 'm', productVariantId: 'var-medium', variantName: 'Medium' });
    const large = line({ key: 'l', productVariantId: 'var-large', variantName: 'Large' });
    expect(addDraftLine([medium], large)).toHaveLength(2);
    // Positive control on the same axis: the SAME variant does merge.
    expect(addDraftLine([medium], line({ key: 'm2', productVariantId: 'var-medium', variantName: 'Medium' }))).toHaveLength(1);
  });

  it('a different MODIFIER SET stays a separate line (extra cheese ≠ plain)', () => {
    expect(addDraftLine([line()], line({ key: 'b', modifiers: [CHEESE] }))).toHaveLength(2);
    expect(
      addDraftLine([line({ modifiers: [CHEESE] })], line({ key: 'b', modifiers: [CHEESE, BACON] })),
    ).toHaveLength(2);
  });

  it('different SPECIAL INSTRUCTIONS stay separate ("no onions" ≠ plain)', () => {
    expect(
      addDraftLine([line()], line({ key: 'b', specialInstructions: 'no onions' })),
    ).toHaveLength(2);
    // Whitespace is not a difference: "no onions " merges with "no onions".
    expect(
      addDraftLine(
        [line({ specialInstructions: 'no onions' })],
        line({ key: 'b', specialInstructions: ' no onions ' }),
      ),
    ).toHaveLength(1);
  });

  it('a line DISCOUNT blocks merging on either side — merging would change money', () => {
    const discounted = line({ key: 'd', discount: { type: 'PERCENTAGE', value: 10 } });
    // Discounted incoming never merges into a plain line…
    expect(addDraftLine([line()], discounted)).toHaveLength(2);
    // …and a plain incoming never merges into a discounted line.
    expect(addDraftLine([discounted], line({ key: 'p' }))).toHaveLength(2);
    // Even two lines with the SAME discount stay separate: each row owns its
    // own approval snapshot.
    expect(
      addDraftLine([discounted], line({ key: 'd2', discount: { type: 'PERCENTAGE', value: 10 } })),
    ).toHaveLength(2);
  });

  it('a different price SNAPSHOT stays separate — merging would misprice one tap', () => {
    expect(addDraftLine([line()], line({ key: 'b', unitPrice: '3500.00' }))).toHaveLength(2);
    expect(
      addDraftLine(
        [line({ modifiers: [CHEESE] })],
        line({ key: 'b', modifiers: [{ ...CHEESE, priceDelta: '175.00' }] }),
      ),
    ).toHaveLength(2);
  });

  it('MENU_ITEM and PRODUCT sources never merge, even with a colliding id', () => {
    const legacy = line({ key: 'l', sourceKind: 'MENU_ITEM', productId: undefined });
    const product = line({ key: 'p' });
    expect(addDraftLine([legacy], product)).toHaveLength(2);
    // An omitted sourceKind means MENU_ITEM (the legacy default) and merges
    // with an explicit one.
    expect(
      addDraftLine([legacy], line({ key: 'l2', sourceKind: undefined, productId: undefined })),
    ).toHaveLength(1);
  });

  it('reduce over a customise-dialog batch merges within the batch too', () => {
    const rows = [line({ key: 'x' }), line({ key: 'y' })].reduce(addDraftLine, [] as DraftLine[]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(2);
  });
});

describe('draftLineMergeKey', () => {
  it('is null exactly when a discount is present', () => {
    expect(draftLineMergeKey(line())).not.toBeNull();
    expect(draftLineMergeKey(line({ discount: { type: 'FIXED', value: 100 } }))).toBeNull();
  });
});
