/**
 * Requirement 2 (2026-09-08) — a product's variations come from the tenant's
 * attribute library, not from an operator retyping "Size" and "Small".
 *
 * The library (D125/D125a), the nullable links on `ProductVariationDimension`
 * and `ProductVariationOption`, and the PUT contract that accepts them all
 * shipped in Phase 5. The wizard simply never used any of it: `VariationDraft`
 * had nowhere to hold an id, so `buildVariationsPayload` could not send one.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The category filter is asserted from BOTH sides — the category's own
 * attributes are offered AND another category's are not. A test for the
 * inclusion alone would pass for a filter that had been removed entirely,
 * which is exactly the "do not show unrelated attributes" failure.
 *
 * The free-text fallback is asserted too. Every hardware and restaurant
 * workspace has an empty library, so if the dropdown replaced the inputs
 * unconditionally those tenants could no longer declare a variation at all.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AttributeDefinition } from '@/lib/products/attribute-library-api';
import type { ProductVariationDimension } from '@/lib/products/variants-api';

import { StepVariations } from './step-variations';
import {
  attributesForCategory,
  buildVariationsPayload,
  hydrateFromProduct,
  initialState,
  type WizardState,
} from './wizard-state';

afterEach(cleanup);

const BEAUTY = 'cat_beauty';
const HARDWARE = 'cat_hardware';

/** Mirrors the Attribute library screen: Size(Small,Large), Color(Red,White). */
const LIBRARY: AttributeDefinition[] = [
  {
    id: 'def_size',
    name: 'Size',
    position: 0,
    categoryId: BEAUTY,
    categoryName: 'Beauty Products',
    linkedDimensionCount: 0,
    options: [
      { id: 'opt_small', code: 'SMALL', name: 'Small', position: 0, swatchHex: null },
      { id: 'opt_large', code: 'LARGE', name: 'Large', position: 1, swatchHex: null },
    ],
  },
  {
    id: 'def_color',
    name: 'Color',
    position: 1,
    categoryId: BEAUTY,
    categoryName: 'Beauty Products',
    linkedDimensionCount: 0,
    options: [
      { id: 'opt_red', code: 'RED', name: 'Red', position: 0, swatchHex: '#ff0000' },
      { id: 'opt_white', code: 'WHITE', name: 'White', position: 1, swatchHex: '#ffffff' },
    ],
  },
  {
    id: 'def_grit',
    name: 'Grit',
    position: 2,
    categoryId: HARDWARE,
    categoryName: 'Abrasives',
    linkedDimensionCount: 0,
    options: [{ id: 'opt_80', code: '80', name: '80', position: 0, swatchHex: null }],
  },
  {
    id: 'def_material',
    name: 'Material',
    position: 3,
    // Unbound: D125a says an unbound definition applies everywhere.
    categoryId: null,
    categoryName: null,
    linkedDimensionCount: 0,
    options: [{ id: 'opt_cotton', code: 'COT', name: 'Cotton', position: 0, swatchHex: null }],
  },
];

function beautyState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    ...initialState(),
    categoryId: BEAUTY,
    hasVariations: true,
    variations: [{ key: 'dim1', name: '', options: [] }],
    ...overrides,
  };
}

function useHarness(initial: WizardState) {
  const [state, setState] = React.useState<WizardState>(initial);
  const patch = React.useCallback((p: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);
  return { state, patch };
}

function Harness({
  initial,
  library = LIBRARY,
}: {
  initial?: WizardState;
  library?: AttributeDefinition[];
}) {
  const h = useHarness(initial ?? beautyState());
  return (
    <StepVariations
      state={h.state}
      errors={{}}
      attributeLibrary={library}
      onChange={h.patch}
    />
  );
}

describe('which attributes a category offers', () => {
  it('offers the ones bound to it', () => {
    const names = attributesForCategory(LIBRARY, BEAUTY).map((a) => a.name);

    expect(names).toContain('Size');
    expect(names).toContain('Color');
  });

  it('does NOT offer another category’s', () => {
    // The half that matters. Without it, a filter that returned everything
    // would pass the assertion above.
    const names = attributesForCategory(LIBRARY, BEAUTY).map((a) => a.name);

    expect(names).not.toContain('Grit');
  });

  it('offers unbound attributes everywhere (D125a)', () => {
    // `categoryId` is a binding HINT, and the schema is explicit that an
    // unbound scale applies to every category. Filtering on equality alone
    // would hide exactly the shared scales the library exists to share.
    expect(attributesForCategory(LIBRARY, BEAUTY).map((a) => a.name)).toContain('Material');
    expect(attributesForCategory(LIBRARY, HARDWARE).map((a) => a.name)).toContain('Material');
  });

  it('offers only the unbound ones for a product with no category', () => {
    const names = attributesForCategory(LIBRARY, '').map((a) => a.name);

    expect(names).toEqual(['Material']);
  });
});

describe('the variation step reads the library', () => {
  it('offers the category’s attributes as a choice', () => {
    render(<Harness />);

    const select = screen.getByLabelText(/^variation$/i) as HTMLSelectElement;
    const offered = [...select.options].map((o) => o.textContent);

    expect(offered).toContain('Size');
    expect(offered).toContain('Color');
    expect(offered).not.toContain('Grit');
  });

  it('shows an attribute’s own options once it is chosen', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText(/^variation$/i), { target: { value: 'def_size' } });

    expect(screen.getByLabelText(/size options/i)).toBeDefined();
    expect(screen.getByText('Small')).toBeDefined();
    expect(screen.getByText('Large')).toBeDefined();
    // And not the other attribute's.
    expect(screen.queryByText('Red')).toBeNull();
  });

  it('says so when an attribute has no options, and names where to fix it', () => {
    // The dead end, made legible. Ticking nothing and being refused by a
    // validator that cannot explain why is the alternative.
    const empty: AttributeDefinition[] = [
      { ...LIBRARY[0]!, id: 'def_empty', name: 'Finish', options: [] },
    ];
    render(<Harness library={empty} />);

    fireEvent.change(screen.getByLabelText(/^variation$/i), { target: { value: 'def_empty' } });

    expect(screen.getByText(/has no options yet/i)).toBeDefined();
    expect(screen.getByText(/Attributes/)).toBeDefined();
  });

  it('falls back to free text when the library is empty', () => {
    /*
     * Every hardware and restaurant workspace is this case. A dropdown that
     * replaced the inputs unconditionally would leave them unable to declare a
     * variation at all -- the regression this asserts against.
     */
    render(<Harness library={[]} />);

    const field = screen.getByLabelText(/^variation$/i);
    expect(field.tagName).toBe('INPUT');
    expect(screen.getByText(/add option/i)).toBeDefined();
  });
});

describe('what the wizard sends', () => {
  it('omits the link when nothing was picked from the library', () => {
    /*
     * The API draws a deliberate distinction: `null` clears a stored mapping,
     * an omitted key leaves it alone. A wizard that sent `null` here would
     * unmap every product saved through a screen that had not picked from the
     * library -- which is every save before this change.
     */
    const state = beautyState({
      variations: [{ key: 'd', name: 'Size', options: [{ key: 'o', name: 'Small' }] }],
    });

    const body = buildVariationsPayload(state);

    expect('attributeDefinitionId' in body.dimensions[0]!).toBe(false);
    expect('attributeOptionId' in body.dimensions[0]!.options[0]!).toBe(false);
  });

  it('sends the links once an attribute and its options are chosen', () => {
    const state = beautyState({
      variations: [
        {
          key: 'd',
          name: 'Size',
          attributeDefinitionId: 'def_size',
          options: [{ key: 'o', name: 'Small', attributeOptionId: 'opt_small' }],
        },
      ],
    });

    const body = buildVariationsPayload(state);

    expect(body.dimensions[0]).toMatchObject({
      name: 'Size',
      attributeDefinitionId: 'def_size',
    });
    expect(body.dimensions[0]!.options[0]).toMatchObject({
      name: 'Small',
      attributeOptionId: 'opt_small',
    });
  });

  it('sends null when a mapping was deliberately cleared', () => {
    // The third state. `null` is how the category-change reconciliation tells
    // the server to forget a mapping that no longer applies.
    const state = beautyState({
      variations: [
        {
          key: 'd',
          name: 'Size',
          attributeDefinitionId: null,
          options: [{ key: 'o', name: 'Small' }],
        },
      ],
    });

    expect(buildVariationsPayload(state).dimensions[0]).toMatchObject({
      attributeDefinitionId: null,
    });
  });
});

describe('an existing product is not disturbed', () => {
  const managed = {
    id: 'p1',
    name: 'Cream',
    type: 'Inventory',
    sku: null,
    description: null,
    categoryId: BEAUTY,
    subcategoryId: null,
    unitPrice: 0,
    incomeAccount: null,
    purchaseDescription: null,
    costPrice: null,
    expenseAccount: null,
    quantityOnHand: 0,
    quantityAsOfDate: null,
    reorderLevel: null,
    inventoryAssetAccount: null,
    imageUrl: null,
    isActive: true,
    taxable: true,
    quantityType: 'WHOLE' as const,
    unitOfMeasure: null,
    quickbooksItemId: null,
    syncStatus: 'NOT_SYNCED' as const,
    lastSyncedAt: null,
    hasVariants: true,
    averageCost: null,
  };

  const mappedDimension: ProductVariationDimension = {
    id: 'dim_size',
    name: 'Size',
    position: 0,
    attributeDefinitionId: 'def_size',
    options: [
      { id: 'po_small', name: 'Small', position: 0, attributeOptionId: 'opt_small' },
      // A legacy option typed by hand before the library existed.
      { id: 'po_huge', name: 'Huge', position: 1, attributeOptionId: null },
    ],
  };

  it('round-trips a mapping through edit without changing it', () => {
    /*
     * Re-saving an untouched product must be a no-op on its mapping. Hydration
     * echoes exactly what the server holds, so the payload carries the same
     * ids straight back out.
     */
    const state = hydrateFromProduct(managed as never, [], [mappedDimension]);

    expect(state.variations[0]!.attributeDefinitionId).toBe('def_size');

    const body = buildVariationsPayload(state);
    expect(body.dimensions[0]).toMatchObject({ attributeDefinitionId: 'def_size' });
  });

  it('keeps an option that was never mapped, and keeps it unmapped', () => {
    // "Huge" belongs to no library scale. It is the operator's own data and
    // must survive an edit exactly as it is -- deleted options and hand-typed
    // ones are the same case from the product's point of view.
    const state = hydrateFromProduct(managed as never, [], [mappedDimension]);

    const huge = state.variations[0]!.options.find((o) => o.name === 'Huge');
    expect(huge).toBeDefined();
    expect(huge!.attributeOptionId).toBeNull();

    expect(buildVariationsPayload(state).dimensions[0]!.options).toEqual([
      { name: 'Small', position: 0, attributeOptionId: 'opt_small' },
      { name: 'Huge', position: 1, attributeOptionId: null },
    ]);
  });
});
