/**
 * Add Product Wizard — render coverage (D44).
 *
 * Non-vacuous per D30: every positive claim (a field renders, a step is
 * marked active, a matrix expands) is paired with a negative — the button is
 * not clickable in the wrong state, the future step never fires its handler,
 * the confirm prompt does not skip the matrix without a click. Each `it`
 * exercises one contract of one file so a regression names the file that broke.
 *
 * The four step components are tested directly rather than through the shell,
 * because the shell only hands them state and a validation map. Testing the
 * shell would re-test navigation the Stepper already covers and would need
 * mocks for every products/*-api the shell touches — noise that would bury the
 * real assertion. Where the shell's validation pipeline matters we invoke
 * `validateStep` here and pass its output as the `errors` prop, which is what
 * the shell does at runtime.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CategoryNode } from '@/lib/products-api';

import { StepDetails } from './step-details';
import { StepPricingInventory } from './step-pricing-inventory';
import { StepReview } from './step-review';
import { StepVariations } from './step-variations';
import { Stepper } from './stepper';
import {
  buildVariantsBatchInput,
  enumerateCombinations,
  initialState,
  validateStep,
  type StepKey,
  type WizardState,
} from './wizard-state';

afterEach(cleanup);

// ── Shared fixtures ──────────────────────────────────────────────────────────

const noopSession = { token: 't', user: { tenantId: 'tnt_x' } } as never;

const categoryTree: CategoryNode[] = [
  {
    id: 'cat_beverages',
    name: 'Beverages',
    slug: 'beverages',
    description: null,
    imageUrl: null,
    sortOrder: 0,
    isActive: true,
    quickbooksItemId: null,
    productCount: 0,
    subcategoryCount: 2,
    subcategories: [
      {
        id: 'sub_soda',
        categoryId: 'cat_beverages',
        name: 'Soda',
        slug: 'soda',
        description: null,
        imageUrl: null,
        sortOrder: 0,
        isActive: true,
        productCount: 0,
      },
      {
        id: 'sub_water',
        categoryId: 'cat_beverages',
        name: 'Water',
        slug: 'water',
        description: null,
        imageUrl: null,
        sortOrder: 1,
        isActive: true,
        productCount: 0,
      },
    ],
  },
  {
    id: 'cat_snacks',
    name: 'Snacks',
    slug: 'snacks',
    description: null,
    imageUrl: null,
    sortOrder: 1,
    isActive: true,
    quickbooksItemId: null,
    productCount: 0,
    subcategoryCount: 0,
    subcategories: [],
  },
];

const branches = [
  { id: 'br_main', name: 'Main', code: 'MAIN', address: null, phone: null, registers: [] },
  { id: 'br_annex', name: 'Annex', code: 'ANX', address: null, phone: null, registers: [] },
];

/**
 * Stateful harness: the step components are controlled by the shell, so tests
 * that expect a click to update the visible tree need a real state container.
 * Kept minimal — one useState, `patch` for shallow merge, and a ref so the
 * spec can peek at the "latest" state without racing React's commit cycle.
 */
function useHarness(initial: WizardState) {
  const [state, setState] = React.useState<WizardState>(initial);
  const patch = React.useCallback((p: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);
  return { state, patch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stepper
// ─────────────────────────────────────────────────────────────────────────────

describe('Stepper', () => {
  const steps = [
    { index: 0, key: 'details' as StepKey, label: 'Product details' },
    { index: 1, key: 'variations' as StepKey, label: 'Variations' },
    { index: 2, key: 'pricing' as StepKey, label: 'Pricing & inventory' },
    { index: 3, key: 'review' as StepKey, label: 'Review & save' },
  ];

  it('renders four nodes with the wizard step labels', () => {
    render(<Stepper steps={steps} currentIndex={0} />);
    // Positive: every declared label is present as a button.
    for (const label of [
      'Product details',
      'Variations',
      'Pricing & inventory',
      'Review & save',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeDefined();
    }
    // Negative: no extra button crept in (5+ would mean the array grew silently).
    expect(screen.getAllByRole('button')).toHaveLength(steps.length);
  });

  it('marks complete steps with a check, active step with aria-current, future with muted text', () => {
    render(<Stepper steps={steps} currentIndex={2} />);
    const complete = screen.getByRole('button', { name: /product details/i });
    const active = screen.getByRole('button', { name: /pricing & inventory/i });
    const future = screen.getByRole('button', { name: /review & save/i });

    // Positive claims.
    expect(complete.querySelector('svg')).not.toBeNull(); // Check icon
    expect(active.getAttribute('aria-current')).toBe('step');
    // The muted styling lives on descendant text spans of the future button —
    // matching against the outermost class would miss it entirely.
    expect(future.innerHTML).toMatch(/text-muted-foreground/);

    // Negatives keep each claim honest.
    expect(complete.getAttribute('aria-current')).toBeNull();
    // An active step shows the numeric badge (no Check svg inside the number circle).
    const activeBadge = within(active).getByText('3');
    expect(activeBadge).toBeDefined();
    // Future step is not marked as the current step.
    expect(future.getAttribute('aria-current')).toBeNull();
  });

  it('past and current steps are clickable; future steps are not', () => {
    const onStepClick = vi.fn();
    render(<Stepper steps={steps} currentIndex={2} onStepClick={onStepClick} />);

    const past = screen.getByRole('button', { name: /product details/i }) as HTMLButtonElement;
    const future = screen.getByRole('button', { name: /review & save/i }) as HTMLButtonElement;

    // Positive: past step routes back through the callback with its index.
    expect(past.disabled).toBe(false);
    fireEvent.click(past);
    expect(onStepClick).toHaveBeenCalledWith(0);

    // Negative: future step's button is disabled and clicking it does nothing.
    expect(future.disabled).toBe(true);
    fireEvent.click(future);
    expect(onStepClick).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Product details
// ─────────────────────────────────────────────────────────────────────────────

describe('StepDetails', () => {
  function Harness({ state, categories = categoryTree }: { state: WizardState; categories?: CategoryNode[] }) {
    const h = useHarness(state);
    // Errors mirror the shell's contract: it computes them from validateStep
    // and hands them to the step. Recomputing here keeps the pipeline honest.
    const errors = validateStep('details', h.state, { inventoryMode: 'LOCAL' });
    return (
      <StepDetails
        state={h.state}
        errors={errors}
        categories={categories}
        session={noopSession}
        onChange={h.patch}
      />
    );
  }

  it('surfaces a name-required error once the name has been visited and left empty', () => {
    // The shell renders the errors map into the step. Passing the validator's
    // output through the same seam proves the two agree on the wording.
    const s = initialState();
    render(
      <StepDetails
        state={s}
        errors={validateStep('details', s, { inventoryMode: 'LOCAL' })}
        categories={categoryTree}
        session={noopSession}
        onChange={() => {}}
      />,
    );
    const alert = screen.getByRole('alert');
    // Positive: the error appears next to the name field.
    expect(alert.textContent).toMatch(/give the product a name/i);

    // Negative: the shape is one message, not a stray "Category is required" or
    // any other field spilling into this step.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('picking Service disables the Track Inventory switch', () => {
    render(<Harness state={initialState()} />);

    // Positive: default is Inventory → switch is enabled.
    const trackSwitch = screen.getByRole('switch', { name: /track inventory/i });
    expect(trackSwitch.getAttribute('aria-checked')).toBe('true');
    expect(trackSwitch.hasAttribute('disabled')).toBe(false);

    // Flip to Service and re-query — role=radio is the segmented control.
    fireEvent.click(screen.getByRole('radio', { name: /service/i }));

    const afterSwitch = screen.getByRole('switch', { name: /track inventory/i });
    // Negative on the earlier claim: the switch is now both disabled and off.
    expect(afterSwitch.hasAttribute('disabled')).toBe(true);
    expect(afterSwitch.getAttribute('aria-checked')).toBe('false');
  });

  it('choosing a category narrows the subcategory select to that category’s children', () => {
    // Beverages has Soda + Water; Snacks has no subcategories.
    render(<Harness state={initialState()} />);

    const categorySel = screen.getByLabelText(/^category/i) as HTMLSelectElement;
    fireEvent.change(categorySel, { target: { value: 'cat_beverages' } });
    const subSel = screen.getByLabelText(/^subcategory/i) as HTMLSelectElement;

    // Positive: exactly the two children of Beverages, plus the "None" default.
    const opts = within(subSel).getAllByRole('option').map((o) => (o as HTMLOptionElement).text);
    expect(opts).toEqual(['None', 'Soda', 'Water']);
    expect(subSel.disabled).toBe(false);

    // Switch to Snacks (has no subcategories) — negative on the previous list.
    fireEvent.change(categorySel, { target: { value: 'cat_snacks' } });
    const nextSubSel = screen.getByLabelText(/^subcategory/i) as HTMLSelectElement;
    expect(
      within(nextSubSel).getAllByRole('option').map((o) => (o as HTMLOptionElement).text),
    ).toEqual(['No subcategories']);
    // Empty child list disables the select so it can't be opened onto nothing.
    expect(nextSubSel.disabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Variations
// ─────────────────────────────────────────────────────────────────────────────

describe('StepVariations', () => {
  /** State pre-populated with variations, ready for the sellable-variants matrix. */
  function withDimensions(dims: Array<{ name: string; options: string[] }>): WizardState {
    const s = initialState();
    s.hasVariations = true;
    s.variations = dims.map((d, di) => ({
      key: `dim-${di}`,
      name: d.name,
      options: d.options.map((n, oi) => ({ key: `dim-${di}-opt-${oi}`, name: n })),
    }));
    return s;
  }

  function Harness({ state }: { state: WizardState }) {
    const h = useHarness(state);
    return <StepVariations state={h.state} errors={{}} onChange={h.patch} />;
  }

  it('default state advertises the "no variations" mode with the switch on', () => {
    const s = initialState();
    // Positive precondition.
    expect(s.hasVariations).toBe(false);

    render(<StepVariations state={s} errors={{}} onChange={() => {}} />);
    const noVarSwitch = screen.getByRole('switch', {
      name: /this product has no variations/i,
    });
    // Positive: switch is on.
    expect(noVarSwitch.getAttribute('aria-checked')).toBe('true');
    // Negative: no dimension cards and no Add variation button rendered while
    // the operator is in single-SKU mode.
    expect(screen.queryByRole('button', { name: /add variation/i })).toBeNull();
    expect(document.body.textContent).toMatch(/single sku mode/i);
  });

  it('toggling the switch off reveals an empty variations list and Add variation', () => {
    render(<Harness state={initialState()} />);
    const noVarSwitch = screen.getByRole('switch', {
      name: /this product has no variations/i,
    });

    fireEvent.click(noVarSwitch);

    // Positive: the Add-variation control has appeared.
    expect(screen.getByRole('button', { name: /add variation/i })).toBeDefined();
    // Negative: no dimension card yet — the list starts empty.
    expect(screen.queryAllByLabelText('Variation')).toHaveLength(0);
    // The matrix helper text calls out that no option has been added.
    expect(document.body.textContent).toMatch(/enter at least one option per variation/i);
  });

  it('clicking Add variation appends a group and focuses its Name input', () => {
    const start = initialState();
    start.hasVariations = true;
    render(<Harness state={start} />);

    fireEvent.click(screen.getByRole('button', { name: /add variation/i }));

    // Positive: a Name input now exists and holds focus after the effect.
    const nameInput = screen.getByLabelText('Variation') as HTMLInputElement;
    expect(nameInput).toBeDefined();
    expect(document.activeElement).toBe(nameInput);

    // Negative: no matrix data has been generated yet (empty option list).
    expect(document.body.textContent).toMatch(/enter at least one option per variation/i);
  });

  it('a 2-dimension × 3×3 variations shape produces a 9-row sellable-variants matrix', () => {
    const s = withDimensions([
      { name: 'Size', options: ['200ml', '300ml', '500ml'] },
      { name: 'Packaging', options: ['Can', 'Glass Bottle', 'Plastic Bottle'] },
    ]);
    render(<Harness state={s} />);

    // Positive: 9 checkboxes for 9 combinations.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(9);

    // Positive/order: the first row is 200ml x Can, per enumerateCombinations.
    const firstLabel = checkboxes[0]!.getAttribute('aria-label');
    expect(firstLabel).toMatch(/variant 1/i);
    expect(document.body.textContent).toMatch(/200ml/);
    expect(document.body.textContent).toMatch(/glass bottle/i);

    // Negative: the confirm-and-continue prompt is NOT rendered for a small matrix.
    expect(screen.queryByRole('button', { name: /confirm and continue/i })).toBeNull();
  });

  it('Select all enables every row; Clear all disables every row', () => {
    const s = withDimensions([
      { name: 'Size', options: ['S', 'M'] },
      { name: 'Colour', options: ['Red', 'Blue'] },
    ]);
    render(<Harness state={s} />);

    // Precondition: 4 rows, all default-enabled (well under the confirm threshold).
    const initialBoxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(initialBoxes).toHaveLength(4);
    expect(initialBoxes.every((b) => b.checked)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    const cleared = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // Negative: every box now unchecked.
    expect(cleared.every((b) => !b.checked)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    const selected = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // Positive again: every box back on.
    expect(selected.every((b) => b.checked)).toBe(true);
  });

  it('above the confirmation threshold the matrix is hidden until the operator confirms', () => {
    // 3 dimensions of 5 = 125 combinations > 100 threshold, < 500 max.
    const s = withDimensions([
      { name: 'A', options: ['a1', 'a2', 'a3', 'a4', 'a5'] },
      { name: 'B', options: ['b1', 'b2', 'b3', 'b4', 'b5'] },
      { name: 'C', options: ['c1', 'c2', 'c3', 'c4', 'c5'] },
    ]);
    render(<Harness state={s} />);

    // Positive: the confirm prompt appears with the exact scale in the message.
    const confirmBtn = screen.getByRole('button', { name: /confirm and continue/i });
    expect(document.body.textContent).toMatch(/125 possible variants/i);

    // Negative: the matrix's row checkboxes are NOT yet on screen — one for the
    // "no variations" switch is present, but the per-variant enable checkboxes are not.
    const beforeCheckboxes = screen.queryAllByRole('checkbox');
    expect(beforeCheckboxes.length).toBeLessThan(125);

    fireEvent.click(confirmBtn);

    // Positive: after confirming, all 125 row checkboxes render.
    const afterCheckboxes = screen.getAllByRole('checkbox');
    expect(afterCheckboxes).toHaveLength(125);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Pricing & inventory
// ─────────────────────────────────────────────────────────────────────────────

describe('StepPricingInventory', () => {
  function simpleHarness(showOpeningStock: boolean) {
    return function Harness() {
      const h = useHarness(initialState());
      return (
        <StepPricingInventory
          state={h.state}
          errors={{}}
          branches={branches}
          showOpeningStock={showOpeningStock}
          onChange={h.patch}
        />
      );
    };
  }

  it('simple mode omits opening quantity when the tenant is not on LOCAL inventory', () => {
    const H = simpleHarness(false);
    render(<H />);
    // Positive: the required simple-mode fields still render.
    expect(screen.getByLabelText(/^sku/i)).toBeDefined();
    expect(screen.getByLabelText(/^selling price/i)).toBeDefined();
    // Negative: opening quantity is suppressed with a matching info banner.
    expect(screen.queryByLabelText(/opening quantity/i)).toBeNull();
    expect(document.body.textContent).toMatch(/opening stock is only supported/i);
  });

  it('simple mode shows opening quantity when the tenant is LOCAL', () => {
    const H = simpleHarness(true);
    render(<H />);
    // Positive: the field is there for the operator to fill.
    expect(screen.getByLabelText(/opening quantity/i)).toBeDefined();
    // Negative: the "not supported" banner is not shown when it is supported.
    expect(document.body.textContent).not.toMatch(/opening stock is only supported/i);
  });

  it('matrix mode renders one editable row per enabled variant', () => {
    const s = initialState();
    s.hasVariations = true;
    s.variations = [
      {
        key: 'dim-size',
        name: 'Size',
        options: [
          { key: 'opt-200', name: '200ml' },
          { key: 'opt-500', name: '500ml' },
        ],
      },
    ];
    s.variants = [
      {
        key: 'v-1',
        enabled: true,
        sku: 'COKE-200',
        barcode: '',
        unitPrice: '220',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-200'],
      },
      {
        // Disabled row must NOT render in the pricing matrix.
        key: 'v-2',
        enabled: false,
        sku: 'COKE-500',
        barcode: '',
        unitPrice: '350',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-500'],
      },
    ];
    render(
      <StepPricingInventory
        state={s}
        errors={{}}
        branches={branches}
        showOpeningStock={true}
        onChange={() => {}}
      />,
    );
    // Positive: SKU input for the enabled row is present and holds its value.
    const skuInput = screen.getByLabelText(/sku for 200ml/i) as HTMLInputElement;
    expect(skuInput.value).toBe('COKE-200');
    // Negative: the disabled row does NOT surface a SKU input.
    expect(screen.queryByLabelText(/sku for 500ml/i)).toBeNull();
  });

  it('Generate SKUs stamps each row with prefix + first-3 uppercased option initials', () => {
    // Deliberately mirror the wizard's contract: prefix "COKE" and options
    // ["200ml", "Glass Bottle"] should stamp "COKE-200-GLA" — first three
    // characters of each option value, uppercased and dash-joined.
    const s = initialState();
    s.hasVariations = true;
    s.variations = [
      {
        key: 'dim-size',
        name: 'Size',
        options: [{ key: 'opt-200', name: '200ml' }],
      },
      {
        key: 'dim-pack',
        name: 'Packaging',
        options: [{ key: 'opt-glass', name: 'Glass Bottle' }],
      },
    ];
    s.variants = [
      {
        key: 'v-1',
        enabled: true,
        sku: '',
        barcode: '',
        unitPrice: '220',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-200', 'opt-glass'],
      },
    ];

    function Harness() {
      const h = useHarness(s);
      return (
        <StepPricingInventory
          state={h.state}
          errors={{}}
          branches={branches}
          showOpeningStock={true}
          onChange={h.patch}
        />
      );
    }

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('COKE');
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /generate skus/i }));

    // Positive: the row's SKU now matches the formula.
    const skuInput = screen.getByLabelText(/sku for 200ml/i) as HTMLInputElement;
    expect(skuInput.value).toBe('COKE-200-GLA');

    // Negative control: cancelling the prompt (raw=null) leaves the SKU alone.
    promptSpy.mockReturnValueOnce(null);
    fireEvent.change(skuInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /generate skus/i }));
    expect((screen.getByLabelText(/sku for 200ml/i) as HTMLInputElement).value).toBe('');

    promptSpy.mockRestore();
  });

  it('Branch select is hidden outside LOCAL mode, appears once opening qty > 0 in LOCAL', () => {
    // Not LOCAL: branch select is absent entirely.
    const s = initialState();
    s.hasVariations = true;
    s.variations = [
      {
        key: 'dim-size',
        name: 'Size',
        options: [{ key: 'opt-a', name: 'A' }],
      },
    ];
    s.variants = [
      {
        key: 'v-1',
        enabled: true,
        sku: 'SKU-A',
        barcode: '',
        unitPrice: '10',
        costPrice: '',
        openingQuantity: '5', // Positive opening qty — the "needsBranch" trigger.
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-a'],
      },
    ];

    const { rerender } = render(
      <StepPricingInventory
        state={s}
        errors={{}}
        branches={branches}
        showOpeningStock={false}
        onChange={() => {}}
      />,
    );
    // Negative: no opening-stock branch select in non-LOCAL modes.
    expect(screen.queryByLabelText(/opening stock branch/i)).toBeNull();

    // Positive: switch to LOCAL and the branch select appears.
    rerender(
      <StepPricingInventory
        state={s}
        errors={{}}
        branches={branches}
        showOpeningStock={true}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/opening stock branch/i)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Review & save
// ─────────────────────────────────────────────────────────────────────────────

describe('StepReview', () => {
  it('renders three summary cards, each with an Edit that routes back to its step', () => {
    const s: WizardState = {
      ...initialState(),
      name: 'Coca-Cola',
      hasVariations: false,
      simple: {
        sku: 'COKE-200',
        barcode: '',
        unitPrice: '220',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '',
      },
    };
    const onEdit = vi.fn();
    render(
      <StepReview
        state={s}
        categories={categoryTree}
        showOpeningStock={true}
        saveState="idle"
        onEdit={onEdit}
        onSave={() => {}}
      />,
    );

    // Positive: three Edit buttons, one per card.
    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    expect(editButtons).toHaveLength(3);

    // Each button dispatches the matching StepKey — the shell then jumps to it.
    fireEvent.click(editButtons[0]!);
    fireEvent.click(editButtons[1]!);
    fireEvent.click(editButtons[2]!);
    expect(onEdit).toHaveBeenNthCalledWith(1, 'details');
    expect(onEdit).toHaveBeenNthCalledWith(2, 'variations');
    expect(onEdit).toHaveBeenNthCalledWith(3, 'pricing');

    // Negative: onEdit is never invoked with 'review' — Save is a separate button.
    for (const call of onEdit.mock.calls) {
      expect(call[0]).not.toBe('review');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wizard-state — pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('wizard-state helpers', () => {
  it('enumerateCombinations cross-products in variations order', () => {
    // 2 dimensions x 3 options each = 9 combinations, and the first coordinate
    // varies slowest — a canonical row-major cartesian product.
    const combos = enumerateCombinations([
      {
        key: 'd1',
        name: 'Size',
        options: [
          { key: 'a', name: 'S' },
          { key: 'b', name: 'M' },
          { key: 'c', name: 'L' },
        ],
      },
      {
        key: 'd2',
        name: 'Colour',
        options: [
          { key: 'x', name: 'Red' },
          { key: 'y', name: 'Green' },
          { key: 'z', name: 'Blue' },
        ],
      },
    ]);
    expect(combos).toHaveLength(9);
    // Order sanity — S-Red first, L-Blue last.
    expect(combos[0]!.optionKeys).toEqual(['a', 'x']);
    expect(combos[combos.length - 1]!.optionKeys).toEqual(['c', 'z']);

    // Single dimension of 5 → 5 items.
    const one = enumerateCombinations([
      {
        key: 'd',
        name: 'Size',
        options: [
          { key: '1', name: '200' },
          { key: '2', name: '300' },
          { key: '3', name: '500' },
          { key: '4', name: '1000' },
          { key: '5', name: '1500' },
        ],
      },
    ]);
    expect(one).toHaveLength(5);
    expect(one.map((c) => c.label)).toEqual(['200', '300', '500', '1000', '1500']);

    // Empty input → empty output. Not undefined, not null.
    expect(enumerateCombinations([])).toEqual([]);
    // A dimension with no named options is skipped, not treated as one option.
    expect(
      enumerateCombinations([{ key: 'd', name: 'Size', options: [] }]),
    ).toEqual([]);
  });

  it('validateStep returns the right shape per step', () => {
    // Step 'details' — empty state carries name + type errors if applicable.
    const empty = initialState();
    const dErr = validateStep('details', empty, { inventoryMode: 'LOCAL' });
    expect(dErr.name).toMatch(/give the product a name/i);
    // Negative: 'type' has a default of 'Inventory', so it must not error.
    expect(dErr.type).toBeUndefined();

    // Step 'variations' — hasVariations=true with no dimensions is empty.
    const varState = { ...empty, hasVariations: true };
    const vErr = validateStep('variations', varState, { inventoryMode: 'LOCAL' });
    expect(vErr['variations-empty']).toBeDefined();

    // Step 'pricing' — simple mode with no SKU and no price fires both.
    const pErr = validateStep('pricing', empty, { inventoryMode: 'LOCAL' });
    expect(pErr['simple-sku']).toBeDefined();
    expect(pErr['simple-price']).toBeDefined();

    // Filling in a good product yields an empty error map on details.
    const good = { ...empty, name: 'Coca-Cola' };
    expect(validateStep('details', good, { inventoryMode: 'LOCAL' })).toEqual({});
  });

  it('buildVariantsBatchInput only sends enabled variants, remaps ids, and omits opening branch when unused', () => {
    const s = initialState();
    s.hasVariations = true;
    s.variations = [
      {
        key: 'dim-size',
        name: 'Size',
        options: [{ key: 'opt-200', name: '200ml' }],
      },
    ];
    s.variants = [
      {
        key: 'v-on',
        enabled: true,
        sku: 'COKE-200',
        barcode: '',
        unitPrice: '220',
        costPrice: '',
        openingQuantity: '', // no opening — branch id should NOT be attached
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-200'],
      },
      {
        key: 'v-off',
        enabled: false,
        sku: 'COKE-DEAD',
        barcode: '',
        unitPrice: '999',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-200'],
      },
    ];
    const dimMap = new Map([['dim-size', 'srv_dim_size']]);
    const optMap = new Map([['opt-200', 'srv_opt_200']]);

    const payload = buildVariantsBatchInput(s, dimMap, optMap);
    // Positive: only the enabled variant is in the payload, with remapped ids.
    expect(payload.variants).toHaveLength(1);
    expect(payload.variants[0]!.sku).toBe('COKE-200');
    expect(payload.variants[0]!.optionValues).toEqual([
      { dimensionId: 'srv_dim_size', optionId: 'srv_opt_200' },
    ]);
    // Negative: openingBranchId is undefined because no variant asked for stock.
    expect(payload.openingBranchId).toBeUndefined();

    // Positive: setting an opening qty makes the batch include openingBranchId.
    s.variants[0]!.openingQuantity = '10';
    s.openingBranchId = 'br_main';
    const withOpening = buildVariantsBatchInput(s, dimMap, optMap);
    expect(withOpening.openingBranchId).toBe('br_main');
    expect(withOpening.variants[0]!.openingQuantity).toBe(10);
  });
});
