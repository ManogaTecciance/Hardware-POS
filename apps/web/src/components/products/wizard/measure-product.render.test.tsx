/**
 * D113 (`6.1`) — the product form can declare a product sold by weight.
 *
 * ## Why this file exists at all
 *
 * `6.1` shipped `quantityType` on the column, the DTO, the read model and the
 * till, and shipped **no way to set it**. A measured product could only be made
 * by writing to the database directly. Every test passed, because every test
 * exercised a layer that already had the value handed to it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The pure rules are asserted from BOTH sides — a measured product with no unit
 * is refused, and one WITH a unit is accepted. A test that only checked the
 * refusal would pass for a form that rejected every product ever, which is a
 * worse defect than the one it guards.
 *
 * They are also driven through the RENDERED control rather than only through
 * `validateStep` and `buildCreateInput`. That is the specific gap this file was
 * written for: pure-function tests over the wizard's helpers stay green when the
 * card is never rendered, which is exactly the state `6.1` shipped in.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveMeasuredGoods } from '@/lib/products/product-presentation';
import type { ManagedProduct } from '@/lib/products-api';

import { StepPricingInventory } from './step-pricing-inventory';
import {
  buildCreateInput,
  hydrateFromProduct,
  initialState,
  sellingPriceLabel,
  validateStep,
  type WizardState,
} from './wizard-state';

afterEach(cleanup);

const branches = [
  { id: 'br_main', name: 'Main', code: 'MAIN', address: null, phone: null, registers: [] },
];

function useHarness(initial: WizardState) {
  const [state, setState] = React.useState<WizardState>(initial);
  const patch = React.useCallback((p: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);
  return { state, patch };
}

function Harness({
  initial,
  showMeasuredGoods = true,
}: {
  initial?: WizardState;
  showMeasuredGoods?: boolean;
}) {
  const h = useHarness(initial ?? initialState());
  return (
    <StepPricingInventory
      state={h.state}
      errors={validateStep('pricing', h.state, { inventoryMode: 'LOCAL' })}
      branches={branches}
      showOpeningStock
      showMeasuredGoods={showMeasuredGoods}
      onChange={h.patch}
    />
  );
}

/** A measured product, as the operator would leave the form. */
function measured(unit = 'kg'): WizardState {
  return { ...initialState(), quantityType: 'DECIMAL', unitOfMeasure: unit };
}

describe('the control exists and writes', () => {
  it('offers the choice, and defaults to selling by the piece', () => {
    render(<Harness />);

    const select = screen.getByLabelText(/how is this sold/i) as HTMLSelectElement;
    // POSITIVE: the control is on the screen at all. This is the assertion the
    // whole file exists for -- `6.1` passed every other test without it.
    expect(select).toBeDefined();
    expect(select.value).toBe('WHOLE');
    // NEGATIVE: no unit field until it is asked for. A unit box on every
    // product is how a hardware shop ends up with "each" typed 400 times.
    expect(screen.queryByLabelText(/^unit/i)).toBeNull();
  });

  it('reveals the unit field once the product is sold by measure', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText(/how is this sold/i), {
      target: { value: 'DECIMAL' },
    });

    expect(screen.getByLabelText(/^unit/i)).toBeDefined();
  });

  it('names the price per unit once the unit is known', () => {
    render(<Harness />);

    // Before: the plain label, and NOT a per-unit one. `Field` appends an
    // sr-only "(required)" to the accessible name, so the assertion is on
    // the presence and absence of the per-unit clause rather than on an
    // exact string that also encodes how required fields are announced.
    expect(screen.getByLabelText(/^selling price/i)).toBeDefined();
    expect(screen.queryByLabelText(/per kg/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/how is this sold/i), {
      target: { value: 'DECIMAL' },
    });
    fireEvent.change(screen.getByLabelText(/^unit/i), { target: { value: 'kg' } });

    // After: "200" is meaningless until the field says what it is per.
    expect(screen.getByLabelText(/selling price \(per kg\)/i)).toBeDefined();
  });

  it('clears the unit when the product goes back to being sold by the piece', () => {
    render(<Harness initial={measured()} />);
    expect(screen.getByLabelText(/^unit/i)).toBeDefined();

    fireEvent.change(screen.getByLabelText(/how is this sold/i), {
      target: { value: 'WHOLE' },
    });

    // A counted product still carrying "kg" would print "3 kg" for three tins.
    expect(screen.queryByLabelText(/^unit/i)).toBeNull();
    // And the price label drops back with it -- otherwise the form would
    // still be asking for a price per kilo for something sold in tins.
    expect(screen.queryByLabelText(/per kg/i)).toBeNull();
    expect(screen.getByLabelText(/^selling price/i)).toBeDefined();
  });
});


/**
 * D113e — the control is RETAIL-only, and this is the regression guard.
 *
 * `6.1b` rendered it unconditionally, which put a weighed-goods control in front
 * of every restaurant and hardware workspace. `step-pricing-inventory` is the
 * SHARED Step 3 for every business type — it already takes `businessKind` and
 * already draws restaurant chrome from it — so an ungated card there reaches
 * templates that never asked for the feature.
 *
 * Asserted from both sides, and through the resolver as well as the component:
 * a test that only proved the card renders would pass for the ungated version
 * that caused this, and a test that only proved it hides would pass for a
 * component that had lost the feature entirely.
 */
describe('D113e — only a tenant that sells by measure is offered it', () => {
  it('offers nothing when the capability is off', () => {
    render(<Harness showMeasuredGoods={false} />);

    expect(screen.queryByLabelText(/how is this sold/i)).toBeNull();
    expect(screen.queryByLabelText(/^unit/i)).toBeNull();
    // And the price label stays plain — no trace of the feature leaks through.
    expect(screen.getByLabelText(/^selling price/i)).toBeDefined();
    expect(screen.queryByLabelText(/per /i)).toBeNull();
  });

  it('still draws the rest of the pricing step when the capability is off', () => {
    // The card is gated; the STEP is not. Without this, hiding the whole form
    // for hardware would pass the assertion above.
    render(<Harness showMeasuredGoods={false} />);

    expect(screen.getByLabelText(/^sku/i)).toBeDefined();
    expect(screen.getByLabelText(/^selling price/i)).toBeDefined();
  });

  it('defaults to OFF when the prop is absent', () => {
    // The safe direction: a caller that has not been updated offers nothing,
    // rather than leaking the control into a template that did not ask.
    render(
      <StepPricingInventory
        state={initialState()}
        errors={{}}
        branches={branches}
        showOpeningStock
        onChange={() => {}}
      />,
    );

    expect(screen.queryByLabelText(/how is this sold/i)).toBeNull();
  });

  it('RETAIL has the capability; hardware and food service do not', () => {
    // The resolver, from the registry rather than an if-chain — which is what
    // decides this for real. `RETAIL_CAPABILITIES` is shared by the HARDWARE and
    // RETAIL domains, so hardware reading false is the assertion that proves the
    // flag lives on the retail DESCRIPTOR and not in the shared constant.
    expect(resolveMeasuredGoods('RETAIL')).toBe(true);

    expect(resolveMeasuredGoods('HARDWARE')).toBe(false);
    expect(resolveMeasuredGoods('RESTAURANT')).toBe(false);
    expect(resolveMeasuredGoods('CAFE')).toBe(false);
    expect(resolveMeasuredGoods('BAKERY')).toBe(false);
    expect(resolveMeasuredGoods('HOTEL')).toBe(false);
    expect(resolveMeasuredGoods('GENERAL')).toBe(false);
  });

  it('offers nothing while the profile is unresolved', () => {
    // A control that appears a beat after the form loads is worse than one that
    // was never offered — the same default the restaurant chrome takes.
    expect(resolveMeasuredGoods(null)).toBe(false);
  });
});

describe('the unit is required only for a measured product (D113c)', () => {
  it('refuses a measured product with no unit', () => {
    const errors = validateStep('pricing', measured(''), { inventoryMode: 'LOCAL' });
    expect(errors['unitOfMeasure']).toBeDefined();
  });

  it('accepts a measured product that names its unit', () => {
    // The POSITIVE side. Without it the assertion above would pass for a form
    // that refused every product, measured or not.
    const errors = validateStep('pricing', measured('kg'), { inventoryMode: 'LOCAL' });
    expect(errors['unitOfMeasure']).toBeUndefined();
  });

  it('does not demand a unit from a product sold by the piece', () => {
    // The rule is CONDITIONAL. A shirt has no unit and must not be asked for one.
    const errors = validateStep('pricing', initialState(), { inventoryMode: 'LOCAL' });
    expect(errors['unitOfMeasure']).toBeUndefined();
  });

  it('treats whitespace as no unit at all', () => {
    const errors = validateStep('pricing', measured('   '), { inventoryMode: 'LOCAL' });
    expect(errors['unitOfMeasure']).toBeDefined();
  });
});

describe('the label has one authority', () => {
  it('reads plainly for a counted product', () => {
    expect(sellingPriceLabel(initialState())).toBe('Selling price');
  });

  it('names the unit for a measured one', () => {
    expect(sellingPriceLabel(measured('kg'))).toBe('Selling price (per kg)');
    expect(sellingPriceLabel(measured('L'))).toBe('Selling price (per L)');
  });

  it('does not invent a unit it has not been given', () => {
    // "Selling price (per )" is worse than the plain label, and "per undefined"
    // is worse than both. Mid-typing is a real state: the operator picks
    // DECIMAL and the unit box is empty for as long as it takes them to type.
    expect(sellingPriceLabel(measured(''))).toBe('Selling price');
  });
});

describe('what crosses the wire', () => {
  it('sends the measure and the unit', () => {
    const input = buildCreateInput(measured('kg'), null);
    expect(input.quantityType).toBe('DECIMAL');
    expect(input.unitOfMeasure).toBe('kg');
  });

  it('sends NULL, not an empty string, for a counted product', () => {
    // The column is nullable and NULL is the honest reading of "no unit". An
    // empty string is a unit whose name is blank, and `saleLineQuantity` would
    // print a trailing space on every receipt for the rest of time.
    const input = buildCreateInput(initialState(), null);
    expect(input.quantityType).toBe('WHOLE');
    expect(input.unitOfMeasure).toBeNull();
  });

  it('trims the unit before sending it', () => {
    expect(buildCreateInput(measured('  kg  '), null).unitOfMeasure).toBe('kg');
  });
});

describe('editing an existing product round-trips it', () => {
  function managed(overrides: Partial<ManagedProduct>): ManagedProduct {
    return {
      id: 'p1',
      name: 'Rice',
      type: 'Inventory',
      sku: 'RICE',
      description: null,
      categoryId: null,
      subcategoryId: null,
      unitPrice: 210,
      incomeAccount: null,
      purchaseDescription: null,
      costPrice: null,
      expenseAccount: null,
      quantityOnHand: 100,
      quantityAsOfDate: null,
      reorderLevel: null,
      inventoryAssetAccount: null,
      imageUrl: null,
      isActive: true,
      taxable: true,
      quantityType: 'WHOLE',
      unitOfMeasure: null,
      quickbooksItemId: null,
      syncStatus: 'NOT_SYNCED',
      lastSyncedAt: null,
      hasVariants: false,
      averageCost: null,
      ...overrides,
    } as ManagedProduct;
  }

  it('re-opens a measured product still measured', () => {
    // The failure this guards is silent and destructive: open rice to fix a
    // typo in its name, save, and it is counted stock priced per bag.
    const state = hydrateFromProduct(
      managed({ quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
      [],
      [],
    );
    expect(state.quantityType).toBe('DECIMAL');
    expect(state.unitOfMeasure).toBe('kg');

    // And survives the round trip back out.
    expect(buildCreateInput(state, null).unitOfMeasure).toBe('kg');
  });

  it('re-opens a counted product still counted', () => {
    const state = hydrateFromProduct(managed({}), [], []);
    expect(state.quantityType).toBe('WHOLE');
    expect(state.unitOfMeasure).toBe('');
  });
});
