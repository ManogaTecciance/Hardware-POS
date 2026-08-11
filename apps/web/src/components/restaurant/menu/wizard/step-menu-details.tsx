'use client';

import { Coffee, Cookie, ImagePlus, Utensils } from 'lucide-react';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  MENU_DIETARY_TAGS,
  type MenuItemType,
  type SectionView,
  type KitchenStationView,
} from '@/lib/restaurant/types';

import type { WizardState } from './wizard-state';

/**
 * Restaurant Menu Wizard — Step 1: Menu details.
 *
 * All fields on this step map 1-to-1 to a persisted column (see D41). No
 * frontend-only inventions.
 *
 * Layout matches the reference mock:
 *   • Menu item name (full width)
 *   • Section (left) | Prep time (right)
 *   • Item type segmented control (full width)
 *   • Description + dietary tag chips + upload photo card
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  sections: SectionView[];
  stations: KitchenStationView[];
  onChange: (patch: Partial<WizardState>) => void;
}

const ITEM_TYPES: { value: MenuItemType; label: string; icon: React.ReactNode }[] = [
  { value: 'FOOD', label: 'Food', icon: <Utensils className="h-4 w-4" aria-hidden="true" /> },
  { value: 'BEVERAGE', label: 'Beverage', icon: <Coffee className="h-4 w-4" aria-hidden="true" /> },
  { value: 'DESSERT', label: 'Dessert', icon: <Cookie className="h-4 w-4" aria-hidden="true" /> },
];

export function StepMenuDetails({ state, errors, sections, stations, onChange }: Props) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Step 1 of 4</p>
        <h2 className="mt-1 text-lg font-semibold">Menu details</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Add the essential information about your menu item.
        </p>
      </div>

      {/* Name */}
      <Field
        label="Menu item name"
        htmlFor="menu-name"
        required
        error={errors.name}
      >
        <Input
          id="menu-name"
          value={state.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Mix Kottu"
          maxLength={120}
          autoFocus={!state.editingItemId}
          aria-invalid={!!errors.name}
        />
      </Field>

      {/* Section + Prep time */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Section"
          htmlFor="menu-section"
          required
          error={errors.sectionId}
        >
          <Select
            id="menu-section"
            value={state.sectionId ?? ''}
            onChange={(e) => onChange({ sectionId: e.target.value || null })}
            aria-invalid={!!errors.sectionId}
          >
            <option value="">Select section</option>
            {sections
              .slice()
              .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field
          label="Preparation time"
          htmlFor="menu-prep"
          error={errors.prepMinutes}
        >
          <div className="relative">
            <Input
              id="menu-prep"
              type="number"
              inputMode="numeric"
              min={1}
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
      </div>

      {/* Item type segmented */}
      <Field label="Item type" required error={errors.itemType}>
        <div
          role="radiogroup"
          aria-label="Item type"
          className="grid grid-cols-3 gap-2"
        >
          {ITEM_TYPES.map((t) => {
            const selected = state.itemType === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange({ itemType: t.value })}
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

      {/* Description */}
      <Field label="Description" htmlFor="menu-desc">
        <div className="relative">
          <Textarea
            id="menu-desc"
            value={state.description}
            onChange={(e) => onChange({ description: e.target.value.slice(0, 400) })}
            placeholder="Describe the dish, key ingredients, and what makes it special…"
            className="min-h-[96px] pr-16"
          />
          <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-muted-foreground">
            {state.description.length} / 400
          </span>
        </div>
      </Field>

      {/* Kitchen station + Dietary tags row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Kitchen station"
          htmlFor="menu-station"
        >
          <Select
            id="menu-station"
            value={state.stationId ?? ''}
            onChange={(e) => onChange({ stationId: e.target.value || null })}
          >
            <option value="">No station</option>
            {stations
              .filter((s) => s.isActive)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.category}
                </option>
              ))}
          </Select>
        </Field>

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
      </div>

      {/* Image */}
      <Field label="Upload photo" htmlFor="menu-image">
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/12 p-2 text-primary">
              <ImagePlus className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium">Paste an image URL</p>
              <p className="text-xs text-muted-foreground">
                JPG, PNG or WEBP hosted on your own CDN or an approved bucket. Direct
                uploads land with the next pilot slice.
              </p>
              <Input
                id="menu-image"
                type="url"
                value={state.imageUrl}
                onChange={(e) => onChange({ imageUrl: e.target.value })}
                placeholder="https://cdn.example.com/mix-kottu.webp"
                maxLength={2048}
                className="mt-1"
              />
            </div>
          </div>
        </div>
      </Field>
    </div>
  );
}

// ── Field wrapper ────────────────────────────────────────────────────────

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
