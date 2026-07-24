'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { ChevronDown, Landmark, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import type { SupplierAccess } from '@/lib/suppliers/access';
import { hasErrors, suggestSupplierCode, validateSupplierDraft, type SupplierFieldErrors } from '@/lib/suppliers/format';
import { createSupplier, updateSupplier } from '@/lib/suppliers/suppliers-api';
import {
  COMMUNICATION_LABELS,
  SUPPLIER_STATUS_LABELS,
  type CommunicationMethod,
  type Supplier,
  type SupplierCategoryRef,
  type SupplierInput,
  type SupplierStatus,
} from '@/lib/suppliers/types';
import { cn } from '@/lib/utils';

import { SupplierCategorySelector } from './supplier-category-selector';

interface FormState {
  name: string;
  code: string;
  status: SupplierStatus;
  isPreferred: boolean;
  mainContactName: string;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  city: string;
  country: string;
  preferredCommunication: CommunicationMethod;
  // additional
  legalName: string;
  registrationNumber: string;
  vatNumber: string;
  website: string;
  defaultCurrency: string;
  paymentTerms: string;
  creditLimit: string;
  defaultLeadTimeDays: string;
  minOrderValue: string;
  internalNotes: string;
  // bank
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  branch: string;
  preferredPaymentMethod: string;
}

function initialState(s?: Supplier): FormState {
  return {
    name: s?.name ?? '',
    code: s?.code ?? '',
    status: s?.status ?? 'ACTIVE',
    isPreferred: s?.isPreferred ?? false,
    mainContactName: s?.mainContactName ?? '',
    phone: s?.phone ?? '',
    whatsapp: s?.whatsapp ?? '',
    email: s?.email ?? '',
    address: s?.address ?? '',
    city: s?.city ?? '',
    country: s?.country ?? 'Sri Lanka',
    preferredCommunication: s?.preferredCommunication ?? 'PHONE',
    legalName: s?.legalName ?? '',
    registrationNumber: s?.registrationNumber ?? '',
    vatNumber: s?.vatNumber ?? '',
    website: s?.website ?? '',
    defaultCurrency: s?.defaultCurrency ?? 'LKR',
    paymentTerms: s?.paymentTerms ?? '',
    creditLimit: s?.creditLimit != null ? String(s.creditLimit) : '',
    defaultLeadTimeDays: s?.defaultLeadTimeDays != null ? String(s.defaultLeadTimeDays) : '',
    minOrderValue: s?.minOrderValue != null ? String(s.minOrderValue) : '',
    internalNotes: s?.internalNotes ?? '',
    bankName: s?.bank?.bankName ?? '',
    accountHolder: s?.bank?.accountHolder ?? '',
    accountNumber: '',
    branch: s?.bank?.branch ?? '',
    preferredPaymentMethod: s?.bank?.preferredPaymentMethod ?? '',
  };
}

function toNum(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function buildInput(form: FormState, categories: SupplierCategoryRef[], includeBank: boolean): SupplierInput {
  const input: SupplierInput = {
    name: form.name.trim(),
    code: form.code.trim() || undefined,
    status: form.status,
    isPreferred: form.isPreferred,
    mainContactName: form.mainContactName.trim() || null,
    phone: form.phone.trim() || null,
    whatsapp: form.whatsapp.trim() || null,
    email: form.email.trim() || null,
    address: form.address.trim() || null,
    city: form.city.trim() || null,
    country: form.country.trim() || null,
    preferredCommunication: form.preferredCommunication,
    legalName: form.legalName.trim() || null,
    registrationNumber: form.registrationNumber.trim() || null,
    vatNumber: form.vatNumber.trim() || null,
    website: form.website.trim() || null,
    defaultCurrency: form.defaultCurrency.trim() || null,
    paymentTerms: form.paymentTerms.trim() || null,
    creditLimit: toNum(form.creditLimit),
    defaultLeadTimeDays: toNum(form.defaultLeadTimeDays),
    minOrderValue: toNum(form.minOrderValue),
    categoryIds: categories.map((c) => c.id),
    internalNotes: form.internalNotes.trim() || null,
  };
  if (includeBank) {
    input.bank = {
      bankName: form.bankName.trim() || null,
      accountHolder: form.accountHolder.trim() || null,
      accountNumber: form.accountNumber.trim() || null,
      branch: form.branch.trim() || null,
      preferredPaymentMethod: form.preferredPaymentMethod.trim() || null,
    };
  }
  return input;
}

export function SupplierForm({
  session,
  access,
  supplier,
  categoryOptions,
  existingCodes,
}: {
  session: Session;
  access: SupplierAccess;
  supplier?: Supplier;
  categoryOptions: SupplierCategoryRef[];
  existingCodes: string[]; // lower-cased, excluding this record
}) {
  const router = useRouter();
  const editing = !!supplier;

  const [form, setForm] = React.useState<FormState>(() => initialState(supplier));
  const [categories, setCategories] = React.useState<SupplierCategoryRef[]>(supplier?.categories ?? []);
  const [codeEdited, setCodeEdited] = React.useState(editing);
  const [showAdditional, setShowAdditional] = React.useState(false);
  const [showBank, setShowBank] = React.useState(false);
  const [bankConfirmed, setBankConfirmed] = React.useState(false);

  const [errors, setErrors] = React.useState<SupplierFieldErrors>({});
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState<null | 'save' | 'saveView'>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const fieldRefs = {
    name: React.useRef<HTMLInputElement>(null),
    code: React.useRef<HTMLInputElement>(null),
    contact: React.useRef<HTMLInputElement>(null),
    email: React.useRef<HTMLInputElement>(null),
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Auto-suggest a code from the name until the user edits it (create only).
      if (key === 'name' && !codeEdited && !editing) {
        next.code = suggestSupplierCode(String(value));
      }
      return next;
    });
    setDirty(true);
  };

  const bankChanged =
    !!form.accountNumber.trim() ||
    form.bankName.trim() !== (supplier?.bank?.bankName ?? '') ||
    form.accountHolder.trim() !== (supplier?.bank?.accountHolder ?? '') ||
    form.branch.trim() !== (supplier?.bank?.branch ?? '') ||
    form.preferredPaymentMethod.trim() !== (supplier?.bank?.preferredPaymentMethod ?? '');

  const submit = async (mode: 'save' | 'saveView') => {
    const input = buildInput(form, categories, access.canViewBank);
    const validation = validateSupplierDraft(input, existingCodes);
    setErrors(validation);
    if (hasErrors(validation)) {
      // The `contact` error is anchored on the phone input (fieldRefs.contact).
      const first = (['name', 'code', 'contact', 'email'] as const).find((k) => validation[k]);
      if (first) fieldRefs[first].current?.focus();
      return;
    }
    if (access.canViewBank && bankChanged && !bankConfirmed) {
      setSaveError('Please confirm the bank details are correct before saving.');
      setShowBank(true);
      return;
    }

    setSaving(mode);
    setSaveError(null);
    try {
      const saved = editing
        ? await updateSupplier(session, supplier.id, input)
        : await createSupplier(session, input);
      setDirty(false);
      if (mode === 'saveView' || editing) {
        router.push(`/suppliers/${saved.id}`);
      } else {
        router.push('/suppliers');
      }
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the supplier.');
      setSaving(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-28">
      {/* Essential details */}
      <Card>
        <CardHeader>
          <CardTitle>Essential details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier name" required error={errors.name} className="sm:col-span-2">
            <Input
              ref={fieldRefs.name}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Ceylon Cement & Building Supplies"
              aria-invalid={!!errors.name || undefined}
              aria-describedby={errors.name ? 'err-name' : undefined}
            />
          </Field>
          <Field label="Supplier code" error={errors.code} hint="Auto-generated — edit if you have your own.">
            <Input
              ref={fieldRefs.code}
              value={form.code}
              onChange={(e) => {
                setCodeEdited(true);
                set('code', e.target.value);
              }}
              placeholder="e.g. CEY-CEM"
              aria-invalid={!!errors.code || undefined}
              aria-describedby={errors.code ? 'err-code' : undefined}
            />
          </Field>
          <Field label="Supplier status">
            <Select value={form.status} onChange={(e) => set('status', e.target.value as SupplierStatus)}>
              {(Object.keys(SUPPLIER_STATUS_LABELS) as SupplierStatus[]).map((s) => (
                <option key={s} value={s}>
                  {SUPPLIER_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Main contact name">
            <Input
              value={form.mainContactName}
              onChange={(e) => set('mainContactName', e.target.value)}
              placeholder="e.g. Nimal Fernando"
            />
          </Field>
          <Field label="Phone" error={errors.contact}>
            <Input
              ref={fieldRefs.contact}
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="e.g. 011 234 5678"
              inputMode="tel"
              aria-invalid={!!errors.contact || undefined}
              aria-describedby={errors.contact ? 'err-contact' : undefined}
            />
          </Field>
          <Field label="WhatsApp number">
            <Input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} placeholder="Optional" inputMode="tel" />
          </Field>
          <Field label="Email" error={errors.email}>
            <Input
              ref={fieldRefs.email}
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="e.g. sales@supplier.lk"
              inputMode="email"
              aria-invalid={!!errors.email || undefined}
              aria-describedby={errors.email ? 'err-email' : undefined}
            />
          </Field>
          <Field label="City">
            <Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="e.g. Colombo" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea value={form.address} onChange={(e) => set('address', e.target.value)} rows={2} placeholder="Optional" />
          </Field>
          <Field label="Country">
            <Input value={form.country} onChange={(e) => set('country', e.target.value)} />
          </Field>
          <Field label="Preferred communication">
            <Select
              value={form.preferredCommunication}
              onChange={(e) => set('preferredCommunication', e.target.value as CommunicationMethod)}
            >
              {(Object.keys(COMMUNICATION_LABELS) as CommunicationMethod[]).map((m) => (
                <option key={m} value={m}>
                  {COMMUNICATION_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-3 sm:col-span-2">
            <div>
              <div className="text-sm font-medium">Preferred supplier</div>
              <div className="text-xs text-muted-foreground">Highlight this supplier when purchasing.</div>
            </div>
            <Switch
              checked={form.isPreferred}
              onCheckedChange={(v) => set('isPreferred', v)}
              aria-label="Preferred supplier"
            />
          </div>
        </CardContent>
      </Card>

      {/* Additional business details */}
      <Card>
        <CollapsibleHeader
          title="Additional business details"
          open={showAdditional}
          onToggle={() => setShowAdditional((o) => !o)}
        />
        {showAdditional ? (
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Legal business name" className="sm:col-span-2">
              <Input value={form.legalName} onChange={(e) => set('legalName', e.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Business-registration number">
              <Input value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} placeholder="Optional" />
            </Field>
            <Field label="VAT / TIN">
              <Input value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Website">
              <Input value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" inputMode="url" />
            </Field>
            <Field label="Default currency">
              <Input value={form.defaultCurrency} onChange={(e) => set('defaultCurrency', e.target.value)} />
            </Field>
            <Field label="Payment terms">
              <Input value={form.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} placeholder="e.g. Net 30" />
            </Field>
            <Field label="Credit limit (Rs.)" error={errors.creditLimit}>
              <Input value={form.creditLimit} onChange={(e) => set('creditLimit', e.target.value)} inputMode="decimal" placeholder="Optional" />
            </Field>
            <Field label="Default lead time (days)">
              <Input value={form.defaultLeadTimeDays} onChange={(e) => set('defaultLeadTimeDays', e.target.value)} inputMode="numeric" placeholder="Optional" />
            </Field>
            <Field label="Minimum order value (Rs.)">
              <Input value={form.minOrderValue} onChange={(e) => set('minOrderValue', e.target.value)} inputMode="decimal" placeholder="Optional" />
            </Field>
            <Field label="Product categories supplied" className="sm:col-span-2">
              <SupplierCategorySelector options={categoryOptions} value={categories} onChange={(v) => { setCategories(v); setDirty(true); }} />
            </Field>
            <Field label="Internal notes" className="sm:col-span-2">
              <Textarea value={form.internalNotes} onChange={(e) => set('internalNotes', e.target.value)} rows={3} placeholder="Only visible to your team" />
            </Field>
          </CardContent>
        ) : null}
      </Card>

      {/* Bank & payment details — permission-gated */}
      {access.canViewBank ? (
        <Card>
          <CollapsibleHeader
            title="Bank and payment details"
            icon={Landmark}
            open={showBank}
            onToggle={() => setShowBank((o) => !o)}
            badge="Protected"
          />
          {showBank ? (
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Bank name">
                <Input value={form.bankName} onChange={(e) => set('bankName', e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="Account holder">
                <Input value={form.accountHolder} onChange={(e) => set('accountHolder', e.target.value)} placeholder="Optional" />
              </Field>
              <Field
                label="Account number"
                hint={supplier?.bank?.accountNumberMasked ? `Current: ${supplier.bank.accountNumberMasked}. Leave blank to keep it.` : undefined}
              >
                <Input
                  value={form.accountNumber}
                  onChange={(e) => set('accountNumber', e.target.value)}
                  placeholder={supplier?.bank?.accountNumberMasked ?? 'Optional'}
                  autoComplete="off"
                />
              </Field>
              <Field label="Branch">
                <Input value={form.branch} onChange={(e) => set('branch', e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="Preferred payment method" className="sm:col-span-2">
                <Input value={form.preferredPaymentMethod} onChange={(e) => set('preferredPaymentMethod', e.target.value)} placeholder="e.g. Bank transfer" />
              </Field>
              {bankChanged ? (
                <label className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm text-warning sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={bankConfirmed}
                    onChange={(e) => setBankConfirmed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[var(--sem-warning)]"
                  />
                  <span>I confirm these bank details are correct. Changes are recorded for audit.</span>
                </label>
              ) : null}
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      {/* Sticky action footer — stays within the page scroll container. */}
      <div className="sticky bottom-0 z-30 -mx-4 border-t border-border bg-surface/95 px-4 backdrop-blur md:-mx-6 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Saving…
              </>
            ) : dirty ? (
              'Unsaved changes'
            ) : editing ? (
              'All changes saved'
            ) : (
              ''
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {saveError ? <span className="text-sm text-danger">{saveError}</span> : null}
            <Button variant="ghost" onClick={() => router.back()} disabled={!!saving}>
              Cancel
            </Button>
            {editing ? (
              <Button onClick={() => submit('save')} isLoading={saving === 'save'} disabled={!!saving}>
                Save changes
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => submit('save')} isLoading={saving === 'save'} disabled={!!saving}>
                  Save supplier
                </Button>
                <Button onClick={() => submit('saveView')} isLoading={saving === 'saveView'} disabled={!!saving}>
                  Save and view profile
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const errId = error ? `err-${label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '')}` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </Label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p id={errId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CollapsibleHeader({
  title,
  open,
  onToggle,
  icon: Icon,
  badge,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-3 p-6 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-2">
        {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : null}
        <span className="text-lg font-semibold tracking-tight">{title}</span>
        {badge ? (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">{badge}</span>
        ) : null}
      </span>
      <ChevronDown className={cn('h-5 w-5 text-muted-foreground transition-transform', open && 'rotate-180')} />
    </button>
  );
}
