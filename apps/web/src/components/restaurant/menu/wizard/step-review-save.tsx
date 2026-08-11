'use client';

import { Pencil } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/restaurant/labels';
import type { KitchenStationView, SectionView } from '@/lib/restaurant/types';

import type { WizardState } from './wizard-state';

/**
 * Restaurant Menu Wizard — Step 4: Review & save.
 *
 * Summary cards for each preceding step, each with an Edit affordance that
 * jumps back to that step. Preserves all values on the way back — the wizard
 * state is a single reducer that never resets on step navigation.
 */
interface Props {
  state: WizardState;
  sections: SectionView[];
  stations: KitchenStationView[];
  onEdit: (step: 1 | 2 | 3) => void;
}

export function StepReviewSave({ state, sections, stations, onEdit }: Props) {
  const section = sections.find((s) => s.id === state.sectionId);
  const station = stations.find((s) => s.id === state.stationId);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 4 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Review &amp; save</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Review this menu item before publishing it.
        </p>
      </div>

      {/* Menu details */}
      <SummaryCard title="Menu details" onEdit={() => onEdit(1)}>
        <SummaryRow label="Name" value={state.name || '—'} />
        <SummaryRow label="Section" value={section?.name ?? '—'} />
        <SummaryRow
          label="Type"
          value={
            state.itemType === 'FOOD'
              ? 'Food'
              : state.itemType === 'BEVERAGE'
                ? 'Beverage'
                : state.itemType === 'DESSERT'
                  ? 'Dessert'
                  : '—'
          }
        />
        {state.description ? (
          <SummaryRow label="Description" value={state.description} />
        ) : null}
        {state.prepMinutes ? (
          <SummaryRow label="Prep time" value={`${state.prepMinutes} min`} />
        ) : null}
        {station ? (
          <SummaryRow label="Kitchen station" value={station.name} />
        ) : null}
        {state.dietaryTags.length > 0 ? (
          <SummaryRow label="Dietary tags" value={state.dietaryTags.join(', ')} />
        ) : null}
        {state.imageUrl ? (
          <SummaryRow label="Image" value={state.imageUrl} truncate />
        ) : null}
      </SummaryCard>

      {/* Pricing */}
      <SummaryCard title="Pricing" onEdit={() => onEdit(2)}>
        <SummaryRow label="Base price" value={formatMoney(Number(state.basePrice) || 0)} />
        {state.variations.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Variations</p>
            <ul className="space-y-1">
              {state.variations.map((v) => (
                <li
                  key={v.key}
                  className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
                >
                  <span>{v.name || 'Untitled'}</span>
                  <span className="font-semibold text-primary">
                    {formatMoney((Number(state.basePrice) || 0) + Number(v.priceDelta || 0))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SummaryCard>

      {/* Modifiers */}
      <SummaryCard title="Modifiers &amp; availability" onEdit={() => onEdit(3)}>
        <SummaryRow
          label="Availability"
          value={state.isActive ? 'Available' : 'Unavailable'}
        />
        {state.modifierGroups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No modifier groups configured.</p>
        ) : (
          state.modifierGroups.map((g) => (
            <div key={g.key} className="space-y-1">
              <p className="text-xs font-medium">
                {g.name || 'Untitled group'}
                <span className="ml-2 text-muted-foreground">
                  {g.minSelections > 0 ? 'Required' : 'Optional'}
                  {g.selection === 'MULTIPLE' ? ' · multiple' : ' · single'}
                </span>
              </p>
              <ul className="space-y-0.5 pl-3">
                {g.options.map((o) => (
                  <li
                    key={o.key}
                    className="flex items-center justify-between text-xs text-muted-foreground"
                  >
                    <span>{o.name || 'Untitled'}</span>
                    <span>
                      {Number(o.priceDelta) > 0 ? '+ ' : ''}
                      {formatMoney(Number(o.priceDelta) || 0)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </SummaryCard>
    </div>
  );
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

function SummaryRow({
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
