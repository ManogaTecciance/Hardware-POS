'use client';

/**
 * D125 Part 3 (`5.4`) and Phase 5 `5.8` — the barcode prefix and label geometry.
 *
 * ## Why this lives here and not on the Settings page
 *
 * `settings-tabs.render.test.tsx` asserts an exact tab set and was
 * mutation-proven against the page itself (D90). Adding an eighth tab would
 * mean editing that assertion to accommodate new work, which D16 forbids. These
 * two settings also belong next to the barcode audit in practice: the prefix is
 * what allocation refuses without, and the geometry is what the labels come out
 * as.
 *
 * ## The sequencing constraint, said out loud
 *
 * D125 adopts as binding that the prefix is configured BEFORE any allocation,
 * or the tenant reprints every label. The form says so, because a warning after
 * the fact is worth nothing.
 */

import * as React from 'react';
import { AlertTriangle, Save } from 'lucide-react';
import { ean13PrefixIssue } from '@hardware-pos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { Session } from '@/lib/auth';
import {
  fetchSettings,
  updateSettings,
  type CatalogueSettings,
  type LabelSettings,
} from '@/lib/settings-api';

interface Props {
  session: Session;
  canManage: boolean;
  onSaved: (message: string, ok: boolean) => void;
}

export function CatalogueSettingsCard({ session, canManage, onSaved }: Props) {
  const [settings, setSettings] = React.useState<CatalogueSettings | null>(null);
  const [prefix, setPrefix] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void fetchSettings(session)
      .then((all) => {
        if (cancelled) return;
        setSettings(all.catalogue);
        setPrefix(all.catalogue.barcodePrefix ?? '');
      })
      .catch((err: Error) => onSaved(err.message, false));
    return () => {
      cancelled = true;
    };
    // `onSaved` is a stable callback from the page; re-running on it would
    // refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const prefixIssue = prefix.trim() === '' ? null : ean13PrefixIssue(prefix.trim());
  const alreadyAllocating = (settings?.barcodePrefix ?? null) !== null;

  function setLabel<K extends keyof LabelSettings>(key: K, value: LabelSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, label: { ...prev.label, [key]: value } } : prev));
  }

  async function save() {
    if (!settings || prefixIssue) return;
    setSaving(true);
    try {
      const updated = await updateSettings(session, {
        catalogue: {
          barcodePrefix: prefix.trim() === '' ? null : prefix.trim(),
          label: settings.label,
        },
      });
      setSettings(updated.catalogue);
      onSaved('Barcode and label settings saved.', true);
    } catch (err) {
      onSaved((err as Error).message, false);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <Card>
      <CardContent className="space-y-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Barcode and label setup</h2>
          <p className="text-xs text-muted-foreground">
            Barcodes cannot be generated until a prefix is set.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="barcode-prefix">In-store barcode prefix</Label>
          <Input
            id="barcode-prefix"
            className="max-w-[12rem] font-mono"
            placeholder="2001"
            value={prefix}
            disabled={!canManage}
            onChange={(e) => setPrefix(e.target.value)}
          />
          {prefixIssue ? (
            <p className="flex items-center gap-1 text-xs text-danger">
              <AlertTriangle className="h-3 w-3" aria-hidden /> {prefixIssue}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              2 to 6 digits starting 02 or 20-29 — the range GS1 reserves for a shop&apos;s own
              codes, so it can never collide with a manufacturer barcode.
            </p>
          )}
          {alreadyAllocating ? (
            <p className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Barcodes have already been issued under this prefix. Changing it now means every label
              already printed carries a code from the old range.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Label sheet</Label>
          <div className="grid gap-3 sm:grid-cols-4">
            <NumberField
              label="Width (mm)"
              value={settings.label.widthMm}
              disabled={!canManage}
              onChange={(v) => setLabel('widthMm', v)}
            />
            <NumberField
              label="Height (mm)"
              value={settings.label.heightMm}
              disabled={!canManage}
              onChange={(v) => setLabel('heightMm', v)}
            />
            <NumberField
              label="Columns"
              value={settings.label.columns}
              disabled={!canManage}
              onChange={(v) => setLabel('columns', v)}
            />
            <NumberField
              label="Rows"
              value={settings.label.rows}
              disabled={!canManage}
              onChange={(v) => setLabel('rows', v)}
            />
            <NumberField
              label="Top margin (mm)"
              value={settings.label.marginTopMm}
              disabled={!canManage}
              onChange={(v) => setLabel('marginTopMm', v)}
            />
            <NumberField
              label="Left margin (mm)"
              value={settings.label.marginLeftMm}
              disabled={!canManage}
              onChange={(v) => setLabel('marginLeftMm', v)}
            />
            <NumberField
              label="Column gap (mm)"
              value={settings.label.gapXMm}
              disabled={!canManage}
              onChange={(v) => setLabel('gapXMm', v)}
            />
            <NumberField
              label="Row gap (mm)"
              value={settings.label.gapYMm}
              disabled={!canManage}
              onChange={(v) => setLabel('gapYMm', v)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="label-symbology">Symbology</Label>
            <Select
              id="label-symbology"
              className="max-w-[14rem]"
              value={settings.label.symbology}
              disabled={!canManage}
              onChange={(e) => setLabel('symbology', e.target.value as LabelSettings['symbology'])}
            >
              <option value="EAN13">EAN-13 (prints the barcode)</option>
              <option value="CODE128">Code 128 (prints the SKU)</option>
            </Select>
            <p className="text-xs text-muted-foreground">
              EAN-13 draws the variant&apos;s barcode; Code 128 draws its SKU, which every variant
              always has.
            </p>
          </div>

          <div className="space-y-2">
            <Label>What each label shows</Label>
            <ToggleRow
              label="Product name"
              checked={settings.label.showProductName}
              disabled={!canManage}
              onChange={(v) => setLabel('showProductName', v)}
            />
            <ToggleRow
              label="Size / colour"
              checked={settings.label.showVariantOptions}
              disabled={!canManage}
              onChange={(v) => setLabel('showVariantOptions', v)}
            />
            <ToggleRow
              label="Price"
              checked={settings.label.showPrice}
              disabled={!canManage}
              onChange={(v) => setLabel('showPrice', v)}
            />
            <ToggleRow
              label="SKU"
              checked={settings.label.showSku}
              disabled={!canManage}
              onChange={(v) => setLabel('showSku', v)}
            />
          </div>
        </div>

        {canManage ? (
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={saving || prefixIssue !== null}>
              <Save className="mr-2 h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          // NaN would render an empty box and then persist as null. Ignoring
          // the keystroke keeps the previous value visible instead.
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      {/* The label is a sibling, not a wrapper, so the control needs its own
          accessible name — a bare switch reads as "button" to a screen reader. */}
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}
