'use client';

import { MoreVertical, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import {
  COMBINATION_CONFIRM_THRESHOLD,
  MAX_COMBINATIONS,
  enumerateCombinations,
  makeKey,
  type VariantDraft,
  type VariationDraft,
  type WizardState,
} from './wizard-state';

/**
 * Add Product wizard — Step 2: Variations (D44).
 *
 * The "no variations" switch (`hasVariations=false`) short-circuits into a
 * hint card; Continue then jumps to Step 3 in simple mode. When variations
 * are declared, each dimension is a card with a name input and its options.
 *
 * The sellable-variants matrix is materialised BELOW the dimension list so
 * the operator sees the shape they are building without pressing another
 * button. Above the 100-combinations threshold we hide the matrix behind a
 * confirmation prompt so the operator has to acknowledge the scale; above
 * 500 combinations we refuse outright (matches the validator).
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepVariations({ state, errors, onChange }: Props) {
  // Freshly-added option rows focus their Name input so the operator can type
  // straight in — the ref map is keyed by option key so re-renders don't lose
  // it (unlike an array index).
  const [pendingFocusOptionKey, setPendingFocusOptionKey] = React.useState<string | null>(null);
  const [pendingFocusDimKey, setPendingFocusDimKey] = React.useState<string | null>(null);
  const optionNameRefs = React.useRef<Map<string, HTMLInputElement | null>>(new Map());
  const dimNameRefs = React.useRef<Map<string, HTMLInputElement | null>>(new Map());

  React.useEffect(() => {
    if (pendingFocusOptionKey) {
      optionNameRefs.current.get(pendingFocusOptionKey)?.focus();
      setPendingFocusOptionKey(null);
    }
  }, [pendingFocusOptionKey]);

  React.useEffect(() => {
    if (pendingFocusDimKey) {
      dimNameRefs.current.get(pendingFocusDimKey)?.focus();
      setPendingFocusDimKey(null);
    }
  }, [pendingFocusDimKey]);

  const combinations = React.useMemo(
    () => enumerateCombinations(state.variations),
    [state.variations],
  );

  // Every time the combinations list is recomputed we reconcile the variant
  // rows: keep enable-state and any typed prices from a matching row, drop
  // rows whose options no longer exist. Doing this here keeps the wizard
  // state honest without asking the operator to press a "regenerate" button.
  React.useEffect(() => {
    if (!state.hasVariations) return;
    const wantKeys = combinations.map((c) => c.optionKeys.join('|'));
    const byKey = new Map(
      state.variants.map((v) => [v.optionKeys.join('|'), v] as const),
    );
    // If the set is unchanged the reference identity of variants is preserved
    // so React sees no work.
    const currentKeys = state.variants.map((v) => v.optionKeys.join('|'));
    const same =
      currentKeys.length === wantKeys.length &&
      currentKeys.every((k, i) => k === wantKeys[i]);
    if (same) return;

    const next: VariantDraft[] = combinations.map((c) => {
      const existing = byKey.get(c.optionKeys.join('|'));
      if (existing) return { ...existing, optionKeys: [...c.optionKeys] };
      return {
        key: makeKey('var'),
        // Default new rows to disabled when we're above the confirm threshold
        // so a bulk-enable is an explicit gesture, not a side-effect of typing.
        enabled: combinations.length <= COMBINATION_CONFIRM_THRESHOLD,
        sku: '',
        barcode: '',
        unitPrice: '',
        costPrice: '',
        openingQuantity: '',
        reorderLevel: '',
        imageUrl: null,
        isActive: true,
        optionKeys: [...c.optionKeys],
      } satisfies VariantDraft;
    });
    onChange({ variants: next });
    // Intentional: run whenever the combinations list content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combinations.length, state.hasVariations]);

  const [showMatrixConfirm, setShowMatrixConfirm] = React.useState(false);
  const anyEnabled = state.variants.some((v) => v.enabled);
  const overConfirm = combinations.length > COMBINATION_CONFIRM_THRESHOLD;
  const overMax = combinations.length > MAX_COMBINATIONS;
  const matrixHidden = overConfirm && !overMax && !anyEnabled && !showMatrixConfirm;

  const addVariation = () => {
    const dim: VariationDraft = {
      key: makeKey('dim'),
      name: '',
      options: [{ key: makeKey('opt'), name: '' }],
    };
    onChange({ variations: [...state.variations, dim] });
    setPendingFocusDimKey(dim.key);
  };

  const removeVariation = (key: string) => {
    onChange({ variations: state.variations.filter((d) => d.key !== key) });
  };

  const updateVariation = (key: string, patch: Partial<VariationDraft>) => {
    onChange({
      variations: state.variations.map((d) => (d.key === key ? { ...d, ...patch } : d)),
    });
  };

  const addOption = (dimKey: string) => {
    const nextKey = makeKey('opt');
    onChange({
      variations: state.variations.map((d) =>
        d.key === dimKey
          ? { ...d, options: [...d.options, { key: nextKey, name: '' }] }
          : d,
      ),
    });
    setPendingFocusOptionKey(nextKey);
  };

  const updateOption = (dimKey: string, optKey: string, name: string) => {
    onChange({
      variations: state.variations.map((d) =>
        d.key === dimKey
          ? {
              ...d,
              options: d.options.map((o) => (o.key === optKey ? { ...o, name } : o)),
            }
          : d,
      ),
    });
  };

  const removeOption = (dimKey: string, optKey: string) => {
    onChange({
      variations: state.variations.map((d) =>
        d.key === dimKey ? { ...d, options: d.options.filter((o) => o.key !== optKey) } : d,
      ),
    });
  };

  const setAllEnabled = (enabled: boolean) => {
    onChange({ variants: state.variants.map((v) => ({ ...v, enabled })) });
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 2 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Variations</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Sizes, colours, or any dimension a single product can be sold in.
        </p>
      </div>

      {/* No-variations toggle */}
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4">
        <Switch
          checked={!state.hasVariations}
          onCheckedChange={(v) => onChange({ hasVariations: !v })}
          aria-label="This product has no variations"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">This product has no variations</p>
          <p className="text-xs text-muted-foreground">
            Turn off if the product is sold in only one form — one SKU, one price.
          </p>
        </div>
      </div>

      {!state.hasVariations ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <p className="text-sm font-medium">Single SKU mode</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The next step will collect one SKU, price, and (for Inventory items) opening stock.
          </p>
        </div>
      ) : (
        <>
          {/* Dimensions */}
          <div className="space-y-3">
            {state.variations.map((dim, di) => {
              const nameError = errors[`variation-name-${di}`];
              const optionsError =
                errors[`variation-options-${di}`] ?? errors[`variation-dup-${di}`];
              return (
                <div
                  key={dim.key}
                  className="animate-in fade-in slide-in-from-top-1 space-y-3 rounded-2xl border border-border bg-card p-4 motion-reduce:animate-none"
                  style={{ animationDuration: '160ms' }}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-1">
                      <label
                        htmlFor={`dim-name-${dim.key}`}
                        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        Variation
                      </label>
                      <Input
                        id={`dim-name-${dim.key}`}
                        ref={(el) => {
                          dimNameRefs.current.set(dim.key, el);
                        }}
                        value={dim.name}
                        onChange={(e) => updateVariation(dim.key, { name: e.target.value })}
                        placeholder={di === 0 ? 'Size' : 'Colour'}
                        maxLength={40}
                        aria-invalid={!!nameError}
                      />
                      {nameError ? (
                        <p className="text-xs text-danger" role="alert">
                          {nameError}
                        </p>
                      ) : null}
                    </div>
                    <DimensionMenu onDelete={() => removeVariation(dim.key)} label={dim.name} />
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Options</p>
                    <ul className="space-y-2" role="list">
                      {dim.options.map((opt) => (
                        <li
                          key={opt.key}
                          className="animate-in fade-in slide-in-from-top-1 flex items-center gap-2 motion-reduce:animate-none"
                          style={{ animationDuration: '160ms' }}
                        >
                          <Input
                            ref={(el) => {
                              optionNameRefs.current.set(opt.key, el);
                            }}
                            value={opt.name}
                            onChange={(e) => updateOption(dim.key, opt.key, e.target.value)}
                            placeholder="Option value"
                            maxLength={40}
                          />
                          <button
                            type="button"
                            onClick={() => removeOption(dim.key, opt.key)}
                            aria-label={`Remove ${opt.name || 'option'}`}
                            // touch-target-coarse enlarges the trash icon to
                            // 44px on tablet — the option list is a stack of
                            // small inputs and a mis-tap next door can wipe
                            // the wrong row.
                            className="rounded-md p-2 text-muted-foreground transition-colors touch-target-coarse hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {optionsError ? (
                      <p className="text-xs text-danger" role="alert">
                        {optionsError}
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => addOption(dim.key)}
                    >
                      Add option
                    </Button>
                  </div>
                </div>
              );
            })}

            <Button
              type="button"
              variant="secondary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={addVariation}
            >
              Add variation
            </Button>
          </div>

          {/* Sellable variants matrix */}
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">Sellable variants</p>
                <p className="text-xs text-muted-foreground">
                  {combinations.length === 0
                    ? 'Enter at least one option per variation to see the list.'
                    : `${combinations.length} combination${combinations.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {combinations.length > 0 && !overMax && !matrixHidden ? (
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setAllEnabled(true)}
                  >
                    Select all
                  </button>
                  <span aria-hidden="true" className="text-muted-foreground">
                    ·
                  </span>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setAllEnabled(false)}
                  >
                    Clear all
                  </button>
                </div>
              ) : null}
            </div>

            {overMax ? (
              <p
                className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-xs text-danger"
                role="alert"
              >
                {errors['variations-too-many'] ??
                  `That is ${combinations.length} combinations. Split into separate products or trim options — the maximum is ${MAX_COMBINATIONS}.`}
              </p>
            ) : matrixHidden ? (
              <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-xs">
                <p className="font-medium text-warning">
                  This configuration will generate {combinations.length} possible variants.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Are you sure? Confirming enables every combination — you can uncheck rows next.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    setShowMatrixConfirm(true);
                    setAllEnabled(true);
                  }}
                >
                  Confirm and continue
                </Button>
              </div>
            ) : combinations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No variants yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className="w-8 pb-2" aria-label="Enabled" />
                      {state.variations.map((d) => (
                        <th
                          key={d.key}
                          scope="col"
                          className="pb-2 pr-3 font-medium text-muted-foreground"
                        >
                          {d.name || 'Unnamed'}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {state.variants.map((v, vi) => (
                      <tr key={v.key} className="border-b border-border/60 last:border-none">
                        <td className="py-1.5">
                          <input
                            type="checkbox"
                            checked={v.enabled}
                            onChange={(e) =>
                              onChange({
                                variants: state.variants.map((row, i) =>
                                  i === vi ? { ...row, enabled: e.target.checked } : row,
                                ),
                              })
                            }
                            aria-label={`Enable variant ${vi + 1}`}
                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                        </td>
                        {state.variations.map((d, di) => {
                          const opt = d.options.find((o) => o.key === v.optionKeys[di]);
                          return (
                            <td key={d.key} className="py-1.5 pr-3">
                              {opt?.name || '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {errors['pricing-none-enabled'] ? (
            <p className="text-xs text-danger" role="alert">
              {errors['pricing-none-enabled']}
            </p>
          ) : null}
          {errors['variations-empty'] ? (
            <p className="text-xs text-danger" role="alert">
              {errors['variations-empty']}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── Overflow menu for a variation card ───────────────────────────────────────

function DimensionMenu({ onDelete, label }: { onDelete: () => void; label: string }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Options for ${label || 'variation'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        // touch-target-coarse: the variation-menu trigger is the only way
        // to delete a dimension; a mis-tap here is expensive.
        className="rounded-md p-2 text-muted-foreground touch-target-coarse hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="animate-in fade-in slide-in-from-top-1 absolute right-0 z-10 mt-1 w-44 rounded-lg border border-border bg-surface p-1 shadow-md motion-reduce:animate-none"
          style={{ animationDuration: '120ms' }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger hover:bg-danger-soft"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete variation
          </button>
        </div>
      ) : null}
    </div>
  );
}
