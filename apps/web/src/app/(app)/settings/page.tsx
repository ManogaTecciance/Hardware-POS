'use client';

import Link from 'next/link';
import * as React from 'react';
import { AlertTriangle, ImageIcon, RotateCcw, Save, Upload } from 'lucide-react';

import { availableTimeZones, DEFAULT_TIME_ZONE, timeZoneOffsetLabel } from '@hardware-pos/shared';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Toast } from '@/components/ui/toast';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { BillPreviewTab } from '@/components/settings/bill-preview-tab';
import { BusinessDetailsTab } from '@/components/settings/business-details-tab';
import { BillStructureCard } from '@/components/settings/bill-structure-card';
import { ChargesTab } from '@/components/settings/charges-tab';
import { HoursTab } from '@/components/settings/hours-tab';
import { WorkspaceTab } from '@/components/settings/workspace-tab';
import { Permission } from '@/lib/permissions';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { resolveImageUrl } from '@/lib/products-api';
import {
  resolveDocumentSettingsPresentation,
  type DocumentSettingsPresentation,
} from '@/lib/settings/document-presentation';
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

/*
 * D84 — "Charges" is restaurant-only: it edits RestaurantBranchConfig, which
 * a retail tenant has no row in. Appended rather than inserted so a bookmark
 * on any existing tab still lands where it did.
 *
 * D90 — "Hours" likewise: it edits the branch's opening hours, which only a
 * food-service tenant has. Appended for the same reason.
 *
 * D150 — "Business details" is retail-only for now, and appended for the
 * third time for the third time's reason: a bookmark on any existing tab
 * still lands where it did.
 */
const TABS = [
  'Business',
  'Branding',
  'Layout',
  'Preview',
  'Charges',
  'Hours',
  'Workspace',
  'Business details',
] as const;

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

/**
 * D96 — Charges and Hours edit `RestaurantBranchConfig`, a row a retail tenant
 * has none of. They were appended unconditionally by D84/D90, so a Tile Shop
 * owner has been shown two tabs that answer "Feature not available" — verified
 * live. The resolver decides now.
 */
const FOOD_SERVICE_ONLY_TABS: readonly Tab[] = ['Charges', 'Hours'];

/**
 * D150 — the tab is shown only where the business type offers the feature.
 *
 * A SECOND list rather than a member of the one above, because they are
 * different questions with different answers: Charges and Hours ask whether a
 * branch config row exists, this asks whether the catalogue may be redefined.
 * Folding them together would make the next tab that needs a gate inherit the
 * wrong answer, which is the drift D96 was written to correct.
 */
const CONFIGURABLE_CATALOGUE_TABS: readonly Tab[] = ['Business details'];

/*
 * D90 — tabs that write their OWN record and carry their own Save button, plus
 * (D95) the read-only Workspace tab, which owns no record at all.
 *
 * The sticky bar below saves the document profile. On these tabs it saves
 * something the operator is not looking at, and — worse — it is fixed to the
 * bottom of the viewport, so it sat on top of the Save button that does apply
 * to what they just edited. Two Save buttons, the visible one wrong.
 */
// D150 — Business details writes `TenantSettings`, not the document profile.
const SELF_SAVING_TABS: readonly Tab[] = [
  'Charges',
  'Hours',
  'Workspace',
  'Business details',
];

const PREVIEW_TYPES: { value: PreviewDocumentType; label: string }[] = [
  { value: 'quotation', label: 'Quotation' },
  { value: 'invoice', label: 'Invoice / Bill' },
  { value: 'return', label: 'Return / Refund' },
  { value: 'exchange', label: 'Exchange' },
];

export default function SettingsPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.SETTINGS_MANAGE);
  const confirm = useConfirm();
  /*
   * D96 — one resolver call, one prop. Every tab below reads flags; none of
   * them compares a capability, a business type or an inventory mode, which is
   * what the contract test enforces.
   */
  const { profile } = useEffectiveProfile();
  const view = resolveDocumentSettingsPresentation({
    capabilities: profile?.capabilities ?? null,
  });

  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [docs, setDocs] = React.useState<DocumentSettings | null>(null);
  // Top-level, not part of `documents` — hence its own state and dirty check.
  const [timezone, setTimezone] = React.useState<string | null>(null);
  /*
   * 3.15 (D122) — the tenant-wide tax rate.
   *
   * Like the timezone it is a SIBLING of `documents` on AppSettings, not a
   * member of it, so it cannot ride on `docs`/`set` and needs its own state,
   * its own contribution to `dirty`, and its own key in the PUT body.
   *
   * Held as the raw string the operator typed, not a number: a controlled
   * number input cannot represent "cleared" or a half-typed "18." without
   * fighting the person using it. Parsed and bounds-checked once, at save.
   */
  const [taxRate, setTaxRate] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('Business');
  /*
   * D96 — the restaurant-only tabs appear only where their record exists.
   * While the profile is unresolved they are hidden, which is the safe way
   * round: a tab that vanishes a moment after appearing is worse than one that
   * appears a moment late.
   */
  const visibleTabs = React.useMemo(
    () =>
      TABS.filter(
        (t) =>
          (!FOOD_SERVICE_ONLY_TABS.includes(t) || view.showRestaurantOperationsTabs) &&
          (!CONFIGURABLE_CATALOGUE_TABS.includes(t) || view.showBusinessDetailsTab),
      ),
    [view.showRestaurantOperationsTabs, view.showBusinessDetailsTab],
  );
  /*
   * …and a tab that disappears under the operator must not leave the screen
   * blank. This runs when the profile resolves, not on every render.
   */
  React.useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab('Business');
  }, [visibleTabs, tab]);
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
        setTaxRate(String(s.taxRatePercent));
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : 'Failed to load settings'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [session]);

  /*
   * Mirrors the server's own bounds (`@Min(0) @Max(100)` on UpdateSettingsDto),
   * so the field refuses locally what the API would refuse anyway. The server
   * stays the authority — this only saves a round trip (D31).
   */
  const taxRateNumber = Number(taxRate);
  const taxRateValid =
    taxRate.trim() !== '' &&
    Number.isFinite(taxRateNumber) &&
    taxRateNumber >= 0 &&
    taxRateNumber <= 100;
  /*
   * An INVALID entry counts as dirty on purpose: it keeps Save enabled so the
   * click can explain what is wrong, instead of a dead button and no reason.
   */
  const taxRateDirty = !!settings && (!taxRateValid || taxRateNumber !== settings.taxRatePercent);
  const documentsDirty =
    !!settings && !!docs && JSON.stringify(settings.documents) !== JSON.stringify(docs);
  // The timezone is top-level too (main), so it is its own term rather than a
  // member of the `documents` comparison.
  const timezoneDirty = !!settings && !!docs && settings.timezone !== timezone;
  const dirty = documentsDirty || timezoneDirty || taxRateDirty;

  const set = <K extends keyof DocumentSettings>(key: K, value: DocumentSettings[K]) =>
    setDocs((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    if (!session || !docs) return;
    if (!taxRateValid) {
      setError('Tax rate must be a number between 0 and 100.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await updateSettings(session, {
        documents: docs,
        ...(timezone && timezone !== settings?.timezone ? { timezone } : {}),
        taxRatePercent: taxRateNumber,
      });
      setSettings(next);
      setDocs(next.documents);
      setTimezone(next.timezone);
      setTaxRate(String(next.taxRatePercent));
      showToast('Settings saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!session) return;
    // D145 — the app's own confirm, awaited: the guard is the same one
    // `window.confirm` gave, and nothing below it runs until it answers.
    if (
      !(await confirm({
        title: 'Reset all document settings to defaults?',
        message: 'This cannot be undone.',
        confirmLabel: 'Reset',
        tone: 'danger',
      }))
    )
      return;
    setSaving(true);
    try {
      const next = await resetSettings(session);
      setSettings(next);
      setDocs(next.documents);
      // The reset endpoint returns the whole record, so re-read the timezone and
      // the rate from it rather than leaving stale values in fields nobody touched.
      setTimezone(next.timezone);
      setTaxRate(String(next.taxRatePercent));
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
      {/* D95 — the "Workspace configuration" link that used to sit here is now
          the Workspace tab below, at the PO's request. The /settings/business
          route survives as a bookmarkable shell. */}
      <PageHeader title="Documents & Printing" description={view.headerDescription} />

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {visibleTabs.map((t) => (
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
          view={view}
          taxRate={taxRate}
          taxRateValid={taxRateValid}
          onTaxRateChange={setTaxRate}
        />
      ) : tab === 'Branding' ? (
        <BrandingTab
          docs={docs}
          set={set}
          disabled={!canManage}
          onUpload={onUpload}
          onRemove={onRemoveAsset}
          view={view}
        />
      ) : tab === 'Layout' ? (
        <LayoutTab docs={docs} set={set} disabled={!canManage} view={view} />
      ) : tab === 'Charges' ? (
        /*
         * D84 — its own save button, and deliberately outside the sticky bar
         * below: that bar saves the DOCUMENT profile, and the charges live on
         * a different row with its own optimistic-concurrency version. One
         * button writing two unrelated records is how a stale version
         * silently clobbers somebody's edit.
         */
        session?.branchId ? (
          <ChargesTab session={session} branchId={session.branchId} />
        ) : (
          <Card className="max-w-3xl">
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              Charges are set per branch. Ask an administrator for branch access.
            </CardContent>
          </Card>
        )
      ) : tab === 'Hours' ? (
        /*
         * D90 — its own save button, and per branch, for the same reason the
         * charges tab has one: a different row with a different lifetime.
         */
        session?.branchId ? (
          <HoursTab session={session} branchId={session.branchId} />
        ) : (
          <Card className="max-w-3xl">
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              Opening hours are set per branch. Ask an administrator for branch access.
            </CardContent>
          </Card>
        )
      ) : tab === 'Business details' ? (
        /*
         * D150 — its own save button, for the same reason Charges has one: it
         * writes `TenantSettings.data.catalogue`, which the sticky document bar
         * below knows nothing about. Unlike Charges it needs no branch — the
         * fields a business tracks are the same in every one of its shops, so
         * the only thing guarded here is the session itself, which this page
         * carries as nullable throughout.
         */
        session ? (
          <BusinessDetailsTab session={session} />
        ) : (
          <Card className="max-w-3xl">
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              Sign in to change the fields your products record.
            </CardContent>
          </Card>
        )
      ) : tab === 'Workspace' ? (
        // D95 — read-only, and therefore outside the document save bar.
        <WorkspaceTab />
      ) : view.previewKind === 'THERMAL_BILL' ? (
        // D96 — the bill itself, rendered from the template the till prints.
        <BillPreviewTab
          docs={docs}
          set={set}
          showCalibration={view.showBillCalibration}
          timezone={timezone ?? DEFAULT_TIME_ZONE}
          sampleKind={view.billSampleKind ?? 'FOOD_SERVICE'}
        />
      ) : view.previewKind === 'THERMAL_BILL_AND_A4' ? (
        /*
         * D152 — retail prints both, so it previews both. The bill comes
         * first: it is the document that goes to a customer on every single
         * sale, where a quotation is occasional.
         */
        <div className="space-y-6">
          <BillPreviewTab
            docs={docs}
            set={set}
            showCalibration={view.showBillCalibration}
            timezone={timezone ?? DEFAULT_TIME_ZONE}
            sampleKind={view.billSampleKind ?? 'FOOD_SERVICE'}
          />
          <PreviewTab docs={docs} showA4SaleDocument={view.showA4SaleDocument} />
        </div>
      ) : view.previewKind === 'SERVER_A4' ? (
        <PreviewTab docs={docs} showA4SaleDocument={view.showA4SaleDocument} />
      ) : (
        /*
         * Unresolved. Neither preview is right yet, and guessing means flashing
         * quotation chrome at a restaurant or a thermal slip at a Tile Shop.
         */
        <Card className="max-w-3xl">
          <CardContent className="py-16 text-center text-sm text-muted-foreground" role="status">
            Checking this workspace’s configuration…
          </CardContent>
        </Card>
      )}

      {/* Sticky action bar for the DOCUMENT profile. The left inset
          compensates for the sidebar rail, which only appears from `tab:`
          (900) up — below that the sidebar is a drawer and the bar spans the
          full width. Hidden on tabs that save their own record (D90). */}
      {canManage && !SELF_SAVING_TABS.includes(tab) ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 px-4 py-3 pb-safe backdrop-blur tab:pl-72">
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
  view,
  taxRate,
  taxRateValid,
  onTaxRateChange,
}: {
  docs: DocumentSettings;
  set: SetFn;
  disabled: boolean;
  timezone: string;
  onTimezone: (tz: string) => void;
  view: DocumentSettingsPresentation;
  taxRate: string;
  taxRateValid: boolean;
  onTaxRateChange: (value: string) => void;
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
        {/*
          3.15 (D122) — the tenant-wide tax rate.

          Until now `taxRatePercent` was writable only through the API, so an
          owner could mark one shirt exempt in the wizard but never set the rate
          everything else is charged at. It sits beside the VAT number an
          operator already comes to this tab for.

          Shown on EVERY template, ungated. Food service reads this rate too —
          `table-sessions` resolves `RestaurantBranchConfig.taxRatePercent ??
          AppSettings.taxRatePercent`, so this field is their EFFECTIVE rate
          today (that override has no DTO, no UI and no rows) and their fallback
          if it is ever wired up. Either way a food-service owner needs it as
          much as a retail one, and a business-type conditional here is the
          scattered comparison D56 exists to end. Precision added in 3.16: the
          first version of this comment called it "the very same" field, which
          overstated it.

          `disabled` is the same SETTINGS_MANAGE flag every other field on this
          tab uses, so a Cashier reads it and cannot dirty it. The server
          refuses the write regardless; this is usability, not authority (D31).
        */}
        <Field
          label="Tax rate (%)"
          hint="Charged on every product whose Taxable switch is on. 0 means no tax."
        >
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="0.01"
            value={taxRate}
            disabled={disabled}
            aria-label="Tax rate (%)"
            aria-invalid={!taxRateValid}
            onChange={(e) => onTaxRateChange(e.target.value)}
          />
          {taxRateValid ? null : (
            <p className="text-xs font-medium text-danger">Enter a number between 0 and 100.</p>
          )}
        </Field>
        <Field label="Footer / thank-you line" hint="Printed at the bottom of every document." full>
          <Input
            value={docs.footerText}
            disabled={disabled}
            onChange={(e) => set('footerText', e.target.value)}
          />
        </Field>
        {/* D96 — a restaurant has no invoice, and the note prints ABOVE the
            footer on a bill, not below it. The retail wording is untouched
            (D16); the resolver supplies the right one for each. */}
        <Field label={view.billNoteLabel} hint={view.billNoteHint} full>
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
  view,
}: {
  docs: DocumentSettings;
  set: SetFn;
  disabled: boolean;
  onUpload: (asset: BrandingAsset, file: File) => void;
  onRemove: (asset: BrandingAsset) => void;
  view: DocumentSettingsPresentation;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-3 p-6">
          <AssetRow label="Business logo" url={docs.logoUrl} asset="logo" disabled={disabled} onUpload={onUpload} onRemove={onRemove} />
          {/* D96 — a signature block and a rubber stamp are properties of an A4
              document. A bill has neither, so a workspace that prints bills is
              not offered them. */}
          {view.showSignatureAsset ? (
            <AssetRow label="Authorized signature" url={docs.signatureUrl} asset="signature" disabled={disabled} onUpload={onUpload} onRemove={onRemove} />
          ) : null}
          {view.showStampAsset ? (
            <AssetRow label="Company stamp / seal" url={docs.stampUrl} asset="stamp" disabled={disabled} onUpload={onUpload} onRemove={onRemove} />
          ) : null}
          {view.brandingNote ? (
            <p className="pt-1 text-xs text-muted-foreground">{view.brandingNote}</p>
          ) : null}
        </CardContent>
      </Card>
      {/* D96 — accent colour and logo placement style an A4 document. A bill is
          black on white with the logo hard-centred, so neither reaches it. */}
      {view.showAccentColor || view.showLogoPlacement ? (
      <Card>
        <CardContent className="grid gap-4 p-6 sm:grid-cols-2">
          {view.showAccentColor ? (
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
          ) : null}
          <div />
          {view.showLogoPlacement ? (
          <>
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
          </>
          ) : null}
        </CardContent>
      </Card>
      ) : null}
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
  view,
}: {
  docs: DocumentSettings;
  set: SetFn;
  disabled: boolean;
  view: DocumentSettingsPresentation;
}) {
  /*
   * D96 — a workspace that prints bills gets a read-only summary of what the
   * slip contains. Not because the A4 controls are unwanted, but because not
   * one of them can reach a thermal bill: its columns are fixed, its totals
   * rows appear when they are non-zero, and a continuous roll has no page to
   * lay out.
   *
   * D152 — and the two are no longer mutually exclusive. This was an early
   * RETURN, because every workspace that printed a bill printed ONLY a bill.
   * Retail broke that: its sale is a slip and its quotation is a letterhead,
   * so it needs the summary AND the page controls, and an early return would
   * have silently taken the quotation's page size away from it.
   *
   * Each half is now guarded by its own flag, so the three surfaces read out
   * of the same code: summary only (food service), controls only (hardware,
   * general), both (retail).
   */
  const summary = view.showBillLayoutSummary ? (
    <BillStructureCard note={view.layoutNote} />
  ) : null;
  if (!view.showPageSetup) return summary;

  return (
    <div className="max-w-3xl space-y-4">
      {summary}
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

/**
 * D152 — `showA4SaleDocument` decides whether "Invoice / Bill" is offered.
 *
 * A retail workspace prints its sale on a roll now, so an A4 invoice is a
 * document it cannot produce. Previewing one is the dead control D96 was
 * written to remove — it answers a question the operator will then be unable
 * to act on. Its quotations, returns and exchanges are still A4 and stay.
 */
function PreviewTab({
  docs,
  showA4SaleDocument,
}: {
  docs: DocumentSettings;
  showA4SaleDocument: boolean;
}) {
  const { session } = useAuth();
  const types = React.useMemo(
    () => PREVIEW_TYPES.filter((t) => t.value !== 'invoice' || showA4SaleDocument),
    [showA4SaleDocument],
  );
  // 'quotation' for everyone: it is the one A4 document every surface that
  // reaches this component still issues, so the default is never filtered out.
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
          {/* D152 -- associated with its control. The label was floating, so
              the chooser had no accessible name: a screen reader announced an
              unlabelled combobox, and it could not be found by its label. */}
          <Label htmlFor="preview-document-type">Document type</Label>
          <Select
            id="preview-document-type"
            value={type}
            onChange={(e) => setType(e.target.value as PreviewDocumentType)}
            className="w-56"
          >
            {types.map((t) => (
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
