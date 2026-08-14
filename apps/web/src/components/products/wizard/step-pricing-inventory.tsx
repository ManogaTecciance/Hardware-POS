'use client';

import { Info, Wand2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { type Session } from '@/lib/auth';
import type { BranchSummary } from '@/lib/products/branches-api';
import type { ProductBusinessKind } from '@/lib/products/product-presentation';
import { useIsTabletUp } from '@/lib/use-viewport';

import { StepRestaurantAdditions } from './step-restaurant-additions';
import { variantLabel, type VariantDraft, type WizardState } from './wizard-state';

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
          placeholder="e.g. MILK-200"
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
        label="Selling price"
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

      <Field label="Cost price" htmlFor="simple-cost">
        <MoneyInput
          id="simple-cost"
          value={state.simple.costPrice}
          onChange={(v) => set({ costPrice: v })}
        />
      </Field>

      {isLocal && state.trackInventory ? (
        <Field label="Opening quantity" htmlFor="simple-openq">
          <Input
            id="simple-openq"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.001"
            value={state.simple.openingQuantity}
            onChange={(e) => set({ openingQuantity: e.target.value })}
            placeholder="0"
          />
        </Field>
      ) : null}

      <Field label="Reorder point" htmlFor="simple-reorder">
        <Input
          id="simple-reorder"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.001"
          value={state.simple.reorderLevel}
          onChange={(e) => set({ reorderLevel: e.target.value })}
          placeholder="Optional"
        />
      </Field>
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
  const generateSkus = () => {
    // The prompt is the least-invasive way to get a prefix without adding a
    // new dialog just for this bulk action. Cashiers rarely need it in edit
    // mode; a follow-up can promote it to a Popover if usage warrants it.
    const raw = typeof window !== 'undefined' ? window.prompt('SKU prefix (e.g. MILK)') : null;
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

  const setReorderForAll = () => {
    const raw =
      typeof window !== 'undefined' ? window.prompt('Reorder point for every enabled variant') : null;
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
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={setReorderForAll}
          disabled={enabledIndexes.length === 0}
        >
          Set reorder for all
        </Button>
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
                  Selling price<span className="text-danger">*</span>
                </Th>
                {isLocal ? <Th>Opening stock</Th> : null}
                <Th>Reorder</Th>
              </tr>
            </thead>
            <tbody>
              {enabledIndexes.map((idx, rowNumber) => {
                const v = state.variants[idx]!;
                const label = variantLabel(v, state.variations) || 'Unnamed variant';
                const skuErr = errors[`variant-sku-${rowNumber}`];
                const priceErr = errors[`variant-price-${rowNumber}`];
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
                        className="min-w-[9rem]"
                      />
                      {skuErr ? (
                        <p className="mt-0.5 text-[11px] text-danger" role="alert">
                          {skuErr}
                        </p>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <Input
                        value={v.barcode}
                        onChange={(e) => updateVariant(idx, { barcode: e.target.value })}
                        aria-label={`Barcode for ${label}`}
                        placeholder="Optional"
                        className="min-w-[9rem]"
                      />
                    </td>
                    <td className="p-2">
                      <MoneyInput
                        value={v.unitPrice}
                        onChange={(val) => updateVariant(idx, { unitPrice: val })}
                        ariaLabel={`Selling price for ${label}`}
                        invalid={!!priceErr}
                      />
                      {priceErr ? (
                        <p className="mt-0.5 text-[11px] text-danger" role="alert">
                          {priceErr}
                        </p>
                      ) : null}
                    </td>
                    {isLocal ? (
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
                          placeholder="0"
                          className="min-w-[6rem] touch-manipulation"
                        />
                      </td>
                    ) : null}
                    <td className="p-2">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.001"
                        value={v.reorderLevel}
                        onChange={(e) => updateVariant(idx, { reorderLevel: e.target.value })}
                        aria-label={`Reorder point for ${label}`}
                        placeholder="Optional"
                        className="min-w-[6rem] touch-manipulation"
                      />
                    </td>
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
            const priceErr = errors[`variant-price-${rowNumber}`];
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
                    />
                    {skuErr ? (
                      <p className="text-[11px] text-danger" role="alert">
                        {skuErr}
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Barcode
                    </label>
                    <Input
                      value={v.barcode}
                      onChange={(e) => updateVariant(idx, { barcode: e.target.value })}
                      aria-label={`Barcode for ${label}`}
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Selling price<span className="text-danger">*</span>
                    </label>
                    <MoneyInput
                      value={v.unitPrice}
                      onChange={(val) => updateVariant(idx, { unitPrice: val })}
                      ariaLabel={`Selling price for ${label}`}
                      invalid={!!priceErr}
                    />
                    {priceErr ? (
                      <p className="text-[11px] text-danger" role="alert">
                        {priceErr}
                      </p>
                    ) : null}
                  </div>
                  {isLocal ? (
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
                        placeholder="0"
                        className="touch-manipulation"
                      />
                    </div>
                  ) : null}
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
                      placeholder="Optional"
                      className="touch-manipulation"
                    />
                  </div>
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
