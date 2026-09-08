'use client';

import { Check, Loader2, Pencil, Save } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import type { CategoryNode } from '@/lib/products-api';

import { variantLabel, type StepKey, type WizardState } from './wizard-state';

/**
 * Add Product wizard — Step 4: Review & save (D44).
 *
 * Three summary cards, one per preceding step, each with an Edit affordance
 * that jumps back to that step. The Save button carries its own three-state
 * indicator so the wizard's footer can stay a plain "Save Product" button and
 * still expose progress + confirmation to screen readers.
 */
interface Props {
  state: WizardState;
  categories: CategoryNode[];
  /** Whether the tenant tracks stock locally — derived by the wizard shell (D31). */
  showOpeningStock: boolean;
  saveState: 'idle' | 'saving' | 'saved';
  onEdit: (step: StepKey) => void;
  onSave: () => void;
}

export function StepReview({
  state,
  categories,
  showOpeningStock,
  saveState,
  onEdit,
  onSave,
}: Props) {
  const cat = categories.find((c) => c.id === state.categoryId) ?? null;
  const sub = cat?.subcategories.find((s) => s.id === state.subcategoryId) ?? null;
  const isLocal = showOpeningStock;

  const enabledVariants = state.variants.filter((v) => v.enabled);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 4 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Review &amp; save</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Look over what&apos;s about to be created. Everything is editable later from the product page.
        </p>
      </div>

      <SummaryCard title="Product details" onEdit={() => onEdit('details')}>
        <Row label="Name" value={state.name || '—'} />
        <Row label="Type" value={typeLabel(state.type)} />
        <Row label="Category" value={cat?.name ?? 'Uncategorised'} />
        {sub ? <Row label="Subcategory" value={sub.name} /> : null}
        {state.brand ? <Row label="Brand" value={state.brand} /> : null}
        <Row label="Track inventory" value={state.trackInventory ? 'Yes' : 'No'} />
        {state.description ? (
          <Row label="Description" value={state.description} truncate />
        ) : null}
        {state.imageUrl ? <Row label="Image" value={state.imageUrl} truncate /> : null}
      </SummaryCard>

      <SummaryCard title="Variations" onEdit={() => onEdit('variations')}>
        {state.hasVariations ? (
          state.variations.length === 0 ? (
            <p className="text-xs text-muted-foreground">No variations declared.</p>
          ) : (
            state.variations.map((d) => (
              <div key={d.key} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{d.name || 'Unnamed'}</span>
                <span className="text-right font-medium">
                  {d.options
                    .filter((o) => o.name.trim())
                    .map((o) => o.name)
                    .join(', ') || '—'}
                </span>
              </div>
            ))
          )
        ) : (
          <p className="text-xs text-muted-foreground">Single SKU — no variations.</p>
        )}
      </SummaryCard>

      <SummaryCard title="Pricing & inventory" onEdit={() => onEdit('pricing')}>
        {state.hasVariations ? (
          enabledVariants.length === 0 ? (
            <p className="text-xs text-muted-foreground">No variants enabled.</p>
          ) : (
            <ul className="space-y-1">
              {enabledVariants.map((v) => (
                <li
                  key={v.key}
                  className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
                >
                  <span className="truncate">
                    {variantLabel(v, state.variations) || 'Unnamed'}
                    <span className="ml-2 text-muted-foreground">{v.sku || 'no SKU'}</span>
                  </span>
                  <span className="font-semibold text-primary">
                    LKR {Number(v.unitPrice || 0).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <Row label="SKU" value={state.simple.sku || '—'} />
            <Row label="Price" value={`LKR ${Number(state.simple.unitPrice || 0).toFixed(2)}`} />
            {isLocal && state.simple.openingQuantity ? (
              <Row label="Opening stock" value={state.simple.openingQuantity} />
            ) : null}
            {state.simple.reorderLevel ? (
              <Row label="Reorder point" value={state.simple.reorderLevel} />
            ) : null}
          </>
        )}
      </SummaryCard>

      <div className="flex justify-end pt-2">
        <Button
          type="button"
          size="lg"
          onClick={onSave}
          disabled={saveState !== 'idle'}
          leftIcon={
            saveState === 'saving' ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" />
            ) : saveState === 'saved' ? (
              <Check className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )
          }
        >
          {saveState === 'saving'
            ? 'Saving...'
            : saveState === 'saved'
              ? 'Saved'
              : 'Save Product'}
        </Button>
      </div>
    </div>
  );
}

function typeLabel(t: WizardState['type']): string {
  if (t === 'Inventory') return 'Inventory';
  if (t === 'NonInventory') return 'Non-inventory';
  return 'Service';
}

function SummaryCard({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          leftIcon={<Pencil className="h-3.5 w-3.5" />}
          onClick={onEdit}
        >
          Edit
        </Button>
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  truncate,
}: {
  label: string;
  value: string;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`font-medium text-foreground ${truncate ? 'max-w-[60%] truncate' : ''}`}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}
