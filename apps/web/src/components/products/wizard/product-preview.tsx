'use client';

import { ImageIcon } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import type { CategoryNode } from '@/lib/products-api';

import { priceBand, type WizardState } from './wizard-state';
import { resolveImageUrl } from '@/lib/products-api';

/**
 * Add Product wizard — right-rail live preview.
 *
 * Deliberately not editable — the operator interacts with the step form on
 * the left; this panel reflects what has been typed so they can catch a
 * mismatch (wrong image, wrong type badge) without leaving the page.
 */
interface Props {
  state: WizardState;
  categories: CategoryNode[];
  /** Only Step 3 onwards has enough data for the price band; step index gates it. */
  currentStepIndex: number;
}

export function ProductPreview({ state, categories, currentStepIndex }: Props) {
  const cat = categories.find((c) => c.id === state.categoryId) ?? null;
  const enabledCount = state.hasVariations
    ? state.variants.filter((v) => v.enabled).length
    : 0;

  const band = currentStepIndex >= 2 ? priceBand(state) : null;

  return (
    <aside
      // Sticky only from `lg` up — that's the viewport where the aside
      // sits in the wizard's inline preview column. On tablet the same
      // component mounts inside a Sheet, where sticky would peel off the
      // top of the Sheet's scroll container.
      className="lg:sticky lg:top-6 space-y-4 rounded-2xl border border-border bg-card p-4"
      aria-label="Product preview"
    >
      <div>
        <h2 className="text-sm font-semibold">Product preview</h2>
        <p className="text-xs text-muted-foreground">Reflects what you&apos;ve entered so far.</p>
      </div>

      <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted">
        {state.imageUrl ? (
          /*
           * D99 (2.14) — resolved, not raw. After upload `imageUrl` is a
           * SERVER-RELATIVE path (`/uploads/products/….webp`), so the browser
           * resolves it against the WEB origin while the file is served by the
           * API. It 404s, and the `onError` below hides the element — so the
           * failure showed as an empty box rather than a broken image, which is
           * why it survived. `resolveImageUrl` passes blob:/data:/http through
           * untouched, so the local pre-upload preview still works.
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolveImageUrl(state.imageUrl) ?? undefined}
            alt=""
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-base font-semibold">
          {state.name || <span className="text-muted-foreground">Product name</span>}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="primary">{typeLabel(state.type)}</Badge>
          {cat ? <Badge variant="neutral">{cat.name}</Badge> : null}
          {state.hasVariations ? (
            <Badge variant="neutral">
              {enabledCount} variant{enabledCount === 1 ? '' : 's'}
            </Badge>
          ) : null}
        </div>
        {state.description ? (
          <p className="text-xs text-muted-foreground">{state.description}</p>
        ) : null}
        {state.brand ? (
          <p className="text-xs text-muted-foreground">Brand: {state.brand}</p>
        ) : null}
      </div>

      {band ? (
        <div className="border-t border-border pt-3 text-xs">
          <p className="text-muted-foreground">Price</p>
          <p className="mt-0.5 text-sm font-semibold text-primary">
            {band.min === band.max
              ? `LKR ${band.min.toFixed(2)}`
              : `LKR ${band.min.toFixed(2)} - ${band.max.toFixed(2)}`}
          </p>
        </div>
      ) : null}
    </aside>
  );
}

function typeLabel(t: WizardState['type']): string {
  if (t === 'Inventory') return 'Inventory';
  if (t === 'NonInventory') return 'Non-inventory';
  return 'Service';
}
