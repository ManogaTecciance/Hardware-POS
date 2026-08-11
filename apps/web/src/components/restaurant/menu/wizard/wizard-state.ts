/**
 * Restaurant Menu Wizard — the single state shape shared across all four
 * steps. Kept as a plain type + reducer so the wizard can be re-hydrated
 * from a saved MenuItem for the Edit route.
 *
 * Every field maps 1-to-1 to what the backend persists (see D41). Values
 * outside the domain are not held here — the wizard never invents data.
 */
import type { MenuItemType, MenuItemView, ModifierGroupView } from '@/lib/restaurant/types';

export interface VariationRow {
  /** Local-only id so the operator can reorder / delete during authoring. */
  key: string;
  name: string;
  /** Adjustment from basePrice (D41 approved delta representation). */
  priceDelta: number;
}

export interface ModifierOptionDraft {
  key: string;
  name: string;
  priceDelta: number;
}

export interface ModifierGroupDraft {
  /** Local key for authoring; distinct from any persisted id. */
  key: string;
  /** Server id if the group already exists (Edit flow) — else undefined. */
  serverId?: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  options: ModifierOptionDraft[];
  /** Wizard marker only — never presented to the operator. */
  role: 'SIZE' | null;
}

export interface WizardState {
  // Step 1 — Menu details
  name: string;
  sectionId: string | null;
  itemType: MenuItemType | null;
  description: string;
  prepMinutes: string;
  stationId: string | null;
  dietaryTags: string[];
  imageUrl: string;

  // Step 2 — Pricing & variations
  basePrice: string;
  variations: VariationRow[];

  // Step 3 — Modifiers & availability
  modifierGroups: ModifierGroupDraft[];
  isActive: boolean;

  // Wizard chrome
  currentStep: 1 | 2 | 3 | 4;
  /** Server id if editing; undefined on create. */
  editingItemId?: string;
}

export const emptyWizardState = (initialSectionId: string | null = null): WizardState => ({
  name: '',
  sectionId: initialSectionId,
  itemType: null,
  description: '',
  prepMinutes: '',
  stationId: null,
  dietaryTags: [],
  imageUrl: '',
  basePrice: '',
  variations: [],
  modifierGroups: [],
  isActive: true,
  currentStep: 1,
});

/**
 * Hydrate the wizard from a saved MenuItem plus the tenant's modifier group
 * catalogue. Variations are the modifier group with `role='SIZE'` if one is
 * attached — everything else lands as a plain modifier group.
 */
export function hydrateWizardState(
  item: MenuItemView,
  modifierGroups: ModifierGroupView[],
): WizardState {
  const attached = modifierGroups.filter((g) => item.modifierGroupIds.includes(g.id));
  const sizeGroup = attached.find((g) => g.role === 'SIZE') ?? null;
  const plain = attached.filter((g) => g.role !== 'SIZE');

  return {
    name: item.name,
    sectionId: item.sectionId,
    itemType: item.itemType,
    description: item.description ?? '',
    prepMinutes: item.prepMinutes != null ? String(item.prepMinutes) : '',
    stationId: item.stationIds[0] ?? null,
    dietaryTags: [...item.dietaryTags],
    imageUrl: item.imageUrl ?? '',
    basePrice: item.basePrice,
    variations: sizeGroup
      ? sizeGroup.options.map((o, i) => ({
          key: `hyd-var-${i}`,
          name: o.name,
          priceDelta: Number(o.priceDelta),
        }))
      : [],
    modifierGroups: plain.map((g, gi) => ({
      key: `hyd-mg-${gi}`,
      serverId: g.id,
      name: g.name,
      selection: g.selection,
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      options: g.options.map((o, i) => ({
        key: `hyd-mo-${gi}-${i}`,
        name: o.name,
        priceDelta: Number(o.priceDelta),
      })),
      role: null,
    })),
    isActive: item.isActive,
    currentStep: 1,
    editingItemId: item.id,
  };
}

/**
 * Per-step validation. Each step is validated on Continue (not on every
 * keystroke) — see the "FORM VALIDATION MICRO-UX" clause in the brief. Return
 * a map of fieldKey → error message; empty map means the step passes.
 */
export function validateStep(step: 1 | 2 | 3 | 4, state: WizardState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 1) {
    if (!state.name.trim()) errors.name = 'Give the menu item a name.';
    if (!state.sectionId) errors.sectionId = 'Pick which section this item belongs to.';
    if (!state.itemType) errors.itemType = 'Choose Food, Beverage or Dessert.';
    if (state.prepMinutes) {
      const n = Number(state.prepMinutes);
      if (!Number.isInteger(n) || n < 1 || n > 360) {
        errors.prepMinutes = 'Prep time is 1–360 minutes.';
      }
    }
  }
  if (step === 2) {
    const price = Number(state.basePrice);
    if (state.basePrice === '' || !Number.isFinite(price) || price < 0) {
      errors.basePrice = 'Base price must be zero or more.';
    }
    // Variations are optional — but if any row exists, all rows need names
    // and non-negative deltas.
    state.variations.forEach((v, i) => {
      if (!v.name.trim()) errors[`variation-name-${i}`] = 'Every variation needs a label.';
      if (!Number.isFinite(v.priceDelta)) errors[`variation-delta-${i}`] = 'Enter a number.';
    });
  }
  if (step === 3) {
    // Every group needs a name and at least one named option.
    state.modifierGroups.forEach((g, gi) => {
      if (!g.name.trim()) errors[`mg-name-${gi}`] = 'Modifier group needs a name.';
      if (!g.options.length) errors[`mg-opts-${gi}`] = 'Add at least one option.';
      g.options.forEach((o, oi) => {
        if (!o.name.trim()) errors[`mo-name-${gi}-${oi}`] = 'Option needs a name.';
      });
      if (g.selection === 'SINGLE' && g.maxSelections !== 1) {
        errors[`mg-max-${gi}`] = 'Single-select groups allow one selection.';
      }
      if (g.minSelections > g.maxSelections) {
        errors[`mg-range-${gi}`] = 'Min cannot exceed max.';
      }
    });
  }
  return errors;
}

/** Compute price bounds for the preview panel. */
export function priceBounds(state: WizardState): { from: number; to: number } {
  const base = Number(state.basePrice) || 0;
  if (state.variations.length === 0) return { from: base, to: base };
  const deltas = state.variations.map((v) => Number(v.priceDelta) || 0);
  return {
    from: base + Math.min(...deltas),
    to: base + Math.max(...deltas),
  };
}
