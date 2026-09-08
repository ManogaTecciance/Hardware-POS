'use client';

import * as React from 'react';
import { AlertTriangle, ImageIcon, RotateCcw, Save, Upload } from 'lucide-react';

import { availableTimeZones, DEFAULT_TIME_ZONE, timeZoneOffsetLabel } from '@hardware-pos/shared';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Toast } from '@/components/ui/toast';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { resolveImageUrl } from '@/lib/products-api';
import {
  fetchSettings,
  previewDocument,
  removeDocumentAsset,
  resetSettings,
  updateSettings,
  uploadDocumentAsset,
  type AppSettings,
  type BrandingAsset,
  type DocumentSettings,
  type PreviewDocumentType,
} from '@/lib/settings-api';

const TABS = ['Business', 'Branding', 'Layout', 'Preview'] as const;

/**
 * Every zone the runtime knows, grouped by region for a navigable `<select>`.
 *
 * The list is not curated: the API accepts any valid IANA zone, so shipping a
 * shortlist here would only make the UI narrower than the thing behind it. A
 * native select gives grouping and type-ahead for free, so 400+ entries stay
 * usable — type "col" to reach Asia/Colombo.
 */
function groupedTimeZones(): { region: string; zones: string[] }[] {
  const byRegion = new Map<string, string[]>();
  for (const tz of availableTimeZones()) {
    const region = tz.includes('/') ? tz.slice(0, tz.indexOf('/')) : 'Other';
    const list = byRegion.get(region) ?? [];
    list.push(tz);
    byRegion.set(region, list);
  }
  return [...byRegion.entries()]
    .map(([region, zones]) => ({ region, zones }))
    .sort((a, b) => a.region.localeCompare(b.region));
}
type Tab = (typeof TABS)[number];

const PREVIEW_TYPES: { value: PreviewDocumentType; label: string }[] = [
  { value: 'quotation', label: 'Quotation' },
  { value: 'invoice', label: 'Invoice / Bill' },
  { value: 'return', label: 'Return / Refund' },
  { value: 'exchange', label: 'Exchange' },
];

export default function SettingsPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.SETTINGS_MANAGE);

  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [docs, setDocs] = React.useState<DocumentSettings | null>(null);
  // Top-level, not part of `documents` — hence its own state and dirty check.
  const [timezone, setTimezone] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>('Business');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  React.useEffect(() => {
    if (!session) return;
    let active = true;
    fetchSettings(session)
      .then((s) => {
        if (!active) return;
        setSettings(s);
        setDocs(s.documents);
        setTimezone(s.timezone);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : 'Failed to load settings'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [session]);

  const dirty =
    !!settings &&
    !!docs &&
    (JSON.stringify(settings.documents) !== JSON.stringify(docs) || settings.timezone !== timezone);

  const set = <K extends keyof DocumentSettings>(key: K, value: DocumentSettings[K]) =>
    setDocs((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    if (!session || !docs) return;
    setSaving(true);
    setError(null);
    try {
      const next = await updateSettings(session, {
        documents: docs,
        ...(timezone && timezone !== settings?.timezone ? { timezone } : {}),
      });
      setSettings(next);
      setDocs(next.documents);
      setTimezone(next.timezone);
      showToast('Settings saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!session) return;
    if (!window.confirm('Reset all document settings to defaults? This cannot be undone.')) return;
    setSaving(true);
    try {
      const next = await resetSettings(session);
      setSettings(next);
      setDocs(next.documents);
      setTimezone(next.timezone);
      showToast('Settings reset to defaults');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset settings');
    } finally {
      setSaving(false);
    }
  };

  const applyServer = (next: AppSettings) => {
    setSettings(next);
    // Keep any unsaved non-asset edits; only refresh the asset URLs from server.
    setDocs((d) =>
      d
        ? {
            ...d,
            logoUrl: next.documents.logoUrl,
            signatureUrl: next.documents.signatureUrl,
            stampUrl: next.documents.stampUrl,
          }
        : next.documents,
    );
  };

  const onUpload = async (asset: BrandingAsset, file: File) => {
    if (!session) return;
    try {
      applyServer(await uploadDocumentAsset(session, asset, file));
      showToast(`${asset.charAt(0).toUpperCase()}${asset.slice(1)} uploaded`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    }
  };

  const onRemoveAsset = async (asset: BrandingAsset) => {
    if (!session) return;
    try {
      applyServer(await removeDocumentAsset(session, asset));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove image');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Documents & Printing"
          description="Business letterhead, branding and A4 template settings."
        />
        <p className="py-16 text-center text-sm text-muted-foreground">Loading settings…</p>
      </div>
    );
  }

  if (!docs) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Documents & Printing"
          description="Business letterhead, branding and A4 template settings."
        />
        <div className="flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
          <AlertTriangle className="h-4 w-4" /> {error ?? 'Could not load settings.'}
        </div>
      </div>
    );
  }

  // Settings are owner/admin territory. The nav already hides this route, so
  // reaching here means a direct URL — block the page outright rather than
  // rendering it read-only.
  if (!canManage) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" description="Business, document and printing configuration." />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <AlertTriangle className="h-6 w-6" aria-hidden />
            </span>
            <p className="text-sm font-medium text-foreground">You don’t have access to settings</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Settings are available to owners and administrators. Ask an administrator if you need
              a change made.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title="Documents & Printing"
        description="Business letterhead, branding and A4 template settings applied to every quotation, invoice, bill and return."
      />

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ' +
              (tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t}
          </button>
        ))}
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      ) : null}

      {tab === 'Business' ? (
        <BusinessTab
          docs={docs}
          set={set}
          disabled={!canManage}
          timezone={timezone ?? DEFAULT_TIME_ZONE}
          onTimezone={setTimezone}
        />
      ) : tab === 'Branding' ? (
        <BrandingTab
          docs={docs}
          set={set}
          disabled={!canManage}
          onUpload={onUpload}
          onRemove={onRemoveAsset}
        />
      ) : tab === 'Layout' ? (
        <LayoutTab docs={docs} set={set} disabled={!canManage} />
      ) : (
        <PreviewTab docs={docs} />
      )}

      {/* Sticky action bar */}
      {canManage ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur md:pl-72">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              leftIcon={<RotateCcw className="h-4 w-4" />}
              onClick={reset}
              disabled={saving}
            >
              Reset to defaults
            </Button>
            <div className="flex items-center gap-2">
              {dirty ? (
                <span className="text-xs text-muted-foreground">Unsaved changes</span>
              ) : null}
              <Button
                leftIcon={<Save className="h-4 w-4" />}
                onClick={save}
                isLoading={saving}
                disabled={!dirty}
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <Toast message={toast} className="bottom-20 z-40" /> : null}
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────

type SetFn = <K extends keyof DocumentSettings>(key: K, value: DocumentSettings[K]) => void;

function Field({
  label,
  children,
  hint,
  full,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  full?: boolean;
}) {
  return (
    <div className={'space-y-1.5' + (full ? ' sm:col-span-2' : '')}>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function BusinessTab({
  docs,
  set,
  disabled,
  timezone,
  onTimezone,
}: {
  docs: DocumentSettings;
  set: SetFn;
  disabled: boolean;
  timezone: string;
  onTimezone: (tz: string) => void;
}) {
  // Built once: 419 zones and their offsets are stable for the life of the page.
  const zoneGroups = React.useMemo(groupedTimeZones, []);
  return (
    <Card className="max-w-3xl">
      <CardContent className="grid gap-4 p-6 sm:grid-cols-2">
        <Field
          label="Timezone"
          hint="Dates on invoices, receipts and reports are stated in this zone, so a document reads the same for everyone. On-screen times follow each user's own device."
          full
        >
          <Select value={timezone} disabled={disabled} onChange={(e) => onTimezone(e.target.value)}>
            {/* A zone saved before this runtime knew it would otherwise vanish
                from the select and silently read as the first option. */}
            {zoneGroups.every((g) => !g.zones.includes(timezone)) ? (
              <option value={timezone}>{timezone}</option>
            ) : null}
            {zoneGroups.map((g) => (
              <optgroup key={g.region} label={g.region}>
                {g.zones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.includes('/') ? tz.slice(tz.indexOf('/') + 1).replace(/_/g, ' ') : tz} (
                    {timeZoneOffsetLabel(tz)})
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="Business name" hint="Falls back to your account name when blank." full>
          <Input
            value={docs.companyName ?? ''}
            disabled={disabled}
            onChange={(e) => set('companyName', e.target.value)}
            placeholder="Hardware POS"
          />
        </Field>
        <Field label="Address" full>
          <Textarea
            value={docs.addressLine ?? ''}
            disabled={disabled}
            onChange={(e) => set('addressLine', e.target.value)}
            placeholder="No. 42, Galle Road, Colombo 03"
          />
        </Field>
        <Field label="Phone">
          <Input
            value={docs.phone ?? ''}
            disabled={disabled}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="+94 11 234 5678"
          />
        </Field>
        <Field label="Email">
          <Input
            value={docs.email ?? ''}
            disabled={disabled}
            onChange={(e) => set('email', e.target.value)}
            placeholder="hello@yourshop.lk"
          />
        </Field>
        <Field label="Tax / VAT number">
          <Input
            value={docs.taxNumber ?? ''}
            disabled={disabled}
            onChange={(e) => set('taxNumber', e.target.value)}
            placeholder="134567890-7000"
          />
        </Field>
        <Field label="Footer / thank-you line" hint="Printed at the bottom of every document." full>
          <Input
            value={docs.footerText}
            disabled={disabled}
            onChange={(e) => set('footerText', e.target.value)}
          />
        </Field>
        <Field
          label="Invoice note"
          hint="Printed below the footer on invoices only — e.g. a return policy. Leave blank to hide."
          full
        >
          <Textarea
            value={docs.billNote ?? ''}
            disabled={disabled}
            rows={2}
            maxLength={500}
            onChange={(e) => set('billNote', e.target.value)}
            placeholder="Items need to be returned within 7 days with this invoice."
          />
        </Field>
      </CardContent>
    </Card>
  );
}

function AssetRow({
  label,
  url,
  asset,
  disabled,
  onUpload,
  onRemove,
}: {
  label: string;
  url: string | null;
  asset: BrandingAsset;
  disabled: boolean;
  onUpload: (asset: BrandingAsset, file: File) => void;
  onRemove: (asset: BrandingAsset) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const resolved = resolveImageUrl(url);
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border p-3">
      <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
        {resolved ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resolved} alt={label} className="h-full w-full object-contain" />
        ) : (
          <ImageIcon className="h-6 w-6 text-muted-foreground/50" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">PNG, JPG or WebP · up to 5MB</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(asset, file);
          e.target.value = '';
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          leftIcon={<Upload className="h-4 w-4" />}
          onClick={() => inputRef.current?.click()}
        >
          {resolved ? 'Replace' : 'Upload'}
        </Button>
        {resolved ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            disabled={disabled}
            onClick={() => onRemove(asset)}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function BrandingTab({
  docs,
  set,
  disabled,
  onUpload,
  onRemove,
}: {
  docs: DocumentSettings;
  set: SetFn;
  disabled: boolean;
  onUpload: (asset: BrandingAsset, file: File) => void;
  onRemove: (asset: BrandingAsset) => void;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-3 p-6">
          <AssetRow
            label="Business logo"
            url={docs.logoUrl}
            asset="logo"
            disabled={disabled}
            onUpload={onUpload}
            onRemove={onRemove}
          />
          <AssetRow
            label="Authorized signature"
            url={docs.signatureUrl}
            asset="signature"
            disabled={disabled}
            onUpload={onUpload}
            onRemove={onRemove}
          />
          <AssetRow
            label="Company stamp / seal"
            url={docs.stampUrl}
            asset="stamp"
            disabled={disabled}
            onUpload={onUpload}
            onRemove={onRemove}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-4 p-6 sm:grid-cols-2">
          <Field label="Accent colour" hint="Headings, rules and the grand-total line.">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={docs.accentColor}
                disabled={disabled}
                onChange={(e) => set('accentColor', e.target.value)}
                className="h-11 w-14 cursor-pointer rounded-xl border border-border bg-surface disabled:opacity-50"
                aria-label="Accent colour"
              />
              <Input
                value={docs.accentColor}
                disabled={disabled}
                onChange={(e) => set('accentColor', e.target.value)}
                className="font-mono"
              />
            </div>
          </Field>
          <div />
          <Field label="Logo alignment">
            <Select
              value={docs.logoAlignment}
              disabled={disabled}
              onChange={(e) =>
                set('logoAlignment', e.target.value as DocumentSettings['logoAlignment'])
              }
            >
              <option value="LEFT">Left</option>
              <option value="CENTER">Center</option>
              <option value="RIGHT">Right</option>
            </Select>
          </Field>
          <Field label="Logo size">
            <Select
              value={docs.logoSize}
              disabled={disabled}
              onChange={(e) => set('logoSize', e.target.value as DocumentSettings['logoSize'])}
            >
              <option value="SMALL">Small</option>
              <option value="MEDIUM">Medium</option>
              <option value="LARGE">Large</option>
            </Select>
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function LayoutTab({
  docs,
  set,
  disabled,
}: {
  docs: DocumentSettings;
  set: SetFn;
  disabled: boolean;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="grid gap-4 p-6 sm:grid-cols-2">
          <Field label="Margins">
            <Select
              value={docs.marginStyle}
              disabled={disabled}
              onChange={(e) =>
                set('marginStyle', e.target.value as DocumentSettings['marginStyle'])
              }
            >
              <option value="COMPACT">Compact</option>
              <option value="STANDARD">Standard</option>
              <option value="SPACIOUS">Spacious</option>
            </Select>
          </Field>
          <Field label="Paper size" hint="A4 is the default for printed documents.">
            <Select
              value={docs.defaultPaperSize}
              disabled={disabled}
              onChange={(e) =>
                set('defaultPaperSize', e.target.value as DocumentSettings['defaultPaperSize'])
              }
            >
              <option value="A4">A4 (210 × 297 mm)</option>
              <option value="THERMAL_80">Thermal 80mm</option>
            </Select>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-6">
          <div className="mb-1 text-sm font-semibold">Show on documents</div>
          <ToggleRow
            label="Product SKU column"
            checked={docs.showSku}
            disabled={disabled}
            onChange={(v) => set('showSku', v)}
          />
          <ToggleRow
            label="Discount column"
            checked={docs.showDiscountColumn}
            disabled={disabled}
            onChange={(v) => set('showDiscountColumn', v)}
          />
          <ToggleRow
            label="Tax / VAT column"
            checked={docs.showTaxColumn}
            disabled={disabled}
            onChange={(v) => set('showTaxColumn', v)}
          />
          <ToggleRow
            label="Customer tax number"
            checked={docs.showCustomerTaxNumber}
            disabled={disabled}
            onChange={(v) => set('showCustomerTaxNumber', v)}
          />
          <ToggleRow
            label="Signature area"
            hint="Authorized + customer signature lines."
            checked={docs.signatureFields}
            disabled={disabled}
            onChange={(v) => set('signatureFields', v)}
          />
          <ToggleRow
            label="Page numbers"
            hint="Print “Page X of Y” on multi-page bills."
            checked={docs.showPageNumbers}
            disabled={disabled}
            onChange={(v) => set('showPageNumbers', v)}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function PreviewTab({ docs }: { docs: DocumentSettings }) {
  const { session } = useAuth();
  const [type, setType] = React.useState<PreviewDocumentType>('quotation');
  const [lineCount, setLineCount] = React.useState(6);
  const [html, setHtml] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setErr(null);
    try {
      setHtml(await previewDocument(session, type, docs, lineCount));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
    // docs is intentionally a dependency so the preview reflects live edits.
  }, [session, type, lineCount, docs]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const openPrint = () => {
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>Document type</Label>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as PreviewDocumentType)}
            className="w-56"
          >
            {PREVIEW_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Sample rows</Label>
          <Select
            value={String(lineCount)}
            onChange={(e) => setLineCount(Number(e.target.value))}
            className="w-32"
          >
            {[3, 6, 12, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} {n >= 30 ? '(multi-page)' : ''}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="outline" onClick={refresh} isLoading={loading}>
          Refresh preview
        </Button>
        <Button variant="outline" onClick={openPrint} disabled={!html}>
          Print / Save as PDF
        </Button>
      </div>

      {err ? (
        <div className="flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-muted">
        <iframe title="Document preview" srcDoc={html} className="h-[80vh] w-full bg-white" />
      </div>
      <p className="text-xs text-muted-foreground">
        Live preview uses your unsaved changes and sample data. Rs./LKR formatting and page breaks
        match the printed document.
      </p>
    </div>
  );
}
