'use client';

import { Info, Wand2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { usePrompt } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { type Session } from '@/lib/auth';
import type { BranchSummary } from '@/lib/products/branches-api';
import type { ProductBusinessKind } from '@/lib/products/product-presentation';
import { useIsTabletUp } from '@/lib/use-viewport';

import { StepRestaurantAdditions } from './step-restaurant-additions';
import {
  MAX_SKU_LENGTH,
  sellingPriceLabel,
  variantLabel,
  type VariantDraft,
  type WizardState,
} from './wizard-state';

/**
 * Add Product wizard — Step 3: Pricing & inventory (D44).
 *
 * `showOpeningStock` decides whether the opening-stock column + branch select
 * are drawn — it's the wizard shell's job to derive that from the platform
 * profile (D31: no product component compares an `inventoryMode` itself).
 * When the flag is off the operator is redirected to Receive Stock via an
 * inline info banner.
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  branches: BranchSummary[];
  /** True when the tenant runs on locally-tracked inventory (LOCAL mode). */
  showOpeningStock: boolean;
  /**
   * D134e — offer “How is this sold?” at all. RETAIL only: the capability is
   * off for hardware and every food-service domain, and the shell resolves it
   * so this component never sees a business type (D31).
   *
   * Defaults FALSE, so a caller that has not been updated offers nothing —
   * the direction that cannot leak a control into a template that did not ask
   * for one.
   */
  showMeasuredGoods?: boolean;
  /**
   * Restaurant vs. Retail. Restaurant tenants get three extra cards
   * (Modifier Groups / Promotions / Availability & Kitchen) rendered below the
   * pricing matrix. Null while unresolved — same safe default as Step 1.
   */
  businessKind?: ProductBusinessKind | null;
  /**
   * Session required only for the Restaurant additions cards (they fetch the
   * modifier-groups, promotions and station catalogues). Retail tenants never
   * render those cards, so a missing session on retail is harmless.
   */
  session?: Session;
  /** Branch scope for kitchen-station catalogue fetches. */
  branchId?: string | null;
  /** D65 — `capabilities.catalogue.components`, resolved by the shell. */
  showRecipe?: boolean;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepPricingInventory({
  state,
  errors,
  branches,
  showOpeningStock,
  showMeasuredGoods,
  businessKind,
  session,
  branchId,
  showRecipe,
  onChange,
}: Props) {
  const isLocal = showOpeningStock;
  const isRestaurant = businessKind === 'RESTAURANT';

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 3 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">
          {isRestaurant ? 'Pricing, modifiers & availability' : 'Pricing & inventory'}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {state.hasVariations
            ? 'One row per sellable variant.'
            : isRestaurant
              ? 'Set the price, then attach modifiers, offers and kitchen routing.'
              : 'Set the selling price and, optionally, opening stock.'}
        </p>
      </div>

      {!isLocal ? (
        <InfoBanner>
          Opening stock is only supported for locally-managed inventory. Add stock via
          Receive Stock after saving.
        </InfoBanner>
      ) : null}

      {/*
        D134 (`6.1`) — above both pricing shapes on purpose. Measure is a
        property of the product, so it applies whether the price lives on
        the product or on its variants, and it has to be set BEFORE the
        price is read: "200" means nothing until you know it is per kilo.

        D134e — and only where the tenant sells by measure. `6.1b` rendered
        this unconditionally, which put a weighed-goods control in front of
        every restaurant and hardware workspace: this file is the shared
        Step 3 for every business type, and it already takes `businessKind`
        for exactly that reason.
      */}
      {showMeasuredGoods ? (
        <MeasureCard state={state} errors={errors} onChange={onChange} />
      ) : null}

      {state.hasVariations ? (
        <VariantMatrix
          state={state}
          errors={errors}
          isLocal={isLocal}
          branches={branches}
          onChange={onChange}
        />
      ) : (
        <SimpleForm state={state} errors={errors} isLocal={isLocal} onChange={onChange} />
      )}

      {isRestaurant && session ? (
        <StepRestaurantAdditions
          state={state}
          errors={errors}
          session={session}
          branchId={branchId ?? null}
          showRecipe={showRecipe ?? false}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

// ── Simple mode ──────────────────────────────────────────────────────────────

function SimpleForm({
  state,
  errors,
  isLocal,
  onChange,
}: {
  state: WizardState;
  errors: Record<string, string>;
  isLocal: boolean;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const set = (patch: Partial<WizardState['simple']>) =>
    onChange({ simple: { ...state.simple, ...patch } });

  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border bg-card p-4 md:grid-cols-2">
      <Field label="SKU" htmlFor="simple-sku" required error={errors['simple-sku']}>
        <Input
          id="simple-sku"
          value={state.simple.sku}
          onChange={(e) => set({ sku: e.target.value })}
          placeholder="Enter SKU (or leave blank to generate)"
          maxLength={80}
          aria-invalid={!!errors['simple-sku']}
        />
      </Field>

      <Field label="Barcode" htmlFor="simple-barcode">
        <Input
          id="simple-barcode"
          value={state.simple.barcode}
          onChange={(e) => set({ barcode: e.target.value })}
          placeholder="Optional"
          maxLength={80}
        />
      </Field>

      <Field
        label={sellingPriceLabel(state)}
        htmlFor="simple-price"
        required
        error={errors['simple-price']}
      >
        <MoneyInput
          id="simple-price"
          value={state.simple.unitPrice}
          onChange={(v) => set({ unitPrice: v })}
          invalid={!!errors['simple-price']}
        />
      </Field>

      <Field label="Cost price" htmlFor="simple-cost" error={errors['simple-cost']}>
        <MoneyInput
          id="simple-cost"
          value={state.simple.costPrice}
          onChange={(v) => set({ costPrice: v })}
          invalid={!!errors['simple-cost']}
        />
      </Field>

      {isLocal && state.trackInventory ? (
        <Field label="Opening quantity" htmlFor="simple-openq" error={errors['simple-openq']}>
          <Input
            id="simple-openq"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.001"
            value={state.simple.openingQuantity}
            onChange={(e) => set({ openingQuantity: e.target.value })}
            placeholder="0"
            aria-invalid={!!errors['simple-openq']}
          />
        </Field>
      ) : null}

      {/* D101 — a reorder point is a claim about a count; an untracked item
          has neither. Tracked items (retail Inventory, restaurant packaged
          goods) keep the field exactly as it was. */}
      {state.trackInventory ? (
        <Field label="Reorder point" htmlFor="simple-reorder" error={errors['simple-reorder']}>
          <Input
            id="simple-reorder"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.001"
            value={state.simple.reorderLevel}
            onChange={(e) => set({ reorderLevel: e.target.value })}
            placeholder="Optional"
            aria-invalid={!!errors['simple-reorder']}
          />
        </Field>
      ) : null}
    </div>
  );
}

// ── Variant matrix ───────────────────────────────────────────────────────────

function VariantMatrix({
  state,
  errors,
  isLocal,
  branches,
  onChange,
}: {
  state: WizardState;
  errors: Record<string, string>;
  isLocal: boolean;
  branches: BranchSummary[];
  onChange: (patch: Partial<WizardState>) => void;
}) {
  // On iPad landscape the 5–6-column matrix already needs an inner scroll;
  // on portrait it is unusable. `useIsTabletUp` picks between the table
  // (≥900) and a stacked card list (<900). SSR default is `true`, so
  // first paint on desktop is the correct table.
  const isTabletUp = useIsTabletUp();

  // D145 — the app's own prompt, so both bulk actions below are AWAITED. The
  // native one blocked the main thread, which on this screen froze the very
  // matrix the operator is about to see filled in.
  const prompt = usePrompt();

  const enabledIndexes = state.variants
    .map((v, i) => (v.enabled ? i : -1))
    .filter((i) => i !== -1);

  // Show the branch select only when opening stock is being seeded — otherwise
  // it is a required-looking control with nothing riding on it.
  const anyOpening = enabledIndexes.some(
    (i) => Number(state.variants[i]?.openingQuantity) > 0,
  );

  const updateVariant = (index: number, patch: Partial<VariantDraft>) => {
    onChange({
      variants: state.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    });
  };

  // ── Bulk actions ────────────────────────────────────────────────
  const generateSkus = async () => {
    // One field is still the least-invasive way to get a prefix without
    // building a bespoke dialog for this bulk action. Cashiers rarely need it
    // in edit mode; a follow-up can promote it to a Popover if usage warrants it.
    const raw = await prompt({
      title: 'Generate SKUs',
      message: 'Every enabled variant gets this prefix followed by its option initials.',
      label: 'SKU prefix',
      placeholder: 'MILK',
      // "Generate", not "Generate SKUs": the toolbar button already carries
      // that name, and two identical buttons on screen at once is a question
      // about which one you are pressing.
      confirmLabel: 'Generate',
    });
    // Unchanged guard: dismissal (null) and an empty box both leave the rows
    // alone, and a prefix of only spaces is emptied by the trim below.
    if (!raw) return;
    const prefix = raw.trim().toUpperCase();
    if (!prefix) return;
    onChange({
      variants: state.variants.map((v) => {
        if (!v.enabled) return v;
        const suffix = v.optionKeys
          .map((optKey, di) => {
            const dim = state.variations[di];
            const opt = dim?.options.find((o) => o.key === optKey);
            return (opt?.name ?? '').slice(0, 3).toUpperCase();
          })
          .filter(Boolean)
          .join('-');
        return { ...v, sku: `${prefix}-${suffix || 'V'}` };
      }),
    });
  };

  const setReorderForAll = async () => {
    const raw = await prompt({
      title: 'Reorder point for every enabled variant',
      message: 'Leave it blank to clear the reorder point on those rows.',
      label: 'Reorder point',
      placeholder: 'Optional',
      // A count, so the tablet gets a number pad rather than a keyboard.
      inputMode: 'numeric',
      confirmLabel: 'Apply to all',
    });
    // `== null` on purpose, as before: only dismissal aborts. An empty string
    // is a deliberate clear, and is written to every enabled row below.
    if (raw == null) return;
    const trimmed = raw.trim();
    if (trimmed !== '' && !Number.isFinite(Number(trimmed))) return;
    onChange({
      variants: state.variants.map((v) => (v.enabled ? { ...v, reorderLevel: trimmed } : v)),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          leftIcon={<Wand2 className="h-3.5 w-3.5" />}
          onClick={generateSkus}
          disabled={enabledIndexes.length === 0}
        >
          Generate SKUs
        </Button>
        {state.trackInventory ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={setReorderForAll}
            disabled={enabledIndexes.length === 0}
          >
            Set reorder for all
          </Button>
        ) : null}
      </div>

      {errors['pricing-none-enabled'] ? (
        <p className="text-xs text-danger" role="alert">
          {errors['pricing-none-enabled']}
        </p>
      ) : null}

      {enabledIndexes.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
          No variants are enabled — return to Step 2 to select variants.
        </div>
      ) : isTabletUp ? (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="min-w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border">
                <Th>Variant</Th>
                <Th>
                  SKU<span className="text-danger">*</span>
                </Th>
                <Th>Barcode</Th>
                <Th>
                  {sellingPriceLabel(state)}
                  <span className="text-danger">*</span>
                </Th>
                {/* D101 — stock columns only for tracked items; an untracked
                    dish's variants have no counts to seed or reorder. */}
                {isLocal && state.trackInventory ? <Th>Opening stock</Th> : null}
                {state.trackInventory ? <Th>Reorder</Th> : null}
              </tr>
            </thead>
            <tbody>
              {enabledIndexes.map((idx, rowNumber) => {
                const v = state.variants[idx]!;
                const label = variantLabel(v, state.variations) || 'Unnamed variant';
                const skuErr = errors[`variant-sku-${rowNumber}`];
                const barcodeErr = errors[`variant-barcode-${rowNumber}`];
                const priceErr = errors[`variant-price-${rowNumber}`];
                const openqErr = errors[`variant-openq-${rowNumber}`];
                const reorderErr = errors[`variant-reorder-${rowNumber}`];
                return (
                  <tr key={v.key} className="border-b border-border/60 last:border-none">
                    <td className="min-w-[10rem] whitespace-nowrap p-2 font-medium">{label}</td>
                    <td className="p-2">
                      <Input
                        value={v.sku}
                        onChange={(e) => updateVariant(idx, { sku: e.target.value })}
                        aria-label={`SKU for ${label}`}
                        aria-invalid={!!skuErr}
                        placeholder="SKU"
                        maxLength={MAX_SKU_LENGTH}
                        className="min-w-[9rem]"
                      />
                      <CellError message={skuErr} />
                    </td>
                    <td className="p-2">
                      <Input
                        value={v.barcode}
                        onChange={(e) => updateVariant(idx, { barcode: e.target.value })}
                        aria-label={`Barcode for ${label}`}
                        aria-invalid={!!barcodeErr}
                        placeholder="Optional"
                        maxLength={MAX_SKU_LENGTH}
                        className="min-w-[9rem]"
                      />
                      <CellError message={barcodeErr} />
                    </td>
                    <td className="p-2">
                      <MoneyInput
                        value={v.unitPrice}
                        onChange={(val) => updateVariant(idx, { unitPrice: val })}
                        ariaLabel={`Selling price for ${label}`}
                        invalid={!!priceErr}
                      />
                      <CellError message={priceErr} />
                    </td>
                    {isLocal && state.trackInventory ? (
                      <td className="p-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.001"
                          value={v.openingQuantity}
                          onChange={(e) =>
                            updateVariant(idx, { openingQuantity: e.target.value })
                          }
                          aria-label={`Opening stock for ${label}`}
                          aria-invalid={!!openqErr}
                          placeholder="0"
                          className="min-w-[6rem] touch-manipulation"
                        />
                        <CellError message={openqErr} />
                      </td>
                    ) : null}
                    {state.trackInventory ? (
                      <td className="p-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.001"
                          value={v.reorderLevel}
                          onChange={(e) => updateVariant(idx, { reorderLevel: e.target.value })}
                          aria-label={`Reorder point for ${label}`}
                          aria-invalid={!!reorderErr}
                          placeholder="Optional"
                          className="min-w-[6rem] touch-manipulation"
                        />
                        <CellError message={reorderErr} />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        // Portrait / narrow-tablet card list: one card per enabled variant.
        // Same aria-labels and field names as the table so validation errors
        // and screen-reader flow are unchanged; only the visual container
        // differs. The pricing-step spec queries `SKU for <label>` — that
        // still resolves against the input inside the card.
        <ul className="space-y-3" aria-label="Variant pricing">
          {enabledIndexes.map((idx, rowNumber) => {
            const v = state.variants[idx]!;
            const label = variantLabel(v, state.variations) || 'Unnamed variant';
            const skuErr = errors[`variant-sku-${rowNumber}`];
            const barcodeErr = errors[`variant-barcode-${rowNumber}`];
            const priceErr = errors[`variant-price-${rowNumber}`];
            const openqErr = errors[`variant-openq-${rowNumber}`];
            const reorderErr = errors[`variant-reorder-${rowNumber}`];
            return (
              <li
                key={v.key}
                className="space-y-3 rounded-2xl border border-border bg-card p-4"
              >
                <p className="text-sm font-semibold">{label}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      SKU<span className="text-danger">*</span>
                    </label>
                    <Input
                      value={v.sku}
                      onChange={(e) => updateVariant(idx, { sku: e.target.value })}
                      aria-label={`SKU for ${label}`}
                      aria-invalid={!!skuErr}
                      placeholder="SKU"
                      maxLength={MAX_SKU_LENGTH}
                    />
                    <CellError message={skuErr} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Barcode
                    </label>
                    <Input
                      value={v.barcode}
                      onChange={(e) => updateVariant(idx, { barcode: e.target.value })}
                      aria-label={`Barcode for ${label}`}
                      aria-invalid={!!barcodeErr}
                      placeholder="Optional"
                      maxLength={MAX_SKU_LENGTH}
                    />
                    <CellError message={barcodeErr} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {sellingPriceLabel(state)}
                      <span className="text-danger">*</span>
                    </label>
                    <MoneyInput
                      value={v.unitPrice}
                      onChange={(val) => updateVariant(idx, { unitPrice: val })}
                      ariaLabel={`Selling price for ${label}`}
                      invalid={!!priceErr}
                    />
                    <CellError message={priceErr} />
                  </div>
                  {isLocal && state.trackInventory ? (
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Opening stock
                      </label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.001"
                        value={v.openingQuantity}
                        onChange={(e) => updateVariant(idx, { openingQuantity: e.target.value })}
                        aria-label={`Opening stock for ${label}`}
                        aria-invalid={!!openqErr}
                        placeholder="0"
                        className="touch-manipulation"
                      />
                      <CellError message={openqErr} />
                    </div>
                  ) : null}
                  {state.trackInventory ? (
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Reorder
                      </label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.001"
                        value={v.reorderLevel}
                        onChange={(e) => updateVariant(idx, { reorderLevel: e.target.value })}
                        aria-label={`Reorder point for ${label}`}
                        aria-invalid={!!reorderErr}
                        placeholder="Optional"
                        className="touch-manipulation"
                      />
                      <CellError message={reorderErr} />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {isLocal && anyOpening ? (
        <div className="rounded-2xl border border-border bg-card p-4">
          <Field
            label="Opening stock branch"
            htmlFor="opening-branch"
            required
            error={errors['openingBranchId']}
          >
            <Select
              id="opening-branch"
              value={state.openingBranchId}
              onChange={(e) => onChange({ openingBranchId: e.target.value })}
              aria-invalid={!!errors['openingBranchId']}
            >
              <option value="">Select a branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Opening stock is posted as an inventory receipt against this branch so the
            weighted-average is seeded on the same path as future GRNs.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ── Small primitives ─────────────────────────────────────────────────────────

/**
 * D134 (`6.1`) — how this product is sold, and in what unit.
 *
 * The gap this closes: `quantityType` shipped on the column, the DTO, the
 * read model and the till, and there was no way to SET it. A measured
 * product could only be created by writing to the database directly, which
 * is how the seeded rice worked and why nothing else could.
 *
 * The unit is free text (D134b §1) and the examples are a placeholder, not
 * a list — a shop selling rope by the foot must not have to wait for us.
 */
function MeasureCard({
  state,
  errors,
  onChange,
}: {
  state: WizardState;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const measured = state.quantityType === 'DECIMAL';

  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border bg-card p-4 md:grid-cols-2">
      <Field label="How is this sold?" htmlFor="quantity-type">
        <Select
          id="quantity-type"
          value={state.quantityType}
          onChange={(e) =>
            onChange(
              e.target.value === 'DECIMAL'
                ? { quantityType: 'DECIMAL' }
                : // Clearing the unit on the way back to WHOLE keeps the two
                  // fields from disagreeing: a product sold by the piece that
                  // still carried "kg" would print "3 kg" for three tins.
                  { quantityType: 'WHOLE', unitOfMeasure: '' },
            )
          }
        >
          <option value="WHOLE">By the piece — 1, 2, 3</option>
          <option value="DECIMAL">By weight or measure — 0.75, 1.5</option>
        </Select>
      </Field>

      {measured ? (
        <Field
          label="Unit"
          htmlFor="unit-of-measure"
          required
          error={errors['unitOfMeasure']}
        >
          <Input
            id="unit-of-measure"
            value={state.unitOfMeasure}
            onChange={(e) => onChange({ unitOfMeasure: e.target.value })}
            placeholder="kg, g, L, ml, m…"
            maxLength={12}
            aria-invalid={!!errors['unitOfMeasure']}
          />
        </Field>
      ) : null}

      <div className="md:col-span-2">
        <InfoBanner>
          {measured
            ? state.unitOfMeasure.trim()
              ? `The till will ask "How many ${state.unitOfMeasure.trim()}?" and price the amount typed — 0.75 × the price below. Receipts read “0.750 ${state.unitOfMeasure.trim()}”.`
              : 'Name the unit above, and the price below becomes a price per unit.'
            : 'Quantity is a whole number and the till adds one at a time. Switch to “by weight or measure” for anything sold loose — rice, dhal, umbalakada.'}
        </InfoBanner>
      </div>
    </div>
  );
}

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

function MoneyInput({
  id,
  value,
  onChange,
  invalid,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
        LKR
      </span>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        className="pl-12"
        aria-invalid={invalid}
        aria-label={ariaLabel}
      />
    </div>
  );
}

/**
 * The per-cell validation line, shared by the table and the card list so a
 * variant row blames the same field with the same wording in both layouts.
 */
function CellError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-0.5 text-[11px] text-danger" role="alert">
      {message}
    </p>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="whitespace-nowrap px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </th>
  );
}

function InfoBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
