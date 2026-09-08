'use client';

import { ImageIcon } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { resolveImageUrl, type CategoryNode } from '@/lib/products-api';

import { priceBand, type WizardState } from './wizard-state';

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

  /*
   * D86 — an uploaded image is stored as `/uploads/<key>` and served by the
   * API, which is a DIFFERENT origin from the web app in every deployment
   * (:4000 vs :3000 locally, api.axlopos.com vs the Amplify host in prod).
   * Rendered raw, the browser resolved it against the app's own origin and
   * got a 404, so the preview stayed empty however many times you uploaded.
   * `resolveImageUrl` is what the product list and the printed bill already
   * use; blob:/data:/absolute URLs (the "Image URL" tab) pass through.
   */
  const imageSrc = resolveImageUrl(state.imageUrl);
  // A src that fails anyway — a dead remote URL pasted on the URL tab — falls
  // back to the placeholder. Hiding the <img> left an empty grey box, which is
  // exactly what made the origin bug above look like "nothing happened".
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = !!imageSrc && failedSrc !== imageSrc;

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
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageSrc}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setFailedSrc(imageSrc)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" aria-hidden="true" />
          </div>
        )}
      </div>

      {/*
        * `break-words` on every operator-typed value.
        *
        * A name like "Beef Steak3444444…" is ONE token with no space to wrap
        * at, so without this the line cannot break and simply runs past the
        * card's edge — the panel is a fixed grid track (and a Sheet on
        * tablet), so it never widens to accommodate it. `break-words` splits
        * a word only when it cannot fit on a line of its own, which leaves
        * ordinary multi-word names breaking exactly as they do today.
        */}
      <div className="min-w-0 space-y-1">
        <p className="break-words text-base font-semibold">
          {state.name || <span className="text-muted-foreground">Product name</span>}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="primary">{typeLabel(state.type)}</Badge>
          {/* Category names are free text too, so the pill needs a width to
              wrap inside — `inline-flex` alone would just grow past the card. */}
          {cat ? (
            <Badge variant="neutral" className="max-w-full break-words">
              {cat.name}
            </Badge>
          ) : null}
          {state.hasVariations ? (
            <Badge variant="neutral">
              {enabledCount} variant{enabledCount === 1 ? '' : 's'}
            </Badge>
          ) : null}
        </div>
        {state.description ? (
          <p className="break-words text-xs text-muted-foreground">{state.description}</p>
        ) : null}
        {state.brand ? (
          <p className="break-words text-xs text-muted-foreground">Brand: {state.brand}</p>
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
