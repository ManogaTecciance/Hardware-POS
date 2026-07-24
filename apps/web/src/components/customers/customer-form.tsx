'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { Session } from '@/lib/auth';
import {
  CUSTOMER_TYPE_LABELS,
  createCustomer,
  updateCustomer,
  type CustomerInput,
  type CustomerType,
  type ManagedCustomer,
} from '@/lib/customers-api';
import { cn } from '@/lib/utils';

const TYPE_OPTIONS = Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[];

/**
 * Customer form — the QuickBooks Customer template fields (identity, address,
 * opening balance) plus the POS-side payment controls that drive credit
 * enforcement and returns rules.
 */

interface FormState {
  name: string;
  company: string;
  qbCustomerType: string;
  email: string;
  phone: string;
  mobile: string;
  fax: string;
  website: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  openingBalance: string;
  openingBalanceDate: string;
  resaleNumber: string;
  customerType: CustomerType;
  creditAllowed: boolean;
  creditLimit: string;
  isActive: boolean;
}

function initialState(c?: ManagedCustomer): FormState {
  return {
    name: c?.name ?? '',
    company: c?.company ?? '',
    qbCustomerType: c?.qbCustomerType ?? '',
    email: c?.email ?? '',
    phone: c?.phone ?? '',
    mobile: c?.mobile ?? '',
    fax: c?.fax ?? '',
    website: c?.website ?? '',
    street: c?.street ?? '',
    city: c?.city ?? '',
    state: c?.state ?? '',
    zip: c?.zip ?? '',
    country: c?.country ?? '',
    openingBalance: c?.openingBalance != null ? String(c.openingBalance) : '',
    openingBalanceDate: c?.openingBalanceDate ? c.openingBalanceDate.slice(0, 10) : '',
    resaleNumber: c?.resaleNumber ?? '',
    customerType: c?.customerType ?? 'RETAIL',
    creditAllowed: c?.creditAllowed ?? false,
    creditLimit: c?.creditLimit != null ? String(c.creditLimit) : '',
    isActive: c?.isActive ?? true,
  };
}

export function buildCustomerInput(form: FormState): CustomerInput {
  return {
    name: form.name.trim(),
    company: form.company.trim() || null,
    qbCustomerType: form.qbCustomerType.trim() || null,
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    mobile: form.mobile.trim() || null,
    fax: form.fax.trim() || null,
    website: form.website.trim() || null,
    street: form.street.trim() || null,
    city: form.city.trim() || null,
    state: form.state.trim() || null,
    zip: form.zip.trim() || null,
    country: form.country.trim() || null,
    openingBalance: form.openingBalance.trim() !== '' ? Number(form.openingBalance) : null,
    openingBalanceDate: form.openingBalanceDate || null,
    resaleNumber: form.resaleNumber.trim() || null,
    customerType: form.customerType,
    creditAllowed: form.creditAllowed,
    creditLimit:
      form.creditAllowed && form.creditLimit.trim() !== '' ? Number(form.creditLimit) : null,
    isActive: form.isActive,
  };
}

export function CustomerForm({
  session,
  customer,
}: {
  session: Session;
  customer?: ManagedCustomer;
}) {
  const router = useRouter();
  const editing = !!customer;
  const [form, setForm] = React.useState<FormState>(() => initialState(customer));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const openingBalanceInvalid =
    form.openingBalance.trim() !== '' && !Number.isFinite(Number(form.openingBalance));

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Customer name is required');
      return;
    }
    if (openingBalanceInvalid) {
      setError('Opening balance must be a number');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = buildCustomerInput(form);
      const saved =
        editing && customer
          ? await updateCustomer(session, customer.id, input)
          : await createCustomer(session, input);
      router.push(`/customers/${saved.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save customer');
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ravi Perera" />
          </Field>
          <Field label="Company">
            <Input value={form.company} onChange={(e) => set('company', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Customer type (QuickBooks)">
            <Input
              value={form.qbCustomerType}
              onChange={(e) => set('qbCustomerType', e.target.value)}
              placeholder='e.g. "Retail Trade"'
            />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="e.g. 077 123 4567" />
          </Field>
          <Field label="Mobile">
            <Input value={form.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Fax">
            <Input value={form.fax} onChange={(e) => set('fax', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Website">
            <Input value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="http://…" />
          </Field>
          <Field label="Resale number">
            <Input value={form.resaleNumber} onChange={(e) => set('resaleNumber', e.target.value)} placeholder="Optional" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Address</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Street" className="sm:col-span-2">
            <Input value={form.street} onChange={(e) => set('street', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="City">
            <Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="State / Province">
            <Input value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="ZIP / Postal code">
            <Input value={form.zip} onChange={(e) => set('zip', e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Country">
            <Input value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="Optional" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Opening balance</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Opening balance">
            <Input
              inputMode="decimal"
              value={form.openingBalance}
              onChange={(e) => set('openingBalance', e.target.value)}
              placeholder="As entered when added"
            />
          </Field>
          <Field label="As of date">
            <Input
              type="date"
              value={form.openingBalanceDate}
              onChange={(e) => set('openingBalanceDate', e.target.value)}
            />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            QuickBooks tracks the live receivable balance — this is only the balance entered when the
            customer was added.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payments &amp; credit</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="POS customer type">
            <Select
              value={form.customerType}
              onChange={(e) => set('customerType', e.target.value as CustomerType)}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {CUSTOMER_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              Drives POS behaviour (walk-in rules, credit-memo routing) — separate from the QuickBooks
              customer-type label above.
            </p>
          </Field>
          <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-3">
            <div>
              <div className="text-sm font-medium">Allow credit / pay-later</div>
              <div className="text-xs text-muted-foreground">
                Let this customer take credit and partial-payment sales.
              </div>
            </div>
            <Switch checked={form.creditAllowed} onCheckedChange={(v) => set('creditAllowed', v)} />
          </div>
          {form.creditAllowed ? (
            <Field label="Credit limit (Rs.)">
              <Input
                inputMode="decimal"
                value={form.creditLimit}
                onChange={(e) => set('creditLimit', e.target.value)}
                placeholder="Leave blank for no limit"
              />
            </Field>
          ) : null}
          <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-3">
            <div>
              <div className="text-sm font-medium">Active</div>
              <div className="text-xs text-muted-foreground">Inactive customers are hidden from the POS.</div>
            </div>
            <Switch checked={form.isActive} onCheckedChange={(v) => set('isActive', v)} />
          </div>
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button size="lg" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create customer'}
        </Button>
        <Button size="lg" variant="ghost" onClick={() => router.back()} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}
