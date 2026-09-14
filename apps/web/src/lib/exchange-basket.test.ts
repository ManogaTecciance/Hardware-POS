/**
 * D173 — the exchange basket's rules.
 *
 * ## What makes these non-vacuous (D30)
 *
 * The multi-line cases are asserted as exact SETS in the right ORDER, because
 * the two legs are positional in meaning: `returnItems[1]` and
 * `replacementItems[1]` are the same swap. A test that only counted entries
 * would pass for a basket that refunded the shirt and sold a replacement for
 * the trousers.
 *
 * Every "answered" rule is asserted from both sides. The empty basket is the
 * one that matters: without it, a screen with nothing ticked satisfies "every
 * line has an answer" vacuously and offers a Complete button that submits an
 * exchange of nothing.
 *
 * Quantities are asserted against a line bought more than once, because that is
 * the case the single-line screen could not express at all — it always returned
 * `availableReturnQuantity` and had no way to say "two of the three".
 */
import { describe, expect, it } from 'vitest';

import {
  clampQuantity,
  everyLineAnswered,
  replacementFor,
  replacementTotal,
  selectedLines,
  selectionKey,
  toReplacementItems,
  toReturnItems,
  type ExchangeLine,
  type LineChoice,
  type ReplacementVariant,
} from './exchange-basket';

const SUIT: ExchangeLine = {
  saleItemId: 'si_suit',
  productId: 'p_suit',
  productName: 'Black Suit',
  availableReturnQuantity: 1,
};
const JEANS: ExchangeLine = {
  saleItemId: 'si_jeans',
  productId: 'p_jeans',
  productName: 'Denim Jeans',
  availableReturnQuantity: 3,
};
const TEE: ExchangeLine = {
  saleItemId: 'si_tee',
  productId: 'p_tee',
  productName: 'Cotton T-Shirt',
  availableReturnQuantity: 1,
};

const LINES = [SUIT, JEANS, TEE];

const VARIANTS: Record<string, ReplacementVariant[]> = {
  p_suit: [
    { id: 'v_suit_l', unitPrice: 4000 },
    { id: 'v_suit_xl', unitPrice: 4500 },
  ],
  p_jeans: [
    { id: 'v_jeans_32', unitPrice: 4400 },
    { id: 'v_jeans_34', unitPrice: 4400 },
  ],
  p_tee: [{ id: 'v_tee_m', unitPrice: 1850 }],
};

function choose(entries: Record<string, Partial<LineChoice>>): Record<string, LineChoice> {
  const out: Record<string, LineChoice> = {};
  for (const [id, patch] of Object.entries(entries)) {
    out[id] = { quantity: 0, replacementVariantId: '', ...patch };
  }
  return out;
}

describe('selectedLines', () => {
  it('takes several lines at once — the thing the old screen could not do', () => {
    const selected = selectedLines(
      LINES,
      choose({ si_suit: { quantity: 1 }, si_jeans: { quantity: 2 } }),
    );

    // EXACT set and order: the two legs are positional in meaning.
    expect(selected.map((s) => s.line.saleItemId)).toEqual(['si_suit', 'si_jeans']);
    expect(selected.map((s) => s.quantity)).toEqual([1, 2]);
  });

  it('treats quantity 0 as deselected but keeps the replacement remembered', () => {
    const choices = choose({ si_jeans: { quantity: 0, replacementVariantId: 'v_jeans_34' } });

    expect(selectedLines(LINES, choices)).toEqual([]);
    // Ticking the line back on must not make the operator choose the size again.
    expect(choices.si_jeans?.replacementVariantId).toBe('v_jeans_34');
  });

  it('ignores a choice for a line the sale no longer offers', () => {
    // A sale refetched after the line was returned in another tab. The screen
    // must show what the SALE says, not what a stale choice remembers.
    const selected = selectedLines([SUIT], choose({ si_jeans: { quantity: 2 } }));
    expect(selected).toEqual([]);
  });

  it('clamps a stale quantity to what the line can still give back', () => {
    const shrunk: ExchangeLine = { ...JEANS, availableReturnQuantity: 1 };
    const selected = selectedLines([shrunk], choose({ si_jeans: { quantity: 3 } }));

    expect(selected[0]?.quantity).toBe(1);
  });

  it('keeps the order of the sale, not the order lines were ticked', () => {
    const selected = selectedLines(
      LINES,
      choose({ si_tee: { quantity: 1 }, si_suit: { quantity: 1 } }),
    );
    expect(selected.map((s) => s.line.saleItemId)).toEqual(['si_suit', 'si_tee']);
  });
});

describe('everyLineAnswered', () => {
  it('is false for an empty basket', () => {
    // The vacuous case. `[].every(...)` is true, so without this rule a screen
    // with nothing ticked would offer to complete an exchange of nothing.
    expect(everyLineAnswered([], VARIANTS)).toBe(false);
  });

  it('is false while one line of several is unanswered', () => {
    const selected = selectedLines(
      LINES,
      choose({
        si_suit: { quantity: 1, replacementVariantId: 'v_suit_l' },
        si_jeans: { quantity: 2 },
      }),
    );
    expect(everyLineAnswered(selected, VARIANTS)).toBe(false);
  });

  it('is true only when every selected line has a replacement', () => {
    const selected = selectedLines(
      LINES,
      choose({
        si_suit: { quantity: 1, replacementVariantId: 'v_suit_l' },
        si_jeans: { quantity: 2, replacementVariantId: 'v_jeans_34' },
      }),
    );
    expect(everyLineAnswered(selected, VARIANTS)).toBe(true);
  });

  it('is false when the chosen variant is not in the catalogue', () => {
    // A variant deactivated between load and submit. Matching the id against
    // the list rather than trusting the string is what catches it.
    const selected = selectedLines(
      LINES,
      choose({ si_suit: { quantity: 1, replacementVariantId: 'v_deleted' } }),
    );
    expect(replacementFor(selected[0]!, VARIANTS)).toBeNull();
    expect(everyLineAnswered(selected, VARIANTS)).toBe(false);
  });
});

describe('replacementTotal', () => {
  it('multiplies the replacement price by the quantity of the line it replaces', () => {
    const selected = selectedLines(
      LINES,
      choose({ si_jeans: { quantity: 2, replacementVariantId: 'v_jeans_34' } }),
    );
    // Two Mediums back is two Larges out: 2 x 4400.
    expect(replacementTotal(selected, VARIANTS)).toBe(8800);
  });

  it('sums across lines', () => {
    const selected = selectedLines(
      LINES,
      choose({
        si_suit: { quantity: 1, replacementVariantId: 'v_suit_xl' },
        si_jeans: { quantity: 2, replacementVariantId: 'v_jeans_34' },
      }),
    );
    expect(replacementTotal(selected, VARIANTS)).toBe(4500 + 8800);
  });

  it('counts an unanswered line as nothing, never as the returned price', () => {
    const selected = selectedLines(
      LINES,
      choose({
        si_suit: { quantity: 1, replacementVariantId: 'v_suit_l' },
        si_jeans: { quantity: 2 },
      }),
    );
    // 4000 for the suit and nothing for the jeans. A half-filled basket showing
    // a plausible total is how an operator takes the wrong money.
    expect(replacementTotal(selected, VARIANTS)).toBe(4000);
  });
});

describe('the request payload', () => {
  const selected = selectedLines(
    LINES,
    choose({
      si_suit: { quantity: 1, replacementVariantId: 'v_suit_xl' },
      si_jeans: { quantity: 2, replacementVariantId: 'v_jeans_34' },
    }),
  );

  it('sends one returning entry per line, with its own quantity', () => {
    expect(toReturnItems(selected)).toEqual([
      {
        saleItemId: 'si_suit',
        returnQuantity: 1,
        returnReason: 'NOT_SUITABLE',
        itemCondition: 'GOOD',
        stockDisposition: 'RETURN_TO_STOCK',
      },
      {
        saleItemId: 'si_jeans',
        returnQuantity: 2,
        returnReason: 'NOT_SUITABLE',
        itemCondition: 'GOOD',
        stockDisposition: 'RETURN_TO_STOCK',
      },
    ]);
  });

  it('sends the replacement leg in the same order, matched line for line', () => {
    expect(toReplacementItems(selected, VARIANTS)).toEqual([
      { productId: 'p_suit', productVariantId: 'v_suit_xl', quantity: 1 },
      { productId: 'p_jeans', productVariantId: 'v_jeans_34', quantity: 2 },
    ]);
  });

  it('the two legs line up entry for entry', () => {
    // The property that makes an exchange an exchange. Asserted rather than
    // assumed, because both legs are built by separate functions.
    const back = toReturnItems(selected);
    const out = toReplacementItems(selected, VARIANTS);
    expect(out).toHaveLength(back.length);
    for (let i = 0; i < back.length; i += 1) {
      expect(out[i]!.quantity).toBe(back[i]!.returnQuantity);
    }
  });

  it('refuses to build a leg that would silently drop a line', () => {
    // Dropping it would send a basket that refunds three things and sells two:
    // balanced on the screen, short at the till.
    const partial = selectedLines(LINES, choose({ si_jeans: { quantity: 1 } }));
    expect(() => toReplacementItems(partial, VARIANTS)).toThrow(/Denim Jeans/);
  });
});

describe('selectionKey', () => {
  it('changes when a quantity changes, so the preview is re-requested', () => {
    const one = selectedLines(LINES, choose({ si_jeans: { quantity: 1 } }));
    const two = selectedLines(LINES, choose({ si_jeans: { quantity: 2 } }));
    expect(selectionKey(one)).not.toBe(selectionKey(two));
  });

  it('does NOT change when only the replacement changes', () => {
    // The preview prices the RETURNING leg. Re-requesting it because the
    // operator picked a different size would be a round trip per keystroke for
    // an answer that cannot have moved.
    const a = selectedLines(LINES, choose({ si_suit: { quantity: 1, replacementVariantId: 'v_suit_l' } }));
    const b = selectedLines(LINES, choose({ si_suit: { quantity: 1, replacementVariantId: 'v_suit_xl' } }));
    expect(selectionKey(a)).toBe(selectionKey(b));
  });
});

describe('clampQuantity', () => {
  it.each([
    [5, 3, 3],
    [-1, 3, 0],
    [2.7, 3, 2],
    [Number.NaN, 3, 0],
    [3, 3, 3],
  ])('clamps %p against %p available to %p', (typed, available, expected) => {
    expect(clampQuantity(typed, available)).toBe(expected);
  });
});
