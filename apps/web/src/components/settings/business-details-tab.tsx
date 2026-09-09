'use client';

import { Loader2, Plus, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { uniqueKeyFromLabel } from '@/lib/products/business-detail-key';
import {
  fetchBusinessDetailsConfig,
  replaceBusinessDetails,
  type BusinessDetailsSource,
} from '@/lib/products/business-details-api';
import type { AttributeField } from '@hardware-pos/shared';

/**
 * D138 — "Business details": the fields the Add Product wizard collects.
 *
 * ## What this edits
 *
 * The wizard's Step 2 has always rendered a list declared per BUSINESS TYPE
 * (D64) — a retail shop got Material / Fit / Care instructions / Gender /
 * Season whether or not it sells clothes. This tab lets a tenant whose domain
 * allows it replace that list with its own.
 *
 * ## What this is NOT
 *
 * Not variations. A variation is a thing you sell — a Medium in Blue has its
 * own SKU, its own price and its own stock. A business detail describes the
 * product: "Material: Cotton". Nothing here is scanned, priced or depleted,
 * which is why it is settings rather than tables.
 *
 * ## Whole-list saves
 *
 * The PUT replaces the list, so the draft below is the definition and Save
 * sends all of it. Partial edits would need a row identity the operator can
 * see, and `key` — the one thing that IS the identity — is deliberately never
 * shown: it is derived from the label the first time a field is saved and then
 * frozen, because renaming it would orphan every value stored under it.
 *
 * ## Removals are refused, not cascaded
 *
 * Dropping a field that products still record, or a dropdown option they are
 * still set to, comes back 409 with the count. That refusal is the server's,
 * and it is shown verbatim: the alternative is deleting a field today and
 * discovering next week that a product will not save, with nothing on screen
 * connecting the two.
 */

/** The three types this screen offers, in the words the operator sees. */
const FIELD_TYPES: { value: AttributeField['type']; label: string; hint: string }[] = [
  { value: 'text', label: 'Text box', hint: 'Anything typed — a material, a note, a code.' },
  { value: 'enum', label: 'Dropdown', hint: 'One of a fixed list you set below.' },
  { value: 'date', label: 'Calendar date', hint: 'A day, picked from a calendar.' },
];

/**
 * A field being edited.
 *
 * `key: null` means "added here, not yet saved" — the only state in which a key
 * gets derived. Anything the server sent keeps the key the server sent.
 * `options` is always an array, even for a text field, so switching a field's
 * type back and forth does not lose what was already typed into it.
 */
interface Draft {
  key: string | null;
  label: string;
  type: AttributeField['type'];
  required: boolean;
  options: string[];
  /** Kept verbatim so a cap this screen cannot edit survives a round trip. */
  maxLength?: number;
  /** Stable across re-orders and renames; a React key must not be the index. */
  uid: string;
}

let uidCounter = 0;
const nextUid = () => `d${(uidCounter += 1)}`;

function toDraft(field: AttributeField): Draft {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required === true,
    options: field.type === 'enum' ? [...field.options] : [],
    maxLength: field.type === 'text' ? field.maxLength : undefined,
    uid: nextUid(),
  };
}

/**
 * Draft → payload.
 *
 * Keys are assigned here, against the keys already taken by the rest of the
 * list, so two new fields whose labels collapse to one key cannot collide.
 *
 * Exported for its own test: it is the one piece of this component that is a
 * pure function of the draft, and it is where a rename could turn into a
 * silent key change if anybody ever "simplified" it.
 */
export function draftsToFields(drafts: readonly Draft[]): AttributeField[] {
  const taken = new Set(drafts.map((d) => d.key).filter((k): k is string => k !== null));
  return drafts.map((d) => {
    const key = d.key ?? uniqueKeyFromLabel(d.label, taken);
    taken.add(key);
    const base = { key, label: d.label.trim(), required: d.required };
    if (d.type === 'enum') {
      return { ...base, type: 'enum' as const, options: d.options.map((o) => o.trim()) };
    }
    if (d.type === 'date') return { ...base, type: 'date' as const };
    return { ...base, type: 'text' as const, maxLength: d.maxLength };
  });
}

export function BusinessDetailsTab({ session }: { session: Session }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);

  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const [source, setSource] = React.useState<BusinessDetailsSource>('DOMAIN');
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchBusinessDetailsConfig(session)
      .then((config) => {
        if (cancelled) return;
        setDrafts(config.fields.map(toDraft));
        setSource(config.source);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load business details');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const patch = (uid: string, change: Partial<Draft>) =>
    setDrafts((cur) => cur.map((d) => (d.uid === uid ? { ...d, ...change } : d)));

  const addField = () =>
    setDrafts((cur) => [
      ...cur,
      { key: null, label: '', type: 'text', required: false, options: [], uid: nextUid() },
    ]);

  const removeField = (uid: string) => setDrafts((cur) => cur.filter((d) => d.uid !== uid));

  const save = async () => {
    if (saving) return;
    setError(null);
    setMessage(null);

    /*
     * The two checks the server would refuse anyway, done here so the operator
     * gets them beside the field instead of as a failed request. Everything
     * else — a removal that would orphan values, a duplicate key — needs the
     * database or the rest of the list, so it stays the server's answer.
     */
    if (drafts.some((d) => d.label.trim() === '')) {
      setError('Every field needs a name.');
      return;
    }
    const emptyDropdown = drafts.find(
      (d) => d.type === 'enum' && d.options.filter((o) => o.trim() !== '').length === 0,
    );
    if (emptyDropdown) {
      setError(`“${emptyDropdown.label.trim()}” is a dropdown, so it needs at least one choice.`);
      return;
    }

    setSaving(true);
    try {
      const saved = await replaceBusinessDetails(session, draftsToFields(drafts));
      setDrafts(saved.fields.map(toDraft));
      // The list is the tenant's own from this point, whatever it was before.
      setSource('TENANT');
      setMessage(
        saved.fields.length === 0
          ? 'Saved. The Add Product form now skips the business details step.'
          : 'Saved. New products collect these fields.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save business details');
    } finally {
      setSaving(false);
    }
  };

  if (status === 'loading') {
    return (
      <Card className="max-w-3xl">
        <CardContent className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading business details…
        </CardContent>
      </Card>
    );
  }
  if (status === 'error') {
    return (
      <Card className="max-w-3xl">
        <CardContent className="py-16 text-center text-sm text-danger">
          {error ?? 'Could not load business details.'}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Business details</CardTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Extra information the Add Product form collects on every product — a material, a season,
          a warranty date. These describe a product; they do not create separate items to sell. For
          sizes and colours that each have their own price and stock, use Variations.
        </p>
        {source === 'DOMAIN' ? (
          <p className="mt-2 text-xs text-muted-foreground">
            These are the suggested fields for your business type. Save any change and they become
            your own.
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5">
        {drafts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No business details. The Add Product form skips this step entirely.
          </p>
        ) : null}

        {drafts.map((draft) => {
          const labelId = `bd-label-${draft.uid}`;
          const typeId = `bd-type-${draft.uid}`;
          return (
            <div key={draft.uid} className="rounded-xl border border-border p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor={labelId}>
                    Field name
                  </label>
                  <Input
                    id={labelId}
                    value={draft.label}
                    disabled={!canManage}
                    placeholder="e.g. Material"
                    onChange={(e) => patch(draft.uid, { label: e.target.value })}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor={typeId}>
                    Type
                  </label>
                  <Select
                    id={typeId}
                    value={draft.type}
                    disabled={!canManage}
                    onChange={(e) =>
                      patch(draft.uid, { type: e.target.value as AttributeField['type'] })
                    }
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {FIELD_TYPES.find((t) => t.value === draft.type)?.hint}
                  </span>
                </div>
              </div>

              {draft.type === 'enum' ? (
                <OptionsEditor
                  options={draft.options}
                  disabled={!canManage}
                  fieldLabel={draft.label || 'this dropdown'}
                  onChange={(options) => patch(draft.uid, { options })}
                />
              ) : null}

              <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={draft.required}
                    disabled={!canManage}
                    onChange={(e) => patch(draft.uid, { required: e.target.checked })}
                  />
                  Required on every product
                </label>
                <Button
                  variant="ghost"
                  disabled={!canManage}
                  onClick={() => removeField(draft.uid)}
                  aria-label={`Remove ${draft.label || 'field'}`}
                >
                  Remove
                </Button>
              </div>
            </div>
          );
        })}

        <Button variant="outline" disabled={!canManage} onClick={addField}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add field
        </Button>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="text-sm text-success" role="status">
            {message}
          </p>
        ) : null}

        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button isLoading={saving} disabled={!canManage} onClick={() => void save()}>
            Save business details
          </Button>
          {!canManage ? (
            <span className="text-xs text-muted-foreground">
              Your role can view these but not change them.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The choices behind one dropdown field.
 *
 * Rows rather than one comma-separated box: an option may legitimately contain
 * a comma ("Wash cold, tumble dry"), and a separator that sometimes splits a
 * value is the kind of thing nobody finds until a product is mislabelled.
 */
function OptionsEditor({
  options,
  disabled,
  fieldLabel,
  onChange,
}: {
  options: string[];
  disabled: boolean;
  fieldLabel: string;
  onChange: (options: string[]) => void;
}) {
  const setAt = (index: number, value: string) =>
    onChange(options.map((o, i) => (i === index ? value : o)));

  return (
    <div className="mt-4">
      <p className="mb-1.5 text-sm font-medium">Choices</p>
      <div className="space-y-2">
        {options.map((option, index) => (
          // Index as a key is correct here and only here: an option has no id,
          // and the row IS its position in the list.
          <div key={index} className="flex items-center gap-2">
            <Input
              value={option}
              disabled={disabled}
              aria-label={`Choice ${index + 1} for ${fieldLabel}`}
              onChange={(e) => setAt(index, e.target.value)}
            />
            <Button
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove choice ${index + 1} for ${fieldLabel}`}
              onClick={() => onChange(options.filter((_, i) => i !== index))}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        className="mt-2"
        disabled={disabled}
        onClick={() => onChange([...options, ''])}
      >
        <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add choice
      </Button>
      {options.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">A dropdown needs at least one choice.</p>
      ) : null}
    </div>
  );
}
