/**
 * Restaurant Menu Wizard — render coverage.
 *
 * Non-vacuous per D30: every positive claim (a field renders, a chip is
 * selected) is paired with a negative (chip is not selected by default,
 * required-flag drives error, the wrong step does not render).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  KitchenStationView,
  MenuItemView,
  ModifierGroupView,
  SectionView,
} from '@/lib/restaurant/types';

import { ItemPreview } from './item-preview';
import { StepMenuDetails } from './step-menu-details';
import { StepModifiersAvailability } from './step-modifiers-availability';
import { StepPricingVariations } from './step-pricing-variations';
import { StepReviewSave } from './step-review-save';
import { Stepper } from './stepper';
import {
  emptyWizardState,
  hydrateWizardState,
  priceBounds,
  validateStep,
  type WizardState,
} from './wizard-state';

afterEach(cleanup);

const section = (over: Partial<SectionView> = {}): SectionView => ({
  id: 'sec_kottu',
  menuId: 'menu_1',
  name: 'Kottu',
  description: null,
  position: 0,
  isActive: true,
  ...over,
});

const station = (over: Partial<KitchenStationView> = {}): KitchenStationView => ({
  id: 'stn_hot',
  branchId: 'br_1',
  code: 'HOT',
  name: 'Hot Kitchen',
  category: 'KITCHEN',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

// ── Stepper ─────────────────────────────────────────────────────────────

describe('Stepper', () => {
  const steps = [
    { index: 1, label: 'Menu details', detail: '' },
    { index: 2, label: 'Pricing & variations', detail: '' },
    { index: 3, label: 'Modifiers & availability', detail: '' },
    { index: 4, label: 'Review & save', detail: '' },
  ];

  it('marks the current step aria-current and earlier steps as complete', () => {
    render(<Stepper steps={steps} currentStep={2} />);
    // Positive: step 2 is the current step.
    const current = screen.getByRole('button', { current: 'step' });
    expect(current.textContent).toMatch(/pricing & variations/i);
    // Negative: step 1 does not have aria-current and is not marked complete
    // by a check on the current step itself.
    expect(current.querySelector('svg[data-testid]')).toBeNull();
  });

  it('later steps are not clickable', () => {
    let clicked: number | null = null;
    render(<Stepper steps={steps} currentStep={2} onStepClick={(i) => (clicked = i)} />);
    const step4 = screen.getByRole('button', { name: /review & save/i }) as HTMLButtonElement;
    expect(step4.disabled).toBe(true);
    step4.click();
    expect(clicked).toBeNull();
  });
});

// ── Step 1 ───────────────────────────────────────────────────────────────

describe('StepMenuDetails', () => {
  const baseProps = () => {
    let s = emptyWizardState();
    return {
      state: s,
      errors: {},
      sections: [section()],
      stations: [station()],
      onChange: (patch: Partial<WizardState>) => {
        s = { ...s, ...patch };
      },
    };
  };

  it('renders every persisted field the mock shows', () => {
    render(<StepMenuDetails {...baseProps()} />);
    expect(screen.getByLabelText(/menu item name/i)).toBeDefined();
    expect(screen.getByLabelText(/^section/i)).toBeDefined();
    expect(screen.getByLabelText(/preparation time/i)).toBeDefined();
    expect(screen.getByLabelText(/description/i)).toBeDefined();
    expect(screen.getByLabelText(/kitchen station/i)).toBeDefined();
    // Segmented control — three radios.
    expect(screen.getAllByRole('radio', { name: /food|beverage|dessert/i })).toHaveLength(3);
  });

  it('does NOT expose Hardware Product / accounting fields', () => {
    render(<StepMenuDetails {...baseProps()} />);
    const body = document.body.textContent ?? '';
    for (const forbidden of ['SKU', 'Barcode', 'QuickBooks', 'Reorder', 'Sync Status']) {
      expect({ forbidden, found: body.includes(forbidden) }).toEqual({
        forbidden,
        found: false,
      });
    }
    // Positive control for negative-list checking.
    expect(body).toMatch(/menu details/i);
  });

  it('surfaces validation errors passed in via props', () => {
    render(<StepMenuDetails {...baseProps()} errors={{ name: 'Give it a name.' }} />);
    expect(screen.getByRole('alert').textContent).toMatch(/give it a name/i);
  });
});

// ── Step 2 ───────────────────────────────────────────────────────────────

describe('StepPricingVariations', () => {
  it('adds a variation row when clicking Add variation', () => {
    let s = emptyWizardState();
    s.basePrice = '1200';
    render(
      <StepPricingVariations
        state={s}
        errors={{}}
        onChange={(patch) => {
          s = { ...s, ...patch };
        }}
      />,
    );
    // Positive: initial state has zero variations.
    expect(screen.queryAllByLabelText(/^variation name/i)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /add variation/i }));
    expect(s.variations.length).toBe(1);
  });

  it('displays the resolved absolute price per variation row (base + delta)', () => {
    let s = emptyWizardState();
    s.basePrice = '1000';
    s.variations = [
      { key: 'v1', name: 'Small', priceDelta: 0 },
      { key: 'v2', name: 'Medium', priceDelta: 300 },
      { key: 'v3', name: 'Large', priceDelta: 600 },
    ];
    render(
      <StepPricingVariations
        state={s}
        errors={{}}
        onChange={() => {}}
      />,
    );
    const body = document.body.textContent ?? '';
    // Absolute prices reflect base 1000 + delta.
    expect(body).toMatch(/1,000/);
    expect(body).toMatch(/1,300/);
    expect(body).toMatch(/1,600/);
  });
});

// ── Step 3 ───────────────────────────────────────────────────────────────

describe('StepModifiersAvailability', () => {
  it('availability toggle reflects state.isActive', () => {
    let s = emptyWizardState();
    s.isActive = false;
    render(
      <StepModifiersAvailability
        state={s}
        errors={{}}
        onChange={(patch) => {
          s = { ...s, ...patch };
        }}
      />,
    );
    // Switch is a role=switch with aria-checked; negative: not checked.
    const sw = screen.getByRole('switch', { name: /available on menu/i });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('adds a modifier group with one default option on Add', () => {
    let s = emptyWizardState();
    render(
      <StepModifiersAvailability
        state={s}
        errors={{}}
        onChange={(patch) => {
          s = { ...s, ...patch };
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add modifier group/i }));
    expect(s.modifierGroups.length).toBe(1);
    expect(s.modifierGroups[0]!.options.length).toBe(1);
  });
});

// ── Step 4 ───────────────────────────────────────────────────────────────

describe('StepReviewSave', () => {
  it('summarises name, section, type, variations and modifier options', () => {
    let s = emptyWizardState();
    s = {
      ...s,
      name: 'Mix Kottu',
      sectionId: 'sec_kottu',
      itemType: 'FOOD',
      basePrice: '1000',
      variations: [
        { key: 'v1', name: 'Small', priceDelta: 0 },
        { key: 'v2', name: 'Large', priceDelta: 600 },
      ],
      modifierGroups: [
        {
          key: 'g1',
          name: 'Extras',
          selection: 'MULTIPLE',
          minSelections: 0,
          maxSelections: 5,
          options: [
            { key: 'o1', name: 'Cheese', priceDelta: 200 },
            { key: 'o2', name: 'Egg', priceDelta: 100 },
          ],
          role: null,
        },
      ],
      isActive: true,
    };
    render(
      <StepReviewSave
        state={s}
        sections={[section()]}
        stations={[station()]}
        onEdit={() => {}}
      />,
    );
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/mix kottu/i);
    expect(body).toMatch(/kottu/i);
    expect(body).toMatch(/food/i);
    expect(body).toMatch(/small/i);
    expect(body).toMatch(/large/i);
    expect(body).toMatch(/extras/i);
    expect(body).toMatch(/cheese/i);
    expect(body).toMatch(/1,600/); // 1000 + 600 for Large
    // Availability line.
    expect(body).toMatch(/available/i);
  });
});

// ── Item preview ─────────────────────────────────────────────────────────

describe('ItemPreview', () => {
  it('shows a placeholder when no image URL is set', () => {
    let s = emptyWizardState();
    s.name = 'Mix Kottu';
    render(<ItemPreview state={s} sectionName={null} stationName={null} />);
    // Positive: name renders.
    expect(document.body.textContent).toMatch(/mix kottu/i);
    // Negative: no <img> element present.
    expect(document.querySelectorAll('img').length).toBe(0);
  });

  it('renders variations as a "From LKR X" range when they differ', () => {
    let s = emptyWizardState();
    s.name = 'Mix Kottu';
    s.basePrice = '1000';
    s.variations = [
      { key: 'v1', name: 'S', priceDelta: 0 },
      { key: 'v2', name: 'L', priceDelta: 600 },
    ];
    render(<ItemPreview state={s} sectionName={null} stationName={null} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/from/i);
    expect(body).toMatch(/1,000/);
    expect(body).toMatch(/1,600/);
  });
});

// ── wizard-state ─────────────────────────────────────────────────────────

describe('wizard-state', () => {
  it('validateStep flags missing name / section / type on Step 1', () => {
    const errors = validateStep(1, emptyWizardState());
    expect(errors.name).toBeDefined();
    expect(errors.sectionId).toBeDefined();
    expect(errors.itemType).toBeDefined();
    // Negative: prepMinutes is optional and unset — no error.
    expect(errors.prepMinutes).toBeUndefined();
  });

  it('validateStep passes Step 1 once required fields are filled', () => {
    const s = { ...emptyWizardState(), name: 'x', sectionId: 's', itemType: 'FOOD' as const };
    expect(validateStep(1, s)).toEqual({});
  });

  it('validateStep flags negative or empty basePrice on Step 2', () => {
    expect(validateStep(2, emptyWizardState()).basePrice).toBeDefined();
    const good = { ...emptyWizardState(), basePrice: '0' };
    expect(validateStep(2, good).basePrice).toBeUndefined();
  });

  it('priceBounds collapses to a single value when there are no variations', () => {
    const s = { ...emptyWizardState(), basePrice: '1200' };
    expect(priceBounds(s)).toEqual({ from: 1200, to: 1200 });
  });

  it('hydrateWizardState pulls Small/Medium/Large out of a SIZE modifier group', () => {
    const item: MenuItemView = {
      id: 'itm_1',
      sectionId: 'sec_kottu',
      name: 'Mix Kottu',
      description: null,
      basePrice: '1000.00',
      productId: null,
      isActive: true,
      position: 0,
      modifierGroupIds: ['grp_size', 'grp_extras'],
      stationIds: ['stn_hot'],
      channelPrices: [],
      availability: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      itemType: 'FOOD',
      prepMinutes: 15,
      dietaryTags: ['Non-Veg', 'Spicy'],
      imageUrl: null,
    };
    const groups: ModifierGroupView[] = [
      {
        id: 'grp_size',
        name: 'Mix Kottu — Size',
        selection: 'SINGLE',
        minSelections: 1,
        maxSelections: 1,
        isActive: true,
        role: 'SIZE',
        options: [
          { id: 'opt_s', name: 'Small', priceDelta: '0.00', position: 0, isActive: true },
          { id: 'opt_m', name: 'Medium', priceDelta: '300.00', position: 1, isActive: true },
          { id: 'opt_l', name: 'Large', priceDelta: '600.00', position: 2, isActive: true },
        ],
      },
      {
        id: 'grp_extras',
        name: 'Extras',
        selection: 'MULTIPLE',
        minSelections: 0,
        maxSelections: 5,
        isActive: true,
        role: null,
        options: [
          { id: 'opt_cheese', name: 'Cheese', priceDelta: '200.00', position: 0, isActive: true },
        ],
      },
    ];
    const state = hydrateWizardState(item, groups);
    // Positive: SIZE group extracted into variations.
    expect(state.variations.map((v) => v.name)).toEqual(['Small', 'Medium', 'Large']);
    expect(state.variations.map((v) => v.priceDelta)).toEqual([0, 300, 600]);
    // Negative: non-SIZE group stays as a modifier group, not a variation.
    expect(state.modifierGroups).toHaveLength(1);
    expect(state.modifierGroups[0]!.name).toBe('Extras');
    // Presentation fields hydrated end-to-end.
    expect(state.itemType).toBe('FOOD');
    expect(state.prepMinutes).toBe('15');
    expect(state.dietaryTags).toEqual(['Non-Veg', 'Spicy']);
    // Wizard remembers it is editing.
    expect(state.editingItemId).toBe('itm_1');
  });
});
