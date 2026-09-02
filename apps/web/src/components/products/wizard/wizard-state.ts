/**
 * Add Product wizard — the single state shape shared across all four steps
 * (D44). Kept as a plain type + pure helpers so the wizard can be re-hydrated
 * from the server for the Edit route without owning React state.
 *
 * Every field maps 1-to-1 to what the backend persists (see D44). Names carry
 * server ids where relevant so the wizard can PATCH without inventing routes;
 * `variations` and `variants` hold client-only `key`s that survive rename
 * (React key stability) and only turn into real ids after the batch POST.
 */

import { validateAttributes, type AttributeField } from '@hardware-pos/shared';

import type { ProductBusinessKind } from '@/lib/products/product-presentation';
import type { ManagedProduct, ProductItemType } from '@/lib/products-api';
import type {
  ProductVariant,
  ProductVariationDimension,
} from '@/lib/products/variants-api';

/** Restaurant Category (Food / Beverage / Dessert). Empty when not chosen yet. */
export type RestaurantFoodType = '' | 'FOOD' | 'BEVERAGE' | 'DESSERT';

export type StepKey = 'details' | 'attributes' | 'variations' | 'pricing' | 'review';

/**
 * The FULL step order. The `attributes` step (D64) only renders for tenants
 * whose domain declares a non-empty attribute schema — the wizard shell
 * filters it out otherwise (`visibleSteps`), but validation iterates this
 * list unconditionally, which is safe: an empty schema validates `{}` to no
 * errors.
 */
export const STEP_ORDER: StepKey[] = ['details', 'attributes', 'variations', 'pricing', 'review'];

/** The steps the stepper shows this tenant (D64 — see STEP_ORDER). */
export function visibleSteps(attributeSchema: readonly AttributeField[]): StepKey[] {
  return attributeSchema.length > 0
    ? STEP_ORDER
    : STEP_ORDER.filter((s) => s !== 'attributes');
}

/**
 * A variation dimension in draft form.
 *
 * `key` is a locally-minted id so an in-progress rename doesn't remount the
 * whole option list (React key churn); it becomes irrelevant once the wizard
 * PUTs the dimensions and receives real server ids back.
 */
export interface VariationDraft {
  key: string;
  name: string;
  options: Array<{ key: string; name: string }>;
}

/**
 * One row of the sellable-variants table.
 *
 * `optionKeys` is index-aligned to `WizardState.variations`, so entry `i` is
 * the option chosen for dimension `i`. That layout keeps enumeration and
 * remap logic straightforward — no lookup tables required.
 */
export interface VariantDraft {
  key: string;
  enabled: boolean;
  sku: string;
  barcode: string;
  unitPrice: string;
  costPrice: string;
  openingQuantity: string;
  reorderLevel: string;
  imageUrl: string | null;
  isActive: boolean;
  optionKeys: string[];
  /**
   * Server id — present only in edit mode after hydration. Used by the wizard
   * to route field edits through PATCH `/variants/:id` instead of the batch
   * create endpoint. Absent on newly-added rows.
   */
  serverId?: string;
}

export interface WizardState {
  // Step 1 — Product details
  name: string;
  type: ProductItemType;
  categoryId: string;
  subcategoryId: string;
  brand: string;
  description: string;
  trackInventory: boolean;
  /**
   * D101 (3.13) — whether the product attracts tax. Defaults true, because that
   * is already true of every product: there is no per-product exemption in any
   * tenant's history.
   */
  taxable: boolean;
  imageUrl: string;

  // Step 2 — Variations
  hasVariations: boolean;
  variations: VariationDraft[];

  // Step 3 — Variants (only used when hasVariations)
  variants: VariantDraft[];
  /** Branch where opening stock lands. Required only when at least one enabled variant has openingQuantity > 0. */
  openingBranchId: string;

  // Step 3 — Simple mode (only used when !hasVariations)
  simple: {
    sku: string;
    barcode: string;
    unitPrice: string;
    costPrice: string;
    openingQuantity: string;
    reorderLevel: string;
  };

  // ── Restaurant-only fields (D45). Populated by every wizard state but only
  //    surfaced when `businessKind === 'RESTAURANT'` — carrying them
  //    unconditionally keeps the type unbranched and means a tenant that
  //    flips business type mid-session doesn't lose its already-entered data.

  /** Food / Beverage / Dessert. Required at Step 1 for Restaurant tenants. */
  foodType: RestaurantFoodType;
  /** Prep time in minutes, kept as string to match the wizard's input pattern. */
  prepMinutes: string;
  /** Dietary chip picks — e.g. Veg / Non-Veg / Spicy. */
  dietaryTags: string[];
  /** ModifierGroup ids linked to this product (Step 3, card A). */
  modifierGroupIds: string[];
  /** KitchenStation ids the product routes to (Step 3, card C). */
  kitchenStationIds: string[];
  /**
   * Promotion ids the operator picked/linked in Step 3, card B.
   *
   * These are NOT persisted from Step 4 as a promotions-array on the product
   * itself — the wizard patches each promotion after the product exists to add
   * a `PromotionItem` pointing at the new product id. See `product-wizard.tsx`
   * for the exact orchestration.
   */
  promotionIds: string[];

  /**
   * D64 — domain attribute inputs, RAW: every value is the input's string
   * ('' = not entered; booleans are 'true'/'false'). Conversion to the typed
   * document happens once, in `buildAttributesDocument`, against the schema —
   * keeping the state shape uniform with every other wizard field.
   */
  attributes: Record<string, string>;

  /**
   * D65 — the recipe (Step 3, card D; only when the tenant's capabilities
   * declare `catalogue.components`). Raw input strings like every other
   * wizard field; `wastagePercent` is the operator-facing percentage — the
   * PUT converts to the API's 0–1 rate.
   */
  components: ComponentDraft[];
}

/** D65 — one recipe row. Name/SKU cached from the picker for display. */
export interface ComponentDraft {
  componentProductId: string;
  componentName: string;
  componentSku: string | null;
  quantity: string;
  wastagePercent: string;
}

/**
 * A stable, cheap client id. `crypto.randomUUID` is available in every
 * browser Next 15 targets; the fallback preserves behaviour in older test
 * environments where jsdom hasn't polyfilled it.
 */
export function makeKey(prefix: string): string {
  const rand =
    typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

export function initialState(): WizardState {
  return {
    name: '',
    type: 'Inventory',
    categoryId: '',
    subcategoryId: '',
    brand: '',
    description: '',
    trackInventory: true,
    taxable: true,
    imageUrl: '',
    hasVariations: false,
    variations: [],
    variants: [],
    openingBranchId: '',
    simple: {
      sku: '',
      barcode: '',
      unitPrice: '',
      costPrice: '',
      openingQuantity: '',
      reorderLevel: '',
    },
    foodType: '',
    prepMinutes: '',
    dietaryTags: [],
    modifierGroupIds: [],
    kitchenStationIds: [],
    promotionIds: [],
    attributes: {},
    components: [],
  };
}

/**
 * Hydrate the wizard from server responses for the Edit route.
 *
 * Variant rows are keyed by their server id so a PATCH knows which row it is
 * targeting; option choices are mapped through the dimension list so a stale
 * option id from a deleted variation shows up as an empty select rather than
 * silently landing on a different option.
 */
/**
 * Restaurant-only hydration inputs, all optional.
 *
 * The wizard shell fetches these AFTER the main product/variants payload lands
 * (three separate endpoints — modifier groups, stations, promotions) and passes
 * whichever it managed to load. Missing arrays fall back to `[]` so a hydration
 * failure does not surface as "already selected everything" or an undefined
 * `.map`.
 */
export interface RestaurantHydration {
  foodType?: RestaurantFoodType;
  prepMinutes?: number | null;
  dietaryTags?: string[];
  modifierGroupIds?: string[];
  kitchenStationIds?: string[];
  promotionIds?: string[];
  /** D65 — existing recipe rows, pre-converted to drafts by the shell. */
  components?: ComponentDraft[];
}

export function hydrateFromProduct(
  product: ManagedProduct,
  variants: ProductVariant[],
  dimensions: ProductVariationDimension[],
  restaurant: RestaurantHydration = {},
): WizardState {
  const hasVariations = variants.length > 0 || dimensions.length > 0;

  const variationDrafts: VariationDraft[] = dimensions.map((d) => ({
    // Reuse the server id as the local key on hydration — it is unique and
    // means the wizard can PUT with the same identifier if the operator adds
    // an option without renaming the dimension.
    key: d.id,
    name: d.name,
    options: d.options.map((o) => ({ key: o.id, name: o.name })),
  }));

  const variantDrafts: VariantDraft[] = variants.map((v) => ({
    key: v.id,
    serverId: v.id,
    enabled: v.isActive,
    sku: v.sku,
    barcode: v.barcode ?? '',
    unitPrice: String(v.unitPrice),
    costPrice: v.costPrice != null ? String(v.costPrice) : '',
    openingQuantity: '', // Edit mode never re-seeds opening stock; that's Receive Stock.
    reorderLevel: v.reorderLevel != null ? String(v.reorderLevel) : '',
    imageUrl: v.imageUrl,
    isActive: v.isActive,
    optionKeys: dimensions.map((d) => {
      const ov = v.optionValues.find((x) => x.dimensionId === d.id);
      return ov?.optionId ?? '';
    }),
  }));

  return {
    name: product.name,
    type: product.type,
    categoryId: product.categoryId ?? '',
    subcategoryId: product.subcategoryId ?? '',
    brand: '',
    description: product.description ?? '',
    trackInventory: product.type === 'Inventory',
    // Round-trips on edit. `?? true` guards a response from an API that predates
    // the field, which must not silently flip a product to exempt.
    taxable: product.taxable ?? true,
    imageUrl: product.imageUrl ?? '',
    hasVariations,
    variations: variationDrafts,
    variants: variantDrafts,
    openingBranchId: '',
    simple: {
      sku: product.sku ?? '',
      barcode: '',
      unitPrice: hasVariations ? '' : String(product.unitPrice),
      costPrice: !hasVariations && product.costPrice != null ? String(product.costPrice) : '',
      openingQuantity: '',
      reorderLevel:
        !hasVariations && product.reorderLevel != null ? String(product.reorderLevel) : '',
    },
    foodType: restaurant.foodType ?? '',
    prepMinutes:
      restaurant.prepMinutes != null ? String(restaurant.prepMinutes) : '',
    dietaryTags: restaurant.dietaryTags ?? [],
    modifierGroupIds: restaurant.modifierGroupIds ?? [],
    kitchenStationIds: restaurant.kitchenStationIds ?? [],
    promotionIds: restaurant.promotionIds ?? [],
    // D64 — back to raw input strings; booleans render as 'true'/'false'.
    attributes: Object.fromEntries(
      Object.entries(product.attributes ?? {}).map(([k, v]) => [k, String(v)]),
    ),
    components: restaurant.components ?? [],
  };
}

// ── Combinations ─────────────────────────────────────────────────────────────

export interface Combination {
  optionKeys: string[];
  label: string;
}

/**
 * Cartesian product of every variation dimension's options.
 *
 * Order matches `variations` so `Combination.optionKeys[i]` is the option for
 * dimension `i` — the same layout `VariantDraft.optionKeys` uses. The label
 * joins by " · " (a middle dot) so it survives a comma-carrying option name.
 */
export function enumerateCombinations(variations: VariationDraft[]): Combination[] {
  const usable = variations.filter(
    (d) => d.name.trim() && d.options.some((o) => o.name.trim()),
  );
  if (usable.length === 0) return [];

  let acc: Combination[] = [{ optionKeys: [], label: '' }];
  for (const dim of usable) {
    const named = dim.options.filter((o) => o.name.trim());
    const next: Combination[] = [];
    for (const combo of acc) {
      for (const opt of named) {
        next.push({
          optionKeys: [...combo.optionKeys, opt.key],
          label: combo.label ? `${combo.label} · ${opt.name}` : opt.name,
        });
      }
    }
    acc = next;
  }
  return acc;
}

/**
 * Compose a variant's display label from its option ids. Used in the pricing
 * table, review card, and the right-rail preview.
 */
export function variantLabel(
  variant: VariantDraft,
  variations: VariationDraft[],
): string {
  const parts: string[] = [];
  for (let i = 0; i < variations.length; i += 1) {
    const dim = variations[i]!;
    const optKey = variant.optionKeys[i];
    if (!optKey) continue;
    const opt = dim.options.find((o) => o.key === optKey);
    if (opt?.name.trim()) parts.push(opt.name);
  }
  return parts.join(' · ');
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ValidateContext {
  /** From the platform profile; determines whether opening-stock UI is present. */
  inventoryMode: 'LOCAL' | 'QUICKBOOKS' | 'DISABLED' | 'EXTERNAL' | null;
  /**
   * Restaurant vs. Retail. When 'RESTAURANT', Step 1's Food/Beverage/Dessert
   * `foodType` is required. Null while the profile is unresolved — same fail-
   * safe as `inventoryMode: null`.
   */
  businessKind?: ProductBusinessKind | null;
  /**
   * D64 — the tenant domain's attribute schema. `[]` (or absent) skips the
   * attributes step entirely; the server validates against the same list, so
   * client validation here is usability, not authority.
   */
  attributeSchema?: readonly AttributeField[];
}

export const MAX_COMBINATIONS = 500;
/** Combinations above this threshold require operator confirmation before use. */
export const COMBINATION_CONFIRM_THRESHOLD = 100;

export function validateStep(
  step: StepKey,
  state: WizardState,
  ctx: ValidateContext,
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (step === 'details') {
    if (!state.name.trim()) errors.name = 'Give the product a name.';
    if (!state.type) errors.type = 'Choose an item type.';
    if (state.description.length > 800) {
      errors.description = 'Description is limited to 800 characters.';
    }
    // Restaurant only: Food / Beverage / Dessert is a required categorisation.
    // The retail wizard has no equivalent — Item Type covers it there.
    if (ctx.businessKind === 'RESTAURANT' && !state.foodType) {
      errors.foodType = 'Category is required';
    }
    if (state.prepMinutes) {
      const n = Number(state.prepMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 360) {
        errors.prepMinutes = 'Preparation time is 0-360 minutes.';
      }
    }
  }

  if (step === 'attributes') {
    // D64 — run the SAME validator the server refuses with, over the typed
    // document the payload builder will send. Errors keyed `attr-<key>` so
    // the step highlights the exact field.
    const schema = ctx.attributeSchema ?? [];
    for (const issue of validateAttributes(schema, buildAttributesDocument(state, schema))) {
      errors[issue.key ? `attr-${issue.key}` : 'attributes'] = issue.message;
    }
  }

  if (step === 'variations') {
    if (state.hasVariations) {
      // Each declared dimension needs a name and at least one named option, so
      // the eventual PUT lands with the same shape the DTO accepts.
      state.variations.forEach((d, di) => {
        if (!d.name.trim()) {
          errors[`variation-name-${di}`] = 'Name this variation.';
        }
        const namedOptions = d.options.filter((o) => o.name.trim());
        if (namedOptions.length === 0) {
          errors[`variation-options-${di}`] = 'Add at least one option.';
        }
        d.options.forEach((o, oi) => {
          if (!o.name.trim()) {
            errors[`variation-option-${di}-${oi}`] = 'Option needs a name.';
          }
        });
        // Duplicate options within a dimension would collide on the unique
        // (dimensionId, name) constraint the server enforces.
        const seen = new Set<string>();
        for (const o of namedOptions) {
          const key = o.name.trim().toLowerCase();
          if (seen.has(key)) {
            errors[`variation-dup-${di}`] = 'Options within a variation must be unique.';
            break;
          }
          seen.add(key);
        }
      });

      const combinations = enumerateCombinations(state.variations).length;
      if (combinations === 0) {
        errors['variations-empty'] = 'Add at least one option so a variant exists.';
      } else if (combinations > MAX_COMBINATIONS) {
        errors['variations-too-many'] = `That is ${combinations} combinations. Split into separate products or trim options — the maximum is ${MAX_COMBINATIONS}.`;
      }
    }
  }

  if (step === 'pricing') {
    if (state.hasVariations) {
      const enabled = state.variants.filter((v) => v.enabled);
      if (enabled.length === 0) {
        errors['pricing-none-enabled'] = 'Enable at least one variant to sell.';
      }
      const skus = new Set<string>();
      enabled.forEach((v, vi) => {
        if (!v.sku.trim()) errors[`variant-sku-${vi}`] = 'SKU is required.';
        else {
          const key = v.sku.trim().toLowerCase();
          if (skus.has(key)) errors[`variant-sku-${vi}`] = 'SKUs must be unique.';
          skus.add(key);
        }
        const price = Number(v.unitPrice);
        if (v.unitPrice === '' || !Number.isFinite(price) || price < 0) {
          errors[`variant-price-${vi}`] = 'Enter a selling price.';
        }
      });

      // Opening branch is only meaningful under LOCAL inventory AND when the
      // operator actually asked for opening stock. Every other case is a
      // future Receive Stock — not this wizard's concern.
      if (ctx.inventoryMode === 'LOCAL') {
        const needsBranch = enabled.some((v) => Number(v.openingQuantity) > 0);
        if (needsBranch && !state.openingBranchId) {
          errors['openingBranchId'] = 'Pick where the opening stock lands.';
        }
      }
    } else {
      if (!state.simple.sku.trim()) errors['simple-sku'] = 'SKU is required.';
      const price = Number(state.simple.unitPrice);
      if (state.simple.unitPrice === '' || !Number.isFinite(price) || price < 0) {
        errors['simple-price'] = 'Enter a selling price.';
      }
    }

    // D65 — recipe rows (card D). Every listed component needs a usable
    // quantity; wastage is a percentage and cannot reach 100.
    state.components.forEach((c, ci) => {
      const q = Number(c.quantity);
      if (c.quantity.trim() === '' || !Number.isFinite(q) || q <= 0) {
        errors[`component-qty-${ci}`] = `Enter a quantity for ${c.componentName}.`;
      }
      if (c.wastagePercent.trim() !== '') {
        const w = Number(c.wastagePercent);
        if (!Number.isFinite(w) || w < 0 || w >= 100) {
          errors[`component-wastage-${ci}`] = 'Wastage is 0–99.99%.';
        }
      }
    });
  }

  return errors;
}

/** D65 — drafts → the PUT body (percent → 0–1 rate). Validated above. */
export function buildComponentsPayload(state: WizardState) {
  return state.components.map((c) => ({
    componentProductId: c.componentProductId,
    quantity: Number(c.quantity),
    ...(c.wastagePercent.trim() !== '' && Number(c.wastagePercent) > 0
      ? { wastageRate: Number(c.wastagePercent) / 100 }
      : {}),
  }));
}

// ── Payload builders ─────────────────────────────────────────────────────────

/**
 * D64 — the typed attributes document from the raw input strings, per the
 * schema. An empty input means "not entered" and produces NO key (the server
 * treats absence as cleared under replace semantics); a non-empty input is
 * converted to the field's type. Uncoercible numbers pass through as the raw
 * string so the validator rejects them with the field's own message instead
 * of a silent NaN.
 */
export function buildAttributesDocument(
  state: WizardState,
  schema: readonly AttributeField[],
): Record<string, string | number | boolean> {
  const doc: Record<string, string | number | boolean> = {};
  for (const field of schema) {
    const raw = (state.attributes[field.key] ?? '').trim();
    if (raw === '') continue;
    switch (field.type) {
      case 'integer':
      case 'number': {
        const n = Number(raw);
        doc[field.key] = Number.isFinite(n) ? n : raw;
        break;
      }
      case 'boolean':
        doc[field.key] = raw === 'true';
        break;
      default:
        doc[field.key] = raw;
    }
  }
  return doc;
}

export interface ProductCreatePayload {
  name: string;
  type: ProductItemType;
  sku: string | null;
  description: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  unitPrice: number;
  costPrice: number | null;
  reorderLevel: number | null;
  isActive: boolean;
  /** D101 (3.13) — always sent, so the value the operator saw is what is stored. */
  taxable: boolean;
  imageUrl?: string | null;
  /**
   * D45 — Restaurant fields. Emitted for every tenant; Retail tenants send
   * empty defaults which are indistinguishable from "not set" in the DB.
   * Only Restaurant tenants surface UI for these — this keeps the create
   * payload shape single-branch instead of forking on businessKind.
   */
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT' | null;
  prepMinutes?: number | null;
  dietaryTags?: string[];
  /**
   * D64 — domain attributes (replace semantics). Present only when the
   * tenant's schema declares fields; a tenant with none never sends the key,
   * so the payload cannot trip the server's unknown-key refusal.
   */
  attributes?: Record<string, string | number | boolean>;
}

/** Build the `POST /products` body — Step 3 already validated the numbers. */
export function buildCreateInput(
  state: WizardState,
  imageUrl: string | null,
  attributeSchema: readonly AttributeField[] = [],
): ProductCreatePayload {
  const simple = state.simple;
  const useSimpleForRoot = !state.hasVariations;
  return {
    name: state.name.trim(),
    type: state.type,
    // Product-level SKU only makes sense in simple mode; variants carry their
    // own SKUs, so we leave the parent SKU null when hasVariations to avoid
    // "which one is the truth" ambiguity for a cashier searching by SKU.
    sku: useSimpleForRoot ? simple.sku.trim() || null : null,
    description: state.description.trim() || null,
    categoryId: state.categoryId || null,
    subcategoryId: state.subcategoryId || null,
    // With variations the parent price is a placeholder — the server records 0
    // and every sale goes through a variant.
    unitPrice: useSimpleForRoot ? Number(simple.unitPrice) || 0 : 0,
    costPrice: useSimpleForRoot && simple.costPrice ? Number(simple.costPrice) : null,
    reorderLevel:
      useSimpleForRoot && simple.reorderLevel ? Number(simple.reorderLevel) : null,
    isActive: true,
    // Always sent, so the value the operator saw is the value stored. The server
    // also defaults it (`dto.taxable ?? true`) for clients that omit it.
    taxable: state.taxable,
    imageUrl: imageUrl || null,
    // D45 — Restaurant fields. `foodType` sent as null when empty so a
    // Retail create (which never surfaces the picker) explicitly clears
    // any bad prior value on re-save.
    foodType: state.foodType || null,
    prepMinutes: state.prepMinutes ? Number(state.prepMinutes) || null : null,
    dietaryTags: state.dietaryTags,
    // D64 — the whole document, every save (replace semantics), but only for
    // tenants whose domain declares fields at all.
    ...(attributeSchema.length > 0
      ? { attributes: buildAttributesDocument(state, attributeSchema) }
      : {}),
  };
}

/** Build the `PUT /products/:id/variations` body. */
export function buildVariationsPayload(state: WizardState) {
  return {
    dimensions: state.variations
      .filter((d) => d.name.trim())
      .map((d, di) => ({
        name: d.name.trim(),
        position: di,
        options: d.options
          .filter((o) => o.name.trim())
          .map((o, oi) => ({ name: o.name.trim(), position: oi })),
      })),
  };
}

/**
 * Build the `POST /products/:id/variants:batch` body.
 *
 * After the variations PUT the server hands back real ids per dimension /
 * option; the caller passes those in via `dimensionIdByKey` / `optionIdByKey`
 * so this pure helper can turn the wizard's client-side keys into the ids the
 * batch endpoint expects.
 */
export function buildVariantsBatchInput(
  state: WizardState,
  dimensionIdByKey: Map<string, string>,
  optionIdByKey: Map<string, string>,
) {
  const enabled = state.variants.filter((v) => v.enabled);
  return {
    openingBranchId: state.openingBranchId || undefined,
    variants: enabled.map((v, vi) => {
      const optionValues: Array<{ dimensionId: string; optionId: string }> = [];
      for (let i = 0; i < state.variations.length; i += 1) {
        const dimKey = state.variations[i]!.key;
        const optKey = v.optionKeys[i];
        const dimensionId = dimensionIdByKey.get(dimKey);
        const optionId = optKey ? optionIdByKey.get(optKey) : undefined;
        if (dimensionId && optionId) optionValues.push({ dimensionId, optionId });
      }
      return {
        sku: v.sku.trim(),
        ...(v.barcode.trim() ? { barcode: v.barcode.trim() } : {}),
        unitPrice: Number(v.unitPrice) || 0,
        ...(v.costPrice ? { costPrice: Number(v.costPrice) } : {}),
        ...(v.reorderLevel ? { reorderLevel: Number(v.reorderLevel) } : {}),
        ...(Number(v.openingQuantity) > 0
          ? { openingQuantity: Number(v.openingQuantity) }
          : {}),
        ...(v.imageUrl ? { imageUrl: v.imageUrl } : {}),
        isActive: v.isActive,
        position: vi,
        optionValues,
      };
    }),
  };
}

/**
 * Extract the price band the preview panel shows once Step 3 has been filled.
 * Returns `null` when nothing is priced yet so the caller can render a hint.
 */
export function priceBand(state: WizardState): { min: number; max: number } | null {
  if (!state.hasVariations) {
    const n = Number(state.simple.unitPrice);
    return Number.isFinite(n) && state.simple.unitPrice !== '' ? { min: n, max: n } : null;
  }
  const prices = state.variants
    .filter((v) => v.enabled)
    .map((v) => Number(v.unitPrice))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (prices.length === 0) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
