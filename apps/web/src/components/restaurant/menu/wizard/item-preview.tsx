'use client';

import { Clock, Flame, ImageIcon, Plus, Sparkles, Utensils } from 'lucide-react';
import * as React from 'react';

import { formatMoney } from '@/lib/restaurant/labels';

import { priceBounds, type WizardState } from './wizard-state';

/**
 * Read-only preview panel — the right-side rail on desktop. Reflects Step 1
 * text + Step 2 variations live. Matches the mock's "Item preview" card:
 * image on top, name + type, description, kitchen chip + prep chip, then
 * variations and modifier summaries.
 *
 * Deliberately not editable — the brief's LIVE PREVIEW clause forbids it.
 */
interface Props {
  state: WizardState;
  sectionName?: string | null;
  stationName?: string | null;
}

export function ItemPreview({ state, sectionName, stationName }: Props) {
  const bounds = priceBounds(state);
  const hasRange = bounds.from !== bounds.to;
  const priceLabel = hasRange
    ? `${formatMoney(bounds.from)} – ${formatMoney(bounds.to)}`
    : formatMoney(bounds.from);

  return (
    <aside
      className="sticky top-4 space-y-4 rounded-2xl border border-border bg-card p-4"
      aria-label="Item preview"
    >
      <div>
        <h2 className="text-sm font-semibold">Item preview</h2>
        <p className="text-xs text-muted-foreground">
          This is how it will appear on the POS and menu.
        </p>
      </div>

      {/* Photo */}
      <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted">
        {state.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={state.imageUrl}
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

      {/* Name + tags */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <p className="text-base font-semibold">
            {state.name || <span className="text-muted-foreground">Menu item name</span>}
          </p>
          {state.itemType ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {itemTypeChip(state.itemType)}
            </span>
          ) : null}
        </div>
        {state.description ? (
          <p className="text-xs text-muted-foreground">{state.description}</p>
        ) : null}
        {sectionName ? (
          <p className="text-xs text-muted-foreground">In {sectionName}</p>
        ) : null}
      </div>

      {/* Kitchen chip */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {stationName ? (
          <span className="inline-flex items-center gap-1">
            <Flame className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            {stationName}
          </span>
        ) : null}
        {state.prepMinutes ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {state.prepMinutes} min
          </span>
        ) : null}
        {state.dietaryTags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium"
          >
            {t}
          </span>
        ))}
      </div>

      {/* Variations */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Variations (Sizes)
        </p>
        {state.variations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Set variations on the next step. Otherwise the base price above is used.
          </p>
        ) : (
          <ul className="space-y-1">
            {state.variations.map((v) => (
              <li
                key={v.key}
                className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
              >
                <span className="truncate">{v.name || 'Untitled variation'}</span>
                <span className="font-semibold text-primary">
                  {formatMoney((Number(state.basePrice) || 0) + Number(v.priceDelta || 0))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Modifiers */}
      {state.modifierGroups.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Modifiers (Add-ons)
          </p>
          <ul className="space-y-1">
            {state.modifierGroups.flatMap((g) =>
              g.options.slice(0, 4).map((o) => (
                <li
                  key={`${g.key}-${o.key}`}
                  className="flex items-center justify-between text-xs text-muted-foreground"
                >
                  <span className="flex items-center gap-1 truncate">
                    <Plus className="h-3 w-3 text-primary" aria-hidden="true" />
                    <span className="truncate">{o.name || 'Option'}</span>
                  </span>
                  <span className="font-medium">
                    {Number(o.priceDelta) > 0 ? '+ ' : ''}
                    {formatMoney(Number(o.priceDelta) || 0)}
                  </span>
                </li>
              )),
            )}
          </ul>
        </div>
      ) : null}

      {/* Price / summary footer */}
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 text-foreground">
            <Utensils className="h-3.5 w-3.5" aria-hidden="true" />
            {hasRange ? 'From' : 'Price'}
          </span>
          <span className="text-sm font-semibold text-primary">{priceLabel}</span>
        </div>
        {!state.basePrice && state.variations.length === 0 ? (
          <p className="mt-1">Prices are examples until Step 2 is filled in.</p>
        ) : null}
        {state.modifierGroups.length > 0 ? (
          <p className="mt-2 inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {state.modifierGroups.length} modifier group
            {state.modifierGroups.length === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function itemTypeChip(t: 'FOOD' | 'BEVERAGE' | 'DESSERT'): string {
  if (t === 'FOOD') return 'Food';
  if (t === 'BEVERAGE') return 'Beverage';
  return 'Dessert';
}
