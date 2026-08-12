'use client';

import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/restaurant/labels';

import type { VariationRow, WizardState } from './wizard-state';

/**
 * Restaurant Menu Wizard — Step 2: Pricing & variations.
 *
 * Base price is the Menu Item's `basePrice`. Variations are stored as a
 * `ModifierGroup(selection=SINGLE, min=1, max=1, role='SIZE')` with each
 * option's `priceDelta` carrying the adjustment from base (see D41).
 *
 * The row shows: name, price delta, resolved absolute price (for operator
 * sanity), and a delete affordance. New rows fade in and focus the name
 * input, per the VARIATION MICRO-UX clause.
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardState>) => void;
}

const emptyRow = (): VariationRow => ({
  key: `var-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  name: '',
  priceDelta: 0,
});

export function StepPricingVariations({ state, errors, onChange }: Props) {
  const [pendingFocusKey, setPendingFocusKey] = React.useState<string | null>(null);
  const nameRefs = React.useRef<Map<string, HTMLInputElement | null>>(new Map());

  React.useEffect(() => {
    if (pendingFocusKey) {
      nameRefs.current.get(pendingFocusKey)?.focus();
      setPendingFocusKey(null);
    }
  }, [pendingFocusKey]);

  const base = Number(state.basePrice) || 0;

  const addRow = () => {
    const row = emptyRow();
    onChange({ variations: [...state.variations, row] });
    setPendingFocusKey(row.key);
  };

  const updateRow = (key: string, patch: Partial<VariationRow>) => {
    onChange({
      variations: state.variations.map((v) => (v.key === key ? { ...v, ...patch } : v)),
    });
  };

  const removeRow = (key: string) => {
    onChange({ variations: state.variations.filter((v) => v.key !== key) });
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 2 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Pricing &amp; variations</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Set the selling price and define sizes or portion options.
        </p>
      </div>

      {/* Base price */}
      <div className="space-y-1.5">
        <label htmlFor="wiz-base-price" className="text-sm font-medium">
          Base menu price
          <span className="text-danger" aria-hidden="true">
            {' '}
            *
          </span>
        </label>
        <div className="relative max-w-xs">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
            LKR
          </span>
          <Input
            id="wiz-base-price"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={state.basePrice}
            onChange={(e) => onChange({ basePrice: e.target.value })}
            placeholder="1,200"
            className="pl-12"
            aria-invalid={!!errors.basePrice}
          />
        </div>
        {errors.basePrice ? (
          <p className="text-xs text-danger" role="alert">
            {errors.basePrice}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The price used when no variation applies. Variation prices are added on top.
          </p>
        )}
      </div>

      {/* Variations */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Variations</p>
            <p className="text-xs text-muted-foreground">
              Optional — add Small / Medium / Large or similar. Prices below are added to
              the base price above.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={addRow}
          >
            Add variation
          </Button>
        </div>

        {state.variations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No variations yet. The item will be sold at the base price above.
            </p>
          </div>
        ) : (
          <ul className="space-y-2" role="list" aria-label="Variations">
            {state.variations.map((v, i) => {
              const absolute = base + Number(v.priceDelta || 0);
              const nameError = errors[`variation-name-${i}`];
              const deltaError = errors[`variation-delta-${i}`];
              return (
                <li
                  key={v.key}
                  className="animate-in fade-in slide-in-from-top-1 grid grid-cols-1 items-start gap-2 rounded-xl border border-border bg-muted/30 p-3 sm:grid-cols-[1fr_140px_120px_auto]"
                  style={{ animationDuration: '160ms' }}
                >
                  <div className="space-y-1">
                    <label className="sr-only" htmlFor={`var-name-${v.key}`}>
                      Variation name
                    </label>
                    <Input
                      id={`var-name-${v.key}`}
                      ref={(el) => {
                        nameRefs.current.set(v.key, el);
                      }}
                      value={v.name}
                      onChange={(e) => updateRow(v.key, { name: e.target.value })}
                      placeholder={i === 0 ? 'Small' : i === 1 ? 'Medium' : 'Large'}
                      maxLength={40}
                      aria-invalid={!!nameError}
                    />
                    {nameError ? (
                      <p className="text-[11px] text-danger" role="alert">
                        {nameError}
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    <label className="sr-only" htmlFor={`var-delta-${v.key}`}>
                      Price adjustment
                    </label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                        +
                      </span>
                      <Input
                        id={`var-delta-${v.key}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={String(v.priceDelta)}
                        onChange={(e) =>
                          updateRow(v.key, { priceDelta: Number(e.target.value) || 0 })
                        }
                        placeholder="0"
                        className="pl-7"
                        aria-invalid={!!deltaError}
                      />
                    </div>
                    {deltaError ? (
                      <p className="text-[11px] text-danger" role="alert">
                        {deltaError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex h-11 items-center justify-end rounded-lg border border-border bg-surface px-3 text-sm font-semibold text-primary">
                    {formatMoney(absolute)}
                  </div>
                  <div className="flex h-11 items-center justify-end">
                    <button
                      type="button"
                      onClick={() => removeRow(v.key)}
                      aria-label={`Remove ${v.name || 'variation'}`}
                      // touch-target-coarse enlarges to 44px on tablet so the
                      // trash icon isn't a 28px stab hazard next to the SKU
                      // and price inputs.
                      className="rounded-md p-2 text-muted-foreground transition-colors touch-target-coarse hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
