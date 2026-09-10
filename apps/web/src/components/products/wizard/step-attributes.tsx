'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { AttributeField } from '@hardware-pos/shared';

import type { WizardState } from './wizard-state';

/**
 * Add Product wizard — the GENERIC domain-attributes step (D64, Phase 7).
 *
 * Rendered from the tenant descriptor's `attributeSchema` — the same list the
 * server validates against — so a new vertical's catalogue fields appear here
 * with no wizard code at all. The wizard shell only mounts this step when the
 * schema is non-empty; a domain with no attributes never sees it.
 *
 * State stays RAW (input strings); `buildAttributesDocument` converts once,
 * at validate/save time, so this component owns no coercion rules.
 */
interface Props {
  state: WizardState;
  errors: Record<string, string>;
  schema: readonly AttributeField[];
  /** "Step N of M" — computed by the shell, which owns the visible step list. */
  positionLabel: string;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepAttributes({ state, errors, schema, positionLabel, onChange }: Props) {
  const setValue = (key: string, value: string) =>
    onChange({ attributes: { ...state.attributes, [key]: value } });

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          {positionLabel}
        </p>
        <h2 className="mt-1 text-lg font-semibold">Details for your business</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Extra fields your business type tracks on every product. Leave a field blank if it
          doesn&apos;t apply.
        </p>
      </div>

      {schema.map((field) => {
        const id = `attr-${field.key}`;
        const value = state.attributes[field.key] ?? '';
        const error = errors[`attr-${field.key}`];
        return (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={id}
            required={field.required}
            error={error}
          >
            {field.type === 'enum' ? (
              <Select
                id={id}
                value={value}
                onChange={(e) => setValue(field.key, e.target.value)}
                aria-invalid={!!error}
              >
                <option value="">Not set</option>
                {field.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : field.type === 'boolean' ? (
              <Select
                id={id}
                value={value}
                onChange={(e) => setValue(field.key, e.target.value)}
                aria-invalid={!!error}
              >
                <option value="">Not set</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : field.type === 'date' ? (
              /*
               * D150 -- a real date input, so the operator gets the platform's
               * own calendar and its own locale formatting.
               *
               * `type="date"` is the one control here that constrains what can
               * be typed, and it is safe to let it: its value is always
               * `YYYY-MM-DD` or empty, which is exactly what `isCalendarDate`
               * accepts, so the browser and the server cannot disagree about
               * what a date is. The server still refuses 2026-02-31 -- some
               * browsers will hand it over -- so this remains help, not
               * authority.
               */
              <Input
                id={id}
                type="date"
                value={value}
                onChange={(e) => setValue(field.key, e.target.value)}
                aria-invalid={!!error}
              />
            ) : (
              <Input
                id={id}
                // Numeric fields use inputMode rather than type="number" so a
                // half-typed value stays visible and the shared validator (not
                // the browser) words the refusal.
                inputMode={field.type === 'text' ? undefined : 'decimal'}
                value={value}
                onChange={(e) => setValue(field.key, e.target.value)}
                maxLength={field.type === 'text' ? field.maxLength : undefined}
                aria-invalid={!!error}
              />
            )}
          </Field>
        );
      })}
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
