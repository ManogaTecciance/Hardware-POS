/**
 * D170 — the SKU you can generate, and the opening stock that actually lands.
 *
 * ## What was reported
 *
 * "sku not generating, sku genarate button now missing, and stock not apply
 * properly". Three symptoms, three different causes, and only the third was
 * what it sounded like.
 *
 * ## Why this file exists at all
 *
 * The opening-stock defect is the same shape as the one D134's spec was written
 * for, and it is worth naming because it survived a full test suite: the wizard
 * collected a number, VALIDATED it, and printed it back on the Review step as
 * "Opening stock" — and then `buildCreateInput` never sent it. Every layer that
 * had the value did the right thing with it. No layer ever handed it on, and
 * `ProductCreatePayload` had no field to hand it to.
 *
 * A test over `buildCreateInput`'s output would have caught it. There was none,
 * because the tests asserted the fields it DOES send.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * `buildOpeningReceiptInput` is asserted with `toEqual` on the whole payload —
 * an exact object. A wrong quantity, a wrong branch, a dropped line or an extra
 * field all fail; a truthiness check would catch none of them.
 *
 * Every "returns null" case is paired with the positive that differs from it in
 * exactly one field, so a builder that had simply stopped working fails the
 * positive rather than passing all four negatives.
 *
 * And the SKU rules are driven through the RENDERED button as well as the pure
 * function — the gap D134's spec names, and the one that let a placeholder
 * promise generation for as long as this wizard has existed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { StepPricingInventory } from './step-pricing-inventory';
import {
  MAX_SKU_LENGTH,
  buildOpeningReceiptInput,
  initialState,
  randomSkuSuffix,
  suggestSku,
  validateStep,
  type WizardState,
} from './wizard-state';

afterEach(cleanup);

const branches = [
  { id: 'br_main', name: 'Main', code: 'MAIN', address: null, phone: null, registers: [] },
  { id: 'br_two', name: 'Second', code: 'TWO', address: null, phone: null, registers: [] },
];

function Harness({ initial }: { initial?: WizardState }) {
  const [state, setState] = React.useState<WizardState>(initial ?? initialState());
  const patch = React.useCallback(
    (p: Partial<WizardState>) => setState((prev) => ({ ...prev, ...p })),
    [],
  );
  return (
    <StepPricingInventory
      positionLabel="Step 4 of 5"
      state={state}
      errors={validateStep('pricing', state, { inventoryMode: 'LOCAL' })}
      branches={branches}
      showOpeningStock
      onChange={patch}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('D170 — suggestSku', () => {
  it('turns a product name into a SKU', () => {
    // An exact map, not a spot check. Each input exercises a different thing:
    // spaces, digits glued to letters, punctuation, and an already-clean name.
    expect(
      [
        'Cement 50kg Bag',
        'Tile Adhesive (20kg)',
        'PVC-Pipe 2"',
        'Nails',
      ].map((n) => suggestSku(n, 'A7F')),
    ).toEqual([
      'CEMENT-50KG-BAG-A7F',
      'TILE-ADHESIVE-20KG-A7F',
      'PVC-PIPE-2-A7F',
      'NAILS-A7F',
    ]);
  });

  it('still produces something usable when the name has no letters or digits', () => {
    // A name in a script this strips entirely, or punctuation only. Returning
    // `-A7F` — a SKU starting with the separator — would look like a bug to
    // the operator reading it back.
    expect(suggestSku('???', 'A7F')).toBe('SKU-A7F');
    expect(suggestSku('   ', 'A7F')).toBe('SKU-A7F');
  });

  it('fits the DTO length, and trims the NAME rather than the suffix', () => {
    const long = 'X'.repeat(200);
    const result = suggestSku(long, 'A7F');

    expect(result.length).toBeLessThanOrEqual(MAX_SKU_LENGTH);
    // The suffix is the half carrying uniqueness, so it is the half that must
    // survive. A truncation that cut it would hand every long-named product
    // the same SKU — the exact collision the suffix exists to avoid.
    expect(result.endsWith('-A7F')).toBe(true);
  });

  it('never leaves a trailing separator after trimming', () => {
    // 'AB CD…' truncated mid-name can land on a '-'. `AB--A7F` is not a SKU
    // anybody would type, and it is what a naive slice produces.
    const name = `${'A'.repeat(MAX_SKU_LENGTH - 5)} TAIL`;
    expect(suggestSku(name, 'A7F')).not.toMatch(/--/);
    expect(suggestSku(name, 'A7F')).toMatch(/[A-Z0-9]-A7F$/);
  });
});

describe('D170 — randomSkuSuffix', () => {
  it('is three uppercase alphanumerics, and it varies', () => {
    const draws = Array.from({ length: 50 }, () => randomSkuSuffix());

    for (const d of draws) expect(d).toMatch(/^[0-9A-Z]{3}$/);
    // A constant suffix would satisfy the charset check above and defeat the
    // entire purpose. 50 identical draws from 36^3 is not a thing that happens.
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});

describe('D170 — the SKU field', () => {
  it('fills the SKU from the product name when Generate is pressed', () => {
    render(<Harness initial={{ ...initialState(), name: 'Cement 50kg Bag' }} />);

    const input = screen.getByLabelText(/^SKU/i) as HTMLInputElement;
    // Nothing before the press — otherwise the assertion below could pass on a
    // field that was pre-filled by something else entirely.
    expect(input.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(input.value).toMatch(/^CEMENT-50KG-BAG-[0-9A-Z]{3}$/);
  });

  it('is not marked required, and a blank SKU is accepted', () => {
    render(<Harness initial={{ ...initialState(), name: 'Cement' }} />);

    // The contradiction this decision removed: the field carried a red asterisk
    // AND a placeholder offering to generate one if you left it blank.
    const label = screen.getByText('SKU').closest('label');
    expect(label?.textContent).not.toContain('*');

    const priced = { ...initialState(), name: 'Cement' };
    priced.simple = { ...priced.simple, sku: '', unitPrice: '10' };
    expect(validateStep('pricing', priced, { inventoryMode: 'LOCAL' })['simple-sku'])
      .toBeUndefined();
  });

  it('still refuses a SKU longer than the DTO allows', () => {
    // Dropping "required" must not have dropped the length rule with it — the
    // server would 400 on it, and the operator would see a raw API error.
    const over = { ...initialState(), name: 'Cement' };
    over.simple = { ...over.simple, sku: 'S'.repeat(MAX_SKU_LENGTH + 1), unitPrice: '10' };
    expect(validateStep('pricing', over, { inventoryMode: 'LOCAL' })['simple-sku'])
      .toMatch(/80 characters/);
  });
});

describe('D170 — the opening-stock branch, for a single product', () => {
  const withOpening = (openingQuantity: string): WizardState => {
    const s = initialState();
    s.name = 'Cement';
    s.simple = { ...s.simple, unitPrice: '10', openingQuantity };
    return s;
  };

  it('asks where the stock lands once a quantity is entered', () => {
    render(<Harness initial={withOpening('12')} />);

    // The control a single product never had. Its absence is why the quantity
    // had nowhere to go even after the payload was fixed.
    expect(screen.getByLabelText(/opening stock branch/i)).toBeDefined();
  });

  it('does not ask when there is no opening stock', () => {
    // The paired half: a branch selector on every product would be a control
    // asking a question most saves never raise.
    render(<Harness initial={withOpening('')} />);

    expect(screen.queryByLabelText(/opening stock branch/i)).toBeNull();
  });

  it('refuses to continue with stock but no branch', () => {
    const errs = validateStep('pricing', withOpening('12'), { inventoryMode: 'LOCAL' });
    expect(errs['openingBranchId']).toMatch(/where the opening stock lands/i);

    // …and accepts it once answered, so the rule is not simply always on.
    const answered = { ...withOpening('12'), openingBranchId: 'br_main' };
    expect(validateStep('pricing', answered, { inventoryMode: 'LOCAL' })['openingBranchId'])
      .toBeUndefined();
  });
});

describe('D170 — buildOpeningReceiptInput', () => {
  const simple = (over: Partial<WizardState['simple']> = {}, branch = 'br_main'): WizardState => {
    const s = initialState();
    s.simple = { ...s.simple, unitPrice: '10', openingQuantity: '12', costPrice: '4.5', ...over };
    s.openingBranchId = branch;
    return s;
  };

  it('builds the receipt the wizard posts after create', () => {
    // An exact payload. This is the assertion the whole defect turned on: the
    // number the operator typed has to leave the wizard, and nothing asserted
    // that it did.
    expect(buildOpeningReceiptInput(simple(), 'prod_1')).toEqual({
      branchId: 'br_main',
      lines: [{ productId: 'prod_1', quantityReceived: 12, unitCost: 4.5 }],
    });
  });

  it('costs an opening receipt at zero when no cost was given', () => {
    // Mirrors the variant path, which records `costPrice ?? 0` and says why:
    // a zero-cost opening receipt is a legitimate initial condition.
    expect(buildOpeningReceiptInput(simple({ costPrice: '' }), 'prod_1')).toEqual({
      branchId: 'br_main',
      lines: [{ productId: 'prod_1', quantityReceived: 12, unitCost: 0 }],
    });
  });

  it('posts nothing when there is nothing to post', () => {
    // Each of these differs from the passing case above in exactly one field,
    // so a builder that had stopped working would fail that case rather than
    // pass all of these.
    expect(buildOpeningReceiptInput(simple({ openingQuantity: '' }), 'prod_1')).toBeNull();
    expect(buildOpeningReceiptInput(simple({ openingQuantity: '0' }), 'prod_1')).toBeNull();
    expect(buildOpeningReceiptInput(simple({ openingQuantity: 'abc' }), 'prod_1')).toBeNull();
    expect(buildOpeningReceiptInput(simple({}, ''), 'prod_1')).toBeNull();
  });

  it('leaves a variant product alone — its batch endpoint owns opening stock', () => {
    /*
     * The isolation case. The variants batch creates its own opening receipt
     * per variant; a second receipt from here would receive the same stock
     * twice, which is a worse defect than the one being fixed.
     */
    const variant = { ...simple(), hasVariations: true };
    expect(buildOpeningReceiptInput(variant, 'prod_1')).toBeNull();
  });
});

describe('D170 — the precision the receipt endpoint will actually accept', () => {
  const withValues = (over: Partial<WizardState['simple']>): WizardState => {
    const s = initialState();
    s.name = 'Cement';
    s.simple = { ...s.simple, unitPrice: '10', ...over };
    s.openingBranchId = 'br_main';
    return s;
  };
  const errs = (s: WizardState) => validateStep('pricing', s, { inventoryMode: 'LOCAL' });

  /*
   * These two values now travel to `POST /inventory-receipts`, whose line DTO
   * is stricter than `CreateProductDto`: `unitCost` is `maxDecimalPlaces: 2`
   * and `quantityReceived` is `3`. Uncapped, the wizard would create the
   * product, then 400 on the receipt — leaving the operator with a product
   * that has no opening stock and an error naming a field they cannot see.
   *
   * The caps also match the columns (`Decimal(12,2)` / `Decimal(12,3)`), so the
   * extra digits were being rounded away in silence beforehand either way.
   */
  it('refuses a cost the receipt line would reject', () => {
    expect(errs(withValues({ costPrice: '4.567' }))['simple-cost'])
      .toMatch(/at most 2 decimal places/i);
    // …and accepts the precision that IS allowed, so the rule is not simply
    // rejecting every cost with a decimal point in it.
    expect(errs(withValues({ costPrice: '4.56' }))['simple-cost']).toBeUndefined();
  });

  it('refuses an opening quantity the receipt line would reject', () => {
    expect(errs(withValues({ openingQuantity: '12.3456' }))['simple-openq'])
      .toMatch(/at most 3 decimal places/i);
    expect(errs(withValues({ openingQuantity: '12.345' }))['simple-openq']).toBeUndefined();
  });

  it('matches the cap the variant rows have always had', () => {
    // The variant path capped opening stock at 3 from the start. The single
    // product taking a different number of decimals than the variant beside it
    // is the kind of divergence that makes one shape of the wizard trustworthy
    // and the other not.
    const variant = { ...withValues({ openingQuantity: '12.3456' }), hasVariations: true };
    variant.variations = [{ key: 'd1', name: 'Size', options: [{ key: 'o1', name: 'S' }] }];
    variant.variants = [
      {
        key: 'v1',
        optionKeys: ['o1'],
        enabled: true,
        sku: 'S-1',
        barcode: '',
        unitPrice: '10',
        costPrice: '',
        openingQuantity: '12.3456',
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
      },
    ];
    expect(errs(variant)['variant-openq-0']).toMatch(/at most 3 decimal places/i);
  });
});
