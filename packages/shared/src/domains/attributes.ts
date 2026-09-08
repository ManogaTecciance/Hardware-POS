/**
 * Domain catalogue attributes (convergence plan §4.6, D64 — Phase 7).
 *
 * The rule that decides where a field lives:
 *
 * > Behaviour goes in columns. Description goes in `attributes`.
 *
 * If the ENGINE must branch on a field — inventory depletion, pricing, tax,
 * settlement — it is a typed column and adding one is a migration with a
 * decision record. If only the domain UI and reports read it, it is a
 * validated key in `Product.attributes`, declared here per domain, so a new
 * vertical's catalogue fields need no migration, no wizard code and no DTO
 * change.
 *
 * One declarative field list drives BOTH the wizard rendering and the
 * server-side validation — a single authority, so the form and the refusal
 * cannot drift apart. Values are SCALARS only: a key that wants structure is
 * a key that wants to become a column (promotion is additive and easy;
 * demotion is not).
 */

interface AttributeFieldBase {
  /** JSON key in `Product.attributes`. Stable — reports address it. */
  readonly key: string;
  /** Human label the wizard renders. */
  readonly label: string;
  /** Required at CREATE and on every full replace. Default false. */
  readonly required?: boolean;
}

export type AttributeField =
  | (AttributeFieldBase & { readonly type: 'text'; readonly maxLength?: number })
  | (AttributeFieldBase & {
      readonly type: 'integer' | 'number';
      readonly min?: number;
      readonly max?: number;
    })
  | (AttributeFieldBase & { readonly type: 'boolean' })
  | (AttributeFieldBase & { readonly type: 'enum'; readonly options: readonly string[] });

export interface AttributeValidationIssue {
  /** The offending key, or '' when the payload itself is malformed. */
  readonly key: string;
  readonly message: string;
}

/**
 * Validate a full attributes document against a domain's schema.
 *
 * Replace semantics, deliberately: the payload IS the document. An optional
 * key is cleared by omitting it, never by sending `null` — one way to say
 * "absent" keeps every reader's null-handling trivial.
 *
 * Unknown keys are refused even when the schema is empty: a domain that
 * declares no attributes has said "this vertical has none", and silently
 * storing unvalidated keys would grow exactly the schemaless sprawl the
 * column exists to prevent.
 */
export function validateAttributes(
  schema: readonly AttributeField[],
  value: unknown,
): AttributeValidationIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ key: '', message: 'Attributes must be an object of key → value.' }];
  }
  const issues: AttributeValidationIssue[] = [];
  const byKey = new Map(schema.map((f) => [f.key, f]));

  for (const key of Object.keys(value)) {
    if (!byKey.has(key)) {
      issues.push({ key, message: `Unknown attribute "${key}" for this business type.` });
    }
  }

  for (const field of schema) {
    const present = Object.prototype.hasOwnProperty.call(value, field.key);
    const raw = present ? (value as Record<string, unknown>)[field.key] : undefined;
    if (!present) {
      if (field.required) issues.push({ key: field.key, message: `${field.label} is required.` });
      continue;
    }
    const issue = validateValue(field, raw);
    if (issue) issues.push({ key: field.key, message: issue });
  }
  return issues;
}

function validateValue(field: AttributeField, raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return `${field.label}: omit the key to clear it — null is not a value.`;
  }
  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string') return `${field.label} must be text.`;
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return `${field.label} is limited to ${field.maxLength} characters.`;
      }
      return null;
    }
    case 'integer':
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return `${field.label} must be a number.`;
      }
      if (field.type === 'integer' && !Number.isInteger(raw)) {
        return `${field.label} must be a whole number.`;
      }
      if (field.min !== undefined && raw < field.min) {
        return `${field.label} must be at least ${field.min}.`;
      }
      if (field.max !== undefined && raw > field.max) {
        return `${field.label} must be at most ${field.max}.`;
      }
      return null;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? null : `${field.label} must be true or false.`;
    case 'enum':
      return typeof raw === 'string' && field.options.includes(raw)
        ? null
        : `${field.label} must be one of: ${field.options.join(', ')}.`;
  }
}

/**
 * Coerce a query-string filter value (`?attr.bedCount=2`) into the field's
 * typed value, so `/products/sellable` can filter on stored JSON with the
 * same types the validator admitted. Returns an error message instead of
 * guessing when the text cannot be the field's type.
 */
export function coerceAttributeQueryValue(
  field: AttributeField,
  raw: string,
): { ok: true; value: string | number | boolean } | { ok: false; message: string } {
  switch (field.type) {
    case 'text':
      return { ok: true, value: raw };
    case 'enum':
      return field.options.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, message: `${field.label} must be one of: ${field.options.join(', ')}.` };
    case 'boolean':
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, message: `${field.label} filter must be true or false.` };
    case 'integer':
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n) || raw.trim() === '') {
        return { ok: false, message: `${field.label} filter must be a number.` };
      }
      if (field.type === 'integer' && !Number.isInteger(n)) {
        return { ok: false, message: `${field.label} filter must be a whole number.` };
      }
      return { ok: true, value: n };
    }
  }
}
