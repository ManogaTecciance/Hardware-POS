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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import type { CategoryNode } from '@/lib/products-api';

import { ProductPreview } from './product-preview';
import { StepDetails } from './step-details';
import { StepPricingInventory } from './step-pricing-inventory';
import { StepReview } from './step-review';
import { StepVariations } from './step-variations';
import { Stepper } from './stepper';
import {
  buildAttributesDocument,
  buildComponentsPayload,
  buildCreateInput,
  buildVariantsBatchInput,
  enumerateCombinations,
  initialState,
  MAX_NAME_LENGTH,
  MAX_SKU_LENGTH,
  validateStep,
  visibleSteps,
  type StepKey,
  type WizardState,
} from './wizard-state';
import { StepAttributes } from './step-attributes';
import type { AttributeField } from '@hardware-pos/shared';

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
/**
 * The variant matrix asks for its bulk-action values through the app's own
 * prompt (D145), so anything that renders Step 3 in matrix mode needs the
 * provider — `usePrompt` throws outside it rather than silently falling back
 * to `window.prompt`.
 */
function renderWithConfirm(ui: React.ReactElement) {
  return render(<ConfirmProvider>{ui}</ConfirmProvider>);
}

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
  function Harness({
    state,
    categories = categoryTree,
    // 3.15 — defaults to UNRESOLVED, which is what every pre-existing case
    // here was implicitly exercising before the shell fetched a rate.
    taxRatePercent = null,
  }: {
    state: WizardState;
    categories?: CategoryNode[];
    taxRatePercent?: number | null;
  }) {
    const h = useHarness(state);
    // Errors mirror the shell's contract: it computes them from validateStep
    // and hands them to the step. Recomputing here keeps the pipeline honest.
    const errors = validateStep('details', h.state, { inventoryMode: 'LOCAL' });
    return (
      <StepDetails
        positionLabel="Step 1 of 5"
        state={h.state}
        errors={errors}
        categories={categories}
        session={noopSession}
        businessKind="RETAIL"
        taxRatePercent={taxRatePercent}
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
        positionLabel="Step 1 of 5"
        state={s}
        errors={validateStep('details', s, { inventoryMode: 'LOCAL' })}
        categories={categoryTree}
        session={noopSession}
        businessKind="RETAIL"
        taxRatePercent={null}
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

  /*
   * 3.15 — the Taxable helper text names the tenant's actual rate.
   *
   * Three states, not two, and each asserted against the OTHER two rather than
   * on its own: a test that only checked "18%" appears would pass for a
   * component that printed the rate unconditionally, including while it was
   * still unresolved and while the switch was off.
   */
  describe('the Taxable helper text (3.15)', () => {
    const helper = () => document.body.textContent ?? '';

    it('names the rate once the shell has resolved it', () => {
      render(<Harness state={initialState()} taxRatePercent={18} />);

      expect(helper()).toMatch(/Tax applies at 18%/);
      // NEGATIVE: the rate-free wording is gone, not merely joined.
      expect(helper()).not.toMatch(/configured rate/);
    });

    it('keeps the rate-free wording while UNRESOLVED, rather than guessing', () => {
      render(<Harness state={initialState()} taxRatePercent={null} />);

      expect(helper()).toMatch(/this shop's configured rate/);
      // NEGATIVE: and never invents a number, least of all 0 — `null` is "not
      // known yet", which is a different fact from "this shop charges nothing".
      expect(helper()).not.toMatch(/applies at \d/);
      expect(helper()).not.toMatch(/0%/);
    });

    it('says so plainly when the shop has no rate set — the 0% dead end', () => {
      render(<Harness state={initialState()} taxRatePercent={0} />);

      // The question this answers is the operator's: "I switched Taxable on and
      // nothing was charged." Silence there is what sent them to ask.
      expect(helper()).toMatch(/tax rate is 0%/);
      expect(helper()).toMatch(/Settings/);
    });

    it('says zero-rated when the switch is OFF, whatever the shop rate is', () => {
      const off = { ...initialState(), taxable: false };
      render(<Harness state={off} taxRatePercent={18} />);

      expect(helper()).toMatch(/Zero-rated/);
      // NEGATIVE: the shop's 18% must not leak into a product that is exempt —
      // the exact confusion 3.14 was reported for.
      expect(helper()).not.toMatch(/applies at 18%/);
    });
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
    return <StepVariations positionLabel="Step 3 of 5" state={h.state} errors={{}} onChange={h.patch} />;
  }

  it('default state advertises the "no variations" mode with the switch on', () => {
    const s = initialState();
    // Positive precondition.
    expect(s.hasVariations).toBe(false);

    render(<StepVariations positionLabel="Step 3 of 5" state={s} errors={{}} onChange={() => {}} />);
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
          positionLabel="Step 4 of 5"
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
    renderWithConfirm(
      <StepPricingInventory
        positionLabel="Step 4 of 5"
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

  it('Generate SKUs stamps each row with prefix + first-3 uppercased option initials', async () => {
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
          positionLabel="Step 4 of 5"
          state={h.state}
          errors={{}}
          branches={branches}
          showOpeningStock={true}
          onChange={h.patch}
        />
      );
    }

    // Answering the NATIVE prompt with a different prefix on purpose (D145):
    // if this call site ever went back to `window.prompt`, the rows would read
    // "NATIVE-…" and the assertions below would fail loudly rather than pass
    // on a coincidence.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NATIVE');
    renderWithConfirm(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate SKUs' }));

    // The question is asked first, and nothing is stamped while it is open —
    // this is the guard the await replaced the blocking dialog with.
    await screen.findByRole('heading', { name: 'Generate SKUs' });
    expect((screen.getByLabelText(/sku for 200ml/i) as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('SKU prefix'), { target: { value: 'COKE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    // Positive: the row's SKU now matches the formula.
    await waitFor(() =>
      expect((screen.getByLabelText(/sku for 200ml/i) as HTMLInputElement).value).toBe(
        'COKE-200-GLA',
      ),
    );

    // Negative control: dismissing the prompt (raw=null) leaves the SKU alone.
    fireEvent.change(screen.getByLabelText(/sku for 200ml/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate SKUs' }));
    // Positive control for the negative: the question really was asked again,
    // so what follows cannot pass because the button had become inert.
    await screen.findByRole('heading', { name: 'Generate SKUs' });
    fireEvent.change(screen.getByLabelText('SKU prefix'), { target: { value: 'COKE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByLabelText('SKU prefix')).toBeNull());
    expect((screen.getByLabelText(/sku for 200ml/i) as HTMLInputElement).value).toBe('');
    expect(promptSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it('Set reorder for all writes the typed value to every enabled row, and nothing on dismissal', async () => {
    // The second of Step 3's two bulk actions (D145). Same shape as Generate
    // SKUs: ask, then apply — and only to rows the operator kept enabled.
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
        // Disabled, and carrying its own reorder point: "every enabled
        // variant" must leave this one exactly as it is.
        key: 'v-2',
        enabled: false,
        sku: 'COKE-500',
        barcode: '',
        unitPrice: '350',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '3',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-500'],
      },
    ];

    let latest: WizardState = s;
    function Harness() {
      const h = useHarness(s);
      latest = h.state;
      return (
        <StepPricingInventory
          positionLabel="Step 4 of 5"
          state={h.state}
          errors={{}}
          branches={branches}
          showOpeningStock={true}
          onChange={h.patch}
        />
      );
    }

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('99');
    renderWithConfirm(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Set reorder for all' }));
    await screen.findByRole('heading', { name: 'Reorder point for every enabled variant' });
    // Held back until the question is answered.
    expect((screen.getByLabelText(/reorder point for 200ml/i) as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('Reorder point'), { target: { value: ' 12 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all' }));

    // Positive: trimmed, and written to the enabled row.
    await waitFor(() =>
      expect((screen.getByLabelText(/reorder point for 200ml/i) as HTMLInputElement).value).toBe(
        '12',
      ),
    );
    // …and the disabled row is untouched, exactly as before the conversion.
    expect(latest.variants[1]!.reorderLevel).toBe('3');

    // Negative: dismissing leaves the value that is already there.
    fireEvent.click(screen.getByRole('button', { name: 'Set reorder for all' }));
    await screen.findByRole('heading', { name: 'Reorder point for every enabled variant' });
    fireEvent.change(screen.getByLabelText('Reorder point'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByLabelText('Reorder point')).toBeNull());
    expect((screen.getByLabelText(/reorder point for 200ml/i) as HTMLInputElement).value).toBe('12');
    expect(promptSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it('Set reorder for all keeps blank as a clear, and refuses a non-number', async () => {
    // The old `window.prompt` guard was `raw == null`, not `!raw`: an empty
    // box CLEARS the reorder point, and only a value that is neither blank
    // nor finite is rejected. Both survive the conversion (D145).
    const s = initialState();
    s.hasVariations = true;
    s.variations = [
      { key: 'dim-size', name: 'Size', options: [{ key: 'opt-200', name: '200ml' }] },
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
        reorderLevel: '5',
        imageUrl: null,
        isActive: true,
        optionKeys: ['opt-200'],
      },
    ];

    function Harness() {
      const h = useHarness(s);
      return (
        <StepPricingInventory
          positionLabel="Step 4 of 5"
          state={h.state}
          errors={{}}
          branches={branches}
          showOpeningStock={true}
          onChange={h.patch}
        />
      );
    }

    renderWithConfirm(<Harness />);
    const row = () => screen.getByLabelText(/reorder point for 200ml/i) as HTMLInputElement;
    expect(row().value).toBe('5');

    // Rejected: "abc" is not finite, so the rows keep the 5 they had.
    fireEvent.click(screen.getByRole('button', { name: 'Set reorder for all' }));
    await screen.findByRole('heading', { name: 'Reorder point for every enabled variant' });
    fireEvent.change(screen.getByLabelText('Reorder point'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all' }));
    await waitFor(() => expect(screen.queryByLabelText('Reorder point')).toBeNull());
    expect(row().value).toBe('5');

    // Accepted: an empty box is a clear, not a dismissal.
    fireEvent.click(screen.getByRole('button', { name: 'Set reorder for all' }));
    await screen.findByRole('heading', { name: 'Reorder point for every enabled variant' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all' }));
    await waitFor(() => expect(row().value).toBe(''));
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

    const { rerender } = renderWithConfirm(
      <StepPricingInventory
        positionLabel="Step 4 of 5"
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
      <ConfirmProvider>
        <StepPricingInventory
          positionLabel="Step 4 of 5"
          state={s}
          errors={{}}
          branches={branches}
          showOpeningStock={true}
          onChange={() => {}}
        />
      </ConfirmProvider>,
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
        positionLabel="Step 5 of 5"
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

// ─────────────────────────────────────────────────────────────────────────────
// D64 — the generic domain-attributes step and its state helpers
// ─────────────────────────────────────────────────────────────────────────────

const HOTEL_SCHEMA: readonly AttributeField[] = [
  { key: 'bedCount', label: 'Beds', type: 'integer', min: 1, max: 12 },
  { key: 'viewType', label: 'View', type: 'enum', options: ['Sea', 'Garden', 'City'] },
];

describe('D64 — attributes step visibility and payload', () => {
  it('visibleSteps includes the attributes step ONLY for a declaring schema', () => {
    // POSITIVE — a declaring domain gets the step, in order, after details.
    expect(visibleSteps(HOTEL_SCHEMA)).toEqual([
      'details',
      'attributes',
      'variations',
      'pricing',
      'review',
    ]);
    // NEGATIVE — the empty schema (hardware, restaurant, general today)
    // renders the historical four-step wizard, unchanged.
    expect(visibleSteps([])).toEqual(['details', 'variations', 'pricing', 'review']);
  });

  it('buildAttributesDocument converts raw inputs by field type and drops blanks', () => {
    const s = initialState();
    s.attributes = { bedCount: '2', viewType: '' };
    expect(buildAttributesDocument(s, HOTEL_SCHEMA)).toEqual({ bedCount: 2 });
    // An uncoercible number passes through raw so the SHARED validator words
    // the refusal — not a silent NaN.
    s.attributes = { bedCount: 'two', viewType: 'Sea' };
    expect(buildAttributesDocument(s, HOTEL_SCHEMA)).toEqual({
      bedCount: 'two',
      viewType: 'Sea',
    });
  });

  it('buildCreateInput sends the document only when the schema declares fields', () => {
    const s = initialState();
    s.name = 'Sea Room';
    s.simple.unitPrice = '100';
    s.attributes = { bedCount: '3' };
    // POSITIVE — declaring tenant: the whole document rides on the payload.
    expect(buildCreateInput(s, null, HOTEL_SCHEMA).attributes).toEqual({ bedCount: 3 });
    // NEGATIVE — non-declaring tenant: no `attributes` key AT ALL, so the
    // payload cannot trip the server's unknown-key refusal.
    expect('attributes' in buildCreateInput(s, null)).toBe(false);
  });

  it("validateStep('attributes') keys errors per field and passes valid input", () => {
    const s = initialState();
    s.attributes = { bedCount: '0' }; // below min
    const errs = validateStep('attributes', s, {
      inventoryMode: 'LOCAL',
      attributeSchema: HOTEL_SCHEMA,
    });
    expect(errs['attr-bedCount']).toMatch(/at least 1/i);
    s.attributes = { bedCount: '2', viewType: 'Sea' };
    expect(
      validateStep('attributes', s, { inventoryMode: 'LOCAL', attributeSchema: HOTEL_SCHEMA }),
    ).toEqual({});
    // No schema in ctx (every non-declaring tenant): the step validates to
    // nothing, which is what lets persist() iterate STEP_ORDER blindly.
    expect(validateStep('attributes', s, { inventoryMode: 'LOCAL' })).toEqual({});
  });
});

describe('StepAttributes', () => {
  function Harness({ state }: { state: WizardState }) {
    const h = useHarness(state);
    const errors = validateStep('attributes', h.state, {
      inventoryMode: 'LOCAL',
      attributeSchema: HOTEL_SCHEMA,
    });
    return (
      <StepAttributes
        state={h.state}
        errors={errors}
        schema={HOTEL_SCHEMA}
        positionLabel="Step 2 of 5"
        onChange={h.patch}
      />
    );
  }

  it('renders one control per schema field, typed by the field kind', () => {
    render(<Harness state={initialState()} />);
    // Integer → text input with the field's label; enum → select with options.
    expect(screen.getByLabelText('Beds')).toBeDefined();
    const view = screen.getByLabelText('View') as HTMLSelectElement;
    expect(Array.from(view.options).map((o) => o.textContent)).toEqual([
      'Not set',
      'Sea',
      'Garden',
      'City',
    ]);
  });

  it('surfaces the shared validator message against the offending field', () => {
    const s = initialState();
    s.attributes = { bedCount: 'two' };
    render(<Harness state={s} />);
    expect(screen.getByRole('alert').textContent).toMatch(/beds must be a number/i);
  });
});

/**
 * D161 — the calendar-date field a tenant can now define for itself.
 *
 * ## What makes these assertions non-vacuous
 *
 * "The launch date renders a date input" would pass for a step that rendered
 * `type="date"` on everything, so every case below asserts the OTHER fields in
 * the same schema at the same time: a text field that is not a date input, and
 * an enum that is still a select. One schema, three types, one render.
 *
 * The validation cases pair a date that exists with one that does not, because
 * a validator that accepted every `YYYY-MM-DD` string would pass the first
 * alone — and 2026-02-31 is exactly the string a browser date input on some
 * platforms will hand over.
 */
const TENANT_SCHEMA: readonly AttributeField[] = [
  { key: 'material', label: 'Material', type: 'text' },
  { key: 'fit', label: 'Fit', type: 'enum', options: ['Slim', 'Regular'] },
  { key: 'launchDate', label: 'Launch date', type: 'date' },
];

describe('D161 — a tenant-defined calendar date', () => {
  function Harness({ state }: { state: WizardState }) {
    const h = useHarness(state);
    const errors = validateStep('attributes', h.state, {
      inventoryMode: 'LOCAL',
      attributeSchema: TENANT_SCHEMA,
    });
    return (
      <StepAttributes
        state={h.state}
        errors={errors}
        schema={TENANT_SCHEMA}
        positionLabel="Step 2 of 5"
        onChange={h.patch}
      />
    );
  }

  it('renders a date input for the date field and for nothing else', () => {
    render(<Harness state={initialState()} />);

    // POSITIVE — the new branch is reached.
    const launch = screen.getByLabelText('Launch date') as HTMLInputElement;
    expect(launch.getAttribute('type')).toBe('date');

    // NEGATIVE — and did not swallow the other two types in the same schema.
    const material = screen.getByLabelText('Material') as HTMLInputElement;
    expect(material.getAttribute('type')).not.toBe('date');
    const fit = screen.getByLabelText('Fit');
    expect(fit.tagName).toBe('SELECT');
    // …which also proves the enum branch still precedes it, rather than the
    // date branch being unreachable behind an earlier match.
    expect(Array.from((fit as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      'Not set',
      'Slim',
      'Regular',
    ]);
  });

  it('a picked date reaches wizard state under the field key', () => {
    render(<Harness state={initialState()} />);
    const launch = screen.getByLabelText('Launch date') as HTMLInputElement;

    fireEvent.change(launch, { target: { value: '2026-09-09' } });

    expect((screen.getByLabelText('Launch date') as HTMLInputElement).value).toBe('2026-09-09');
    // NEGATIVE — typing into one field does not write into its neighbours.
    expect((screen.getByLabelText('Material') as HTMLInputElement).value).toBe('');
  });

  it('a date rides on the payload as a string, and a blank one is dropped', () => {
    const s = initialState();
    s.attributes = { launchDate: '2026-09-09', material: '' };
    // NOT coerced: a date is a scalar string in `attributes` (D64), and turning
    // it into a number or a Date here is how a document stops matching what the
    // shared validator will accept.
    expect(buildAttributesDocument(s, TENANT_SCHEMA)).toEqual({ launchDate: '2026-09-09' });
  });

  it('refuses a date that does not exist, and accepts one that does', () => {
    const s = initialState();
    const errorsFor = (value: string) => {
      s.attributes = { launchDate: value };
      return validateStep('attributes', s, {
        inventoryMode: 'LOCAL',
        attributeSchema: TENANT_SCHEMA,
      });
    };

    // NEGATIVE — the calendar, not the pattern: 31 February matches the shape.
    expect(errorsFor('2026-02-31')['attr-launchDate']).toBeDefined();
    // …and neither does a different notation for a real day.
    expect(errorsFor('09/09/2026')['attr-launchDate']).toBeDefined();
    // POSITIVE — a real date passes, so the refusals above are not "refuse all".
    expect(errorsFor('2026-09-09')).toEqual({});
    // Blank is not a refusal either; a field is optional unless declared.
    expect(errorsFor('')).toEqual({});
  });
});

describe('D65 — recipe drafts', () => {
  const draft = (over: Partial<import('./wizard-state').ComponentDraft> = {}) => ({
    componentProductId: 'p-bun',
    componentName: 'Bun',
    componentSku: 'BUN',
    quantity: '1',
    wastagePercent: '',
    ...over,
  });

  it('buildComponentsPayload converts the percent to a 0–1 rate and omits zero wastage', () => {
    const s = initialState();
    s.components = [draft(), draft({ componentProductId: 'p-patty', quantity: '0.15', wastagePercent: '5' })];
    expect(buildComponentsPayload(s)).toEqual([
      { componentProductId: 'p-bun', quantity: 1 },
      { componentProductId: 'p-patty', quantity: 0.15, wastageRate: 0.05 },
    ]);
  });

  it('validateStep(pricing) refuses unusable rows and passes clean ones', () => {
    const s = initialState();
    s.simple.sku = 'DISH-1';
    s.simple.unitPrice = '10';
    s.components = [draft({ quantity: '' }), draft({ componentProductId: 'p2', wastagePercent: '100' })];
    const errs = validateStep('pricing', s, { inventoryMode: 'LOCAL' });
    expect(errs['component-qty-0']).toMatch(/quantity/i);
    expect(errs['component-wastage-1']).toMatch(/0–99\.99/);
    // Positive control — the same rows, corrected, validate clean.
    s.components = [draft(), draft({ componentProductId: 'p2', wastagePercent: '5' })];
    expect(validateStep('pricing', s, { inventoryMode: 'LOCAL' })).toEqual({});
  });
});

/**
 * Client validation for the fields whose DTO rules the wizard used to ignore.
 *
 * Each rule mirrors a real server constraint, so every case is paired: the
 * value the API would refuse must error HERE, and the value it accepts must
 * pass. The empty-input positives matter most — these fields are optional, and
 * a check that fired on '' would turn every one of them into a required field
 * without anyone noticing.
 */
describe('validateStep — DTO-mirroring field rules', () => {
  /** A clean simple-mode state: only the field under test can be at fault. */
  const priced = (over: Partial<WizardState['simple']> = {}): WizardState => {
    const s = initialState();
    s.simple = { ...s.simple, sku: 'DISH-1', unitPrice: '10', ...over };
    return s;
  };
  const pricing = (s: WizardState) => validateStep('pricing', s, { inventoryMode: 'LOCAL' });

  it('simple mode refuses unusable cost / opening / reorder, and accepts blanks', () => {
    // Negative — each would either 400 on `@Min(0)` or vanish as NaN on save.
    expect(pricing(priced({ costPrice: '-1' }))['simple-cost']).toMatch(/negative/i);
    expect(pricing(priced({ costPrice: 'abc' }))['simple-cost']).toMatch(/must be a number/i);
    expect(pricing(priced({ openingQuantity: '-2' }))['simple-openq']).toMatch(/negative/i);
    expect(pricing(priced({ reorderLevel: 'x' }))['simple-reorder']).toMatch(/must be a number/i);

    // Positive — real values pass, and so does the untouched (empty) state.
    // Without this half the checks above would read as "these are required".
    //
    // D170 — the branch is part of the positive case now: an opening
    // quantity is posted as an inventory receipt, and a receipt has to land
    // somewhere. The assertion still says what it always said (these three
    // values are acceptable); it just supplies the branch that makes an
    // opening quantity a complete answer.
    expect(
      pricing({
        ...priced({ costPrice: '4.5', openingQuantity: '12', reorderLevel: '3' }),
        openingBranchId: 'br_main',
      }),
    ).toEqual({});
    // — and without it, the wizard says so rather than dropping the stock
    // on the floor, which is exactly what it used to do.
    expect(
      pricing(priced({ openingQuantity: '12' }))['openingBranchId'],
    ).toMatch(/where the opening stock lands/i);
    expect(pricing(priced())).toEqual({});
  });

  it('caps the product name at the DTO length, at the exact boundary', () => {
    const named = (name: string) =>
      validateStep('details', { ...initialState(), name }, { inventoryMode: 'LOCAL' });
    // 200 is @MaxLength(200) — allowed; 201 is the first refusal.
    expect(named('N'.repeat(MAX_NAME_LENGTH))).toEqual({});
    expect(named('N'.repeat(MAX_NAME_LENGTH + 1)).name).toMatch(/200 characters/);
    // The empty case keeps its own message rather than the length one — the
    // two must not collapse into each other.
    expect(named('').name).toMatch(/give the product a name/i);
  });

  it('shows the name counter only near the cap, and the input enforces it', () => {
    const withName = (name: string) => {
      cleanup();
      render(
        <StepDetails
          positionLabel="Step 1 of 5"
          state={{ ...initialState(), name }}
          errors={{}}
          categories={categoryTree}
          session={noopSession}
          taxRatePercent={null}
          businessKind="RETAIL"
          onChange={() => {}}
        />,
      );
      const input = screen.getByLabelText(/product name/i) as HTMLInputElement;
      return {
        maxLength: input.maxLength,
        counter: screen.queryByText(new RegExp(`${name.length} / ${MAX_NAME_LENGTH}`)),
      };
    };
    // The input is what actually stops the typing.
    expect(withName('Milk').maxLength).toBe(MAX_NAME_LENGTH);
    // Negative: a short name must not carry a counter — it would nag about a
    // limit nothing is near.
    expect(withName('Milk').counter).toBeNull();
    // Positive: at 80% it appears, so hitting the ceiling is never a surprise.
    expect(withName('N'.repeat(MAX_NAME_LENGTH * 0.8)).counter).not.toBeNull();
    expect(withName('N'.repeat(MAX_NAME_LENGTH)).counter).not.toBeNull();
  });

  it('never blocks on a stock field the step is not showing', () => {
    // A value can outlive its input: type a reorder point, then turn Track
    // stock off (D101) and the string stays in state with nowhere to render.
    // Both halves matter — the guard must silence the HIDDEN field only, or it
    // would be indistinguishable from having dropped the check altogether.
    const stale = (trackInventory: boolean, inventoryMode: 'LOCAL' | 'DISABLED') => {
      const s = priced({ reorderLevel: '-3', openingQuantity: '-9' });
      s.trackInventory = trackInventory;
      return validateStep('pricing', s, { inventoryMode });
    };
    // Visible → blamed.
    const shown = stale(true, 'LOCAL');
    expect(shown['simple-reorder']).toMatch(/negative/i);
    expect(shown['simple-openq']).toMatch(/negative/i);
    // Hidden by Track stock → silent, because there is no field to fix.
    expect(stale(false, 'LOCAL')).toEqual({});
    // Reorder shows without LOCAL; opening stock does not.
    const noLocal = stale(true, 'DISABLED');
    expect(noLocal['simple-reorder']).toMatch(/negative/i);
    expect(noLocal['simple-openq']).toBeUndefined();
  });

  it('simple mode caps the SKU at the DTO length, at the exact boundary', () => {
    // 80 is @MaxLength(80) — allowed; 81 is the first refusal.
    expect(pricing(priced({ sku: 'S'.repeat(MAX_SKU_LENGTH) }))).toEqual({});
    expect(pricing(priced({ sku: 'S'.repeat(MAX_SKU_LENGTH + 1) }))['simple-sku']).toMatch(
      /80 characters/,
    );
  });

  it('prep time must be a whole number, separately from the 0-360 range', () => {
    const prep = (v: string) => {
      const s = initialState();
      s.name = 'Kottu';
      s.foodType = 'FOOD';
      s.prepMinutes = v;
      return validateStep('details', s, { inventoryMode: 'LOCAL', businessKind: 'RESTAURANT' });
    };
    // Negative: `@IsInt()` on the DTO — a half-minute is a 400, not a rounding.
    expect(prep('12.5').prepMinutes).toMatch(/whole number/i);
    // The range message is still its own distinct answer, not swallowed.
    expect(prep('400').prepMinutes).toMatch(/0-360/);
    // Positive: a whole number inside the range, and the untouched blank.
    expect(prep('15').prepMinutes).toBeUndefined();
    expect(prep('').prepMinutes).toBeUndefined();
  });

  describe('variations', () => {
    const twoDimensions = (secondName: string): WizardState => {
      const s = initialState();
      s.hasVariations = true;
      s.variations = [
        { key: 'd1', name: 'Size', options: [{ key: 'o1', name: 'S' }] },
        { key: 'd2', name: secondName, options: [{ key: 'o2', name: 'Red' }] },
      ];
      return s;
    };
    const variations = (s: WizardState) =>
      validateStep('variations', s, { inventoryMode: 'LOCAL' });

    it('refuses two variations sharing a name — the server upserts by name', () => {
      // Case-insensitive: "size" and "Size" collide on the same upsert.
      const errs = variations(twoDimensions('size'));
      expect(errs['variation-name-1']).toMatch(/unique/i);
      // The FIRST one is not at fault — blaming both would be noise.
      expect(errs['variation-name-0']).toBeUndefined();
      // Positive control: a distinct name validates clean.
      expect(variations(twoDimensions('Colour'))).toEqual({});
    });

    it('shows the blank-option error next to the option it blames', () => {
      // The key has always been produced; nothing rendered it, so a half-filled
      // option list blocked Continue with no message anywhere on the step.
      const s = initialState();
      s.hasVariations = true;
      s.variations = [
        { key: 'd1', name: 'Size', options: [{ key: 'o1', name: 'S' }, { key: 'o2', name: '' }] },
      ];
      const errs = variations(s);
      expect(errs['variation-option-0-1']).toMatch(/option needs a name/i);

      render(<StepVariations positionLabel="Step 3 of 5" state={s} errors={errs} onChange={() => {}} />);
      const shown = screen.getAllByRole('alert').map((n) => n.textContent ?? '');
      expect(shown.some((t) => /option needs a name/i.test(t))).toBe(true);
      // Negative control: the filled option is not flagged.
      const inputs = screen.getAllByPlaceholderText('Option value') as HTMLInputElement[];
      expect(inputs[0]!.getAttribute('aria-invalid')).not.toBe('true');
      expect(inputs[1]!.getAttribute('aria-invalid')).toBe('true');
    });
  });

  describe('variant rows', () => {
    /** One enabled variant; `over` puts the field under test out of range. */
    const withVariant = (over: Partial<WizardState['variants'][number]> = {}): WizardState => {
      const s = initialState();
      s.hasVariations = true;
      s.variations = [
        { key: 'dim-size', name: 'Size', options: [{ key: 'opt-200', name: '200ml' }] },
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
          ...over,
        },
      ];
      return s;
    };

    it('holds each row to the variant DTO and passes a clean row', () => {
      // Negative — every one of these is a documented DTO refusal.
      expect(pricing(withVariant({ sku: 'S'.repeat(81) }))['variant-sku-0']).toMatch(
        /80 characters/,
      );
      expect(pricing(withVariant({ barcode: 'B'.repeat(81) }))['variant-barcode-0']).toMatch(
        /80 characters/,
      );
      // `@IsNumber({ maxDecimalPlaces: 2 })` — stricter than the product DTO.
      expect(pricing(withVariant({ unitPrice: '10.999' }))['variant-price-0']).toMatch(
        /2 decimal places/,
      );
      expect(pricing(withVariant({ openingQuantity: '-1' }))['variant-openq-0']).toMatch(
        /negative/i,
      );
      expect(pricing(withVariant({ reorderLevel: '1.2345' }))['variant-reorder-0']).toMatch(
        /3 decimal places/,
      );

      // Positive — boundary values the server accepts must not be blocked:
      // 80-char SKU, 2dp price, 3dp reorder, and empty optionals.
      const clean = withVariant({
        sku: 'S'.repeat(MAX_SKU_LENGTH),
        barcode: 'B'.repeat(MAX_SKU_LENGTH),
        unitPrice: '10.99',
        openingQuantity: '2.125',
        reorderLevel: '1.234',
      });
      // Seeding stock is what makes the branch required (pre-existing rule) —
      // answer it so this case isolates the fields under test.
      clean.openingBranchId = 'br_main';
      expect(pricing(clean)).toEqual({});
      expect(pricing(withVariant())).toEqual({});
    });

    it('still reports duplicate SKUs when one of the pair is also too long', () => {
      // The length check must not consume the row and hide the collision — the
      // set is fed regardless of length, so row 1 still sees row 0's key.
      const s = withVariant({ sku: 'S'.repeat(81) });
      s.variants.push({ ...s.variants[0]!, key: 'v-2', sku: 'S'.repeat(81) });
      const errs = pricing(s);
      expect(errs['variant-sku-0']).toMatch(/80 characters/);
      expect(errs['variant-sku-1']).toMatch(/unique/i);
    });

    it('shows the new row errors on screen, in the field they blame', () => {
      // A validation that blocks Continue with no visible message is worse
      // than none — prove each new key reaches the matrix.
      const s = withVariant({ barcode: 'B'.repeat(81), openingQuantity: '-1', reorderLevel: '1.2345' });
      renderWithConfirm(
        <StepPricingInventory
          positionLabel="Step 4 of 5"
          state={s}
          errors={pricing(s)}
          branches={branches}
          showOpeningStock={true}
          onChange={() => {}}
        />,
      );
      expect(screen.getByLabelText(/barcode for 200ml/i).getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByLabelText(/opening stock for 200ml/i).getAttribute('aria-invalid')).toBe(
        'true',
      );
      expect(screen.getByLabelText(/reorder point for 200ml/i).getAttribute('aria-invalid')).toBe(
        'true',
      );
      const alerts = screen.getAllByRole('alert').map((n) => n.textContent ?? '');
      expect(alerts.some((t) => /80 characters/.test(t))).toBe(true);
      expect(alerts.some((t) => /negative/i.test(t))).toBe(true);
      expect(alerts.some((t) => /3 decimal places/.test(t))).toBe(true);
      // Negative control: the untouched SKU and price cells are not flagged.
      expect(screen.getByLabelText(/sku for 200ml/i).getAttribute('aria-invalid')).not.toBe('true');
      expect(
        screen.getByLabelText(/selling price for 200ml/i).getAttribute('aria-invalid'),
      ).not.toBe('true');
    });
  });
});

describe('ProductPreview — long unbroken values stay in the card', () => {
  // A name with no space has no break opportunity, so it used to run straight
  // past the card's edge. jsdom has no layout engine and cannot prove the wrap
  // itself — the real proof is a browser measurement (0 px overflow at 1280,
  // 1024 and 820 wide). This pins the MECHANISM so it cannot be dropped
  // silently, and pairs it with the value actually rendering in full.
  const LONG = 'Beef Steak34444444444444444444444444444444444444444444444';

  it('renders the whole name and gives it a break-words rule', () => {
    const s = initialState();
    s.name = LONG;
    render(<ProductPreview state={s} categories={categoryTree} currentStepIndex={0} />);

    const name = screen.getByText(LONG);
    // Positive: the value is shown in full — the fix is wrapping, not clipping.
    expect(name.textContent).toBe(LONG);
    expect(name.className).toMatch(/break-words/);
    // Negative: it must NOT be solved by truncating the operator's input away.
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(name.className).not.toMatch(/line-clamp/);
  });

  it('D86 — resolves a stored /uploads path against the API origin', () => {
    // An upload is stored as `/uploads/<key>` and served by the API, a
    // DIFFERENT origin from the web app. Rendered raw the browser resolved it
    // against the app's own origin and 404'd, so the preview stayed empty
    // however many times you uploaded.
    const s = initialState();
    s.imageUrl = '/uploads/products/abc.webp';
    const { container } = render(
      <ProductPreview state={s} categories={categoryTree} currentStepIndex={0} />,
    );
    const src = container.querySelector('img')?.getAttribute('src') ?? '';
    // Negative: the bare stored path is exactly what was broken.
    expect(src).not.toBe('/uploads/products/abc.webp');
    // Positive: absolute, and still pointing at the same stored object.
    expect(src).toMatch(/^https?:\/\//);
    expect(src.endsWith('/uploads/products/abc.webp')).toBe(true);
  });

  it('D86 — leaves an absolute or data URL untouched', () => {
    // The "Image URL" tab accepts a remote URL, and re-prefixing one would
    // break it just as surely as not prefixing the stored path.
    for (const url of ['https://cdn.test/a.png', 'data:image/png;base64,AAAA']) {
      cleanup();
      const s = initialState();
      s.imageUrl = url;
      const { container } = render(
        <ProductPreview state={s} categories={categoryTree} currentStepIndex={0} />,
      );
      expect(container.querySelector('img')?.getAttribute('src')).toBe(url);
    }
  });

  it('wraps the free-text description and brand too, not just the name', () => {
    const s = initialState();
    s.name = 'Steak';
    s.description = 'D'.repeat(120);
    s.brand = 'B'.repeat(120);
    render(<ProductPreview state={s} categories={categoryTree} currentStepIndex={0} />);

    expect(screen.getByText('D'.repeat(120)).className).toMatch(/break-words/);
    // The brand line is "Brand: <value>", so match on the containing element.
    const brandLine = screen.getByText(/^Brand: B+$/);
    expect(brandLine.className).toMatch(/break-words/);
  });
});

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

    // Step 'pricing' — a missing price is an error; a missing SKU is not.
    //
    // D170 — this pair used to assert that BOTH fired. SKU is optional on
    // the server (nullable column, `@IsOptional()`, `dto.sku ?? null`), and
    // the wizard's own placeholder offered to generate one, so requiring it
    // here was the single thing making that offer impossible to accept.
    // Asserted as a PAIR against one state so "validation stopped running"
    // cannot pass: the price must still fire in the same call.
    const pErr = validateStep('pricing', empty, { inventoryMode: 'LOCAL' });
    expect(pErr['simple-sku']).toBeUndefined();
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

// ─────────────────────────────────────────────────────────────────────────────
// D101 — the restaurant Track-stock switch
// ─────────────────────────────────────────────────────────────────────────────

describe('D101 — restaurant Track stock', () => {
  function restaurantState(over: Partial<WizardState> = {}): WizardState {
    return { ...initialState(), foodType: 'FOOD', trackInventory: false, ...over };
  }

  it('the restaurant Step 1 offers the switch; the retail item-type control stays hidden', () => {
    function Harness() {
      const h = useHarness(restaurantState());
      return (
        <StepDetails
          positionLabel="Step 1 of 5"
          state={h.state}
          errors={{}}
          categories={categoryTree}
          session={noopSession}
          taxRatePercent={null}
          businessKind="RESTAURANT"
          onChange={h.patch}
        />
      );
    }
    render(<Harness />);

    // POSITIVE: the switch is there, off, with the dish wording.
    const toggle = screen.getByRole('switch', { name: /track stock/i });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).toMatch(/no stock count/i);

    // NEGATIVE: restaurant Step 1 still suppresses the retail radiogroup.
    expect(screen.queryByRole('radiogroup', { name: /item type/i })).toBeNull();

    // Flipping it updates state and the wording flips with it.
    fireEvent.click(toggle);
    expect(screen.getByRole('switch', { name: /track stock/i }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(document.body.textContent).toMatch(/each sale reduces the count/i);
  });

  it('retail Step 1 keeps its own switch and never shows the restaurant wording', () => {
    render(
      <StepDetails
        positionLabel="Step 1 of 5"
        state={initialState()}
        errors={{}}
        categories={categoryTree}
        session={noopSession}
        taxRatePercent={null}
        businessKind="RETAIL"
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole('switch', { name: /track inventory/i })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /^track stock$/i })).toBeNull();
  });

  it('an untracked dish gets neither opening quantity nor a reorder point on Step 3', () => {
    render(
      <StepPricingInventory
        positionLabel="Step 4 of 5"
        state={restaurantState()}
        errors={{}}
        branches={branches}
        showOpeningStock={true}
        // No session on purpose: the Restaurant additions cards fetch their
        // catalogues, and this spec is about the stock fields alone.
        businessKind="RESTAURANT"
        onChange={() => {}}
      />,
    );

    expect(screen.queryByLabelText(/opening quantity/i)).toBeNull();
    expect(screen.queryByLabelText(/reorder point/i)).toBeNull();
  });

  it('a tracked packaged good keeps both — the fields follow the answer, not the tenant', () => {
    render(
      <StepPricingInventory
        positionLabel="Step 4 of 5"
        state={restaurantState({ trackInventory: true })}
        errors={{}}
        branches={branches}
        showOpeningStock={true}
        // No session on purpose: the Restaurant additions cards fetch their
        // catalogues, and this spec is about the stock fields alone.
        businessKind="RESTAURANT"
        onChange={() => {}}
      />,
    );

    expect(screen.getByLabelText(/opening quantity/i)).toBeTruthy();
    expect(screen.getByLabelText(/reorder point/i)).toBeTruthy();
  });

  it('buildCreateInput carries the answer as trackStock, in both positions', () => {
    const off = buildCreateInput(restaurantState(), null);
    expect(off.trackStock).toBe(false);

    const on = buildCreateInput(restaurantState({ trackInventory: true }), null);
    expect(on.trackStock).toBe(true);
  });
});
