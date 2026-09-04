'use client';

import { Boxes, Coffee, Cookie, Package, Utensils, Wrench } from 'lucide-react';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { type Session } from '@/lib/auth';
import { type CategoryNode } from '@/lib/products-api';
import type { ProductBusinessKind } from '@/lib/products/product-presentation';
import { MENU_DIETARY_TAGS } from '@/lib/restaurant/types';

import { ImageUpload } from './image-upload';
import type { RestaurantFoodType, WizardState } from './wizard-state';

/**
 * Add Product wizard — Step 1: Product details (D44 / D45 Restaurant).
 *
 * Retail tenants see: name → item type (Inventory/NonInventory/Service) →
 * category/subcategory → brand → track-inventory → description → image.
 *
 * Restaurant tenants (`businessKind === 'RESTAURANT'`, derived by the shell)
 * see a re-shaped Step 1: the Inventory/NonInventory/Service segmented
 * control is hidden (every menu item is Inventory in practice — the server
 * still receives `type: 'Inventory'`) and a **Category** segmented control
 * (Food/Beverage/Dessert) takes its place. Preparation time and dietary chip
 * toggles round out the domain-specific block. Every field maps 1-to-1 to a
 * persisted column (see D41 for the menu-side origin of Food/Beverage/Dessert,
 * prep time and dietary chips).
 *
 * The three-way item type control matches the menu wizard's Food/Beverage/
 * Dessert segmented pattern — same visual, same aria-radiogroup semantics.
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  categories: CategoryNode[];
  session: Session;
  /**
   * Derived by the wizard shell from the platform profile. `null` while
   * unresolved — the safe default is retail chrome (no Food/Beverage
   * segmentation appears) rather than briefly rendering restaurant fields for
   * a retail tenant on load. See `resolveBusinessKind` for the derivation.
   */
  businessKind: ProductBusinessKind | null;
  onChange: (patch: Partial<WizardState>) => void;
}

const ITEM_TYPES: {
  value: WizardState['type'];
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'Inventory',
    label: 'Inventory',
    hint: 'Tracked stock',
    icon: <Boxes className="h-4 w-4" aria-hidden="true" />,
  },
  {
    value: 'NonInventory',
    label: 'Non-inventory',
    hint: 'Sold, not tracked',
    icon: <Package className="h-4 w-4" aria-hidden="true" />,
  },
  {
    value: 'Service',
    label: 'Service',
    hint: 'Labour, delivery',
    icon: <Wrench className="h-4 w-4" aria-hidden="true" />,
  },
];

const RESTAURANT_CATEGORIES: {
  value: Exclude<RestaurantFoodType, ''>;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: 'FOOD', label: 'Food', icon: <Utensils className="h-4 w-4" aria-hidden="true" /> },
  { value: 'BEVERAGE', label: 'Beverage', icon: <Coffee className="h-4 w-4" aria-hidden="true" /> },
  { value: 'DESSERT', label: 'Dessert', icon: <Cookie className="h-4 w-4" aria-hidden="true" /> },
];

export function StepDetails({
  state,
  errors,
  categories,
  session,
  businessKind,
  onChange,
}: Props) {
  const activeCategories = categories.filter((c) => c.isActive);
  const currentCategory = activeCategories.find((c) => c.id === state.categoryId) ?? null;
  const subcategories = currentCategory?.subcategories.filter((s) => s.isActive) ?? [];
  const isRestaurant = businessKind === 'RESTAURANT';

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 1 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Product details</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Add the identifying information — name, type, and category.
        </p>
      </div>

      <Field label="Product name" htmlFor="product-name" required error={errors.name}>
        <Input
          id="product-name"
          value={state.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={isRestaurant ? 'e.g. Mix Kottu' : 'e.g. Milk 200ml'}
          maxLength={200}
          autoFocus
          aria-invalid={!!errors.name}
        />
      </Field>

      {isRestaurant ? (
        // Restaurant Category (Food / Beverage / Dessert). Required — the
        // brief calls out that menu items must be classified. The Item Type
        // (Inventory / NonInventory / Service) is intentionally suppressed for
        // Restaurant tenants — every menu item is Inventory in practice and
        // the segmented control adds noise without changing behaviour. The
        // shell still writes `type: 'Inventory'` server-side.
        <>
          <Field label="Category" required error={errors.foodType}>
            <div
              role="radiogroup"
              aria-label="Category"
              className="grid grid-cols-3 gap-2"
            >
              {RESTAURANT_CATEGORIES.map((t) => {
                const selected = state.foodType === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onChange({ foodType: t.value })}
                    className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-medium transition-colors motion-reduce:transition-none ${
                      selected
                        ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30'
                        : 'border-border bg-surface hover:border-primary hover:bg-brand-100'
                    }`}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                );
              })}
            </div>
          </Field>

          {/* D101 — what the item IS for stock. Off (a dish) gets the 86
              availability switch instead of counts; on (a packaged good —
              bottled water, cans) keeps quantity, low-stock and depletion.
              This one answer drives the server's STOCK_ITEM/COMPOSED_ITEM
              classification for food-typed rows. */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Track stock</span>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
              <Switch
                checked={state.trackInventory}
                onCheckedChange={(v) => onChange({ trackInventory: v })}
                aria-label="Track stock"
              />
              <div className="text-xs text-muted-foreground">
                {state.trackInventory
                  ? 'Counted stock — for bought-in items like bottled water. Each sale reduces the count.'
                  : 'No stock count — kitchen-prepared items. Use "Sold out" on the POS when the kitchen runs out.'}
              </div>
            </div>
          </div>
        </>
      ) : (
        <Field label="Item type" required error={errors.type}>
          <div role="radiogroup" aria-label="Item type" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {ITEM_TYPES.map((t) => {
              const selected = state.type === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    // Service items never have local stock — flip the tracking
                    // switch off preemptively so the operator doesn't have to
                    // discover the constraint on Step 3.
                    const trackInventory = t.value === 'Service' ? false : t.value === 'Inventory';
                    onChange({ type: t.value, trackInventory });
                  }}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors motion-reduce:transition-none ${
                    selected
                      ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30'
                      : 'border-border bg-surface hover:border-primary hover:bg-brand-100'
                  }`}
                >
                  <span className="inline-flex items-center gap-2 text-sm font-semibold">
                    {t.icon}
                    {t.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{t.hint}</span>
                </button>
              );
            })}
          </div>
        </Field>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Category" htmlFor="product-category">
          <Select
            id="product-category"
            value={state.categoryId}
            onChange={(e) => onChange({ categoryId: e.target.value, subcategoryId: '' })}
          >
            <option value="">Uncategorised</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Subcategory" htmlFor="product-subcategory">
          <Select
            id="product-subcategory"
            value={state.subcategoryId}
            onChange={(e) => onChange({ subcategoryId: e.target.value })}
            // A category with no subcategories should present as truly empty
            // — disabling avoids a select the operator can open onto nothing.
            disabled={!state.categoryId || subcategories.length === 0}
          >
            <option value="">
              {state.categoryId && subcategories.length === 0 ? 'No subcategories' : 'None'}
            </option>
            {subcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {isRestaurant ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Preparation time (minutes)"
            htmlFor="product-prep"
            error={errors.prepMinutes}
          >
            <div className="relative">
              <Input
                id="product-prep"
                type="number"
                inputMode="numeric"
                min={0}
                max={360}
                value={state.prepMinutes}
                onChange={(e) => onChange({ prepMinutes: e.target.value })}
                placeholder="15"
                className="pr-12"
                aria-invalid={!!errors.prepMinutes}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                min
              </span>
            </div>
          </Field>

          <Field label="Brand" htmlFor="product-brand">
            <Input
              id="product-brand"
              value={state.brand}
              onChange={(e) => onChange({ brand: e.target.value })}
              placeholder="Optional"
              maxLength={80}
            />
          </Field>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Brand" htmlFor="product-brand">
            <Input
              id="product-brand"
              value={state.brand}
              onChange={(e) => onChange({ brand: e.target.value })}
              placeholder="Optional"
              maxLength={80}
            />
          </Field>

          {/* Track inventory Switch — pinned off for Service items because the
              server refuses to record stock against them anyway. Suppressed
              for Restaurant since every menu item is Inventory and there is
              no Service/Non-inventory equivalent on the Restaurant wizard. */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Track inventory</span>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
              <Switch
                checked={state.trackInventory}
                onCheckedChange={(v) => onChange({ trackInventory: v })}
                disabled={state.type === 'Service'}
                aria-label="Track inventory"
              />
              <div className="text-xs text-muted-foreground">
                {state.type === 'Service'
                  ? 'Services are not stocked.'
                  : state.trackInventory
                    ? 'Stock levels are maintained per branch.'
                    : 'Sold without a stock ledger.'}
              </div>
            </div>
          </div>
        </div>
      )}

      {isRestaurant ? (
        <Field label="Dietary tags">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Dietary tags">
            {MENU_DIETARY_TAGS.map((tag) => {
              const active = state.dietaryTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() =>
                    onChange({
                      dietaryTags: active
                        ? state.dietaryTags.filter((t) => t !== tag)
                        : [...state.dietaryTags, tag],
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors motion-reduce:transition-none ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-surface text-muted-foreground hover:border-primary hover:text-foreground'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      <Field label="Description" htmlFor="product-description" error={errors.description}>
        <div className="relative">
          <Textarea
            id="product-description"
            value={state.description}
            onChange={(e) => onChange({ description: e.target.value.slice(0, 800) })}
            placeholder="Short sales description shown on tiles and receipts."
            className="min-h-[96px] pr-16"
            aria-invalid={!!errors.description}
          />
          <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-muted-foreground">
            {state.description.length} / 800
          </span>
        </div>
      </Field>

      <Field label="Product image">
        <ImageUpload
          session={session}
          value={state.imageUrl}
          onChange={(url) => onChange({ imageUrl: url })}
        />
      </Field>
    </div>
  );
}

// ── Field wrapper ────────────────────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  required,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-sm font-medium" htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-danger" aria-hidden="true">*</span> : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
