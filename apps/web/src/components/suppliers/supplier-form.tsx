'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { Session } from '@/lib/auth';
import { createSupplier, updateSupplier } from '@/lib/suppliers/suppliers-api';
import type { Supplier, SupplierInput } from '@/lib/suppliers/types';

/**
 * Vendor form — exactly the QuickBooks Online Vendor fields (the same columns
 * as the vendor import template), nothing else.
 */

interface FormState {
  name: string;
  company: string;
  email: string;
  phone: string;
  mobile: string;
  fax: string;
  website: string;
  street: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  openingBalance: string;
  openingBalanceDate: string;
  taxId: string;
  isActive: boolean;
}

function initialState(s?: Supplier): FormState {
  return {
    name: s?.name ?? '',
    company: s?.company ?? '',
    email: s?.email ?? '',
    phone: s?.phone ?? '',
    mobile: s?.mobile ?? '',
    fax: s?.fax ?? '',
    website: s?.website ?? '',
    street: s?.street ?? '',
    city: s?.city ?? '',
    province: s?.province ?? '',
    postalCode: s?.postalCode ?? '',
    country: s?.country ?? '',
    openingBalance: s?.openingBalance != null ? String(s.openingBalance) : '',
    openingBalanceDate: s?.openingBalanceDate ? s.openingBalanceDate.slice(0, 10) : '',
    taxId: s?.taxId ?? '',
    isActive: s?.isActive ?? true,
  };
}

export function buildSupplierInput(form: FormState): SupplierInput {
  return {
    name: form.name.trim(),
    company: form.company.trim() || null,
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    mobile: form.mobile.trim() || null,
    fax: form.fax.trim() || null,
    website: form.website.trim() || null,
    street: form.street.trim() || null,
    city: form.city.trim() || null,
    province: form.province.trim() || null,
    postalCode: form.postalCode.trim() || null,
    country: form.country.trim() || null,
    openingBalance: form.openingBalance.trim() !== '' ? Number(form.openingBalance) : null,
    openingBalanceDate: form.openingBalanceDate || null,
    taxId: form.taxId.trim() || null,
    isActive: form.isActive,
  };
}

export function SupplierForm({ session, supplier }: { session: Session; supplier?: Supplier }) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => initialState(supplier));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const openingBalanceInvalid =
    form.openingBalance.trim() !== '' && !Number.isFinite(Number(form.openingBalance));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || openingBalanceInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const input = buildSupplierInput(form);
      const saved = supplier
        ? await updateSupplier(session, supplier.id, input)
        : await createSupplier(session, input);
      router.replace(`/suppliers/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the vendor.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Vendor</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required htmlFor="sup-name" hint="The vendor's display name in QuickBooks — must be unique.">
            <Input
              id="sup-name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label="Company" htmlFor="sup-company">
            <Input id="sup-company" value={form.company} onChange={(e) => set('company', e.target.value)} maxLength={200} />
          </Field>
          <Field label="Email" htmlFor="sup-email">
            <Input id="sup-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={200} />
          </Field>
          <Field label="Website" htmlFor="sup-website">
            <Input id="sup-website" value={form.website} onChange={(e) => set('website', e.target.value)} maxLength={300} placeholder="http://…" />
          </Field>
          <Field label="Phone" htmlFor="sup-phone">
            <Input id="sup-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} />
          </Field>
          <Field label="Mobile" htmlFor="sup-mobile">
            <Input id="sup-mobile" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} maxLength={40} />
          </Field>
          <Field label="Fax" htmlFor="sup-fax">
            <Input id="sup-fax" value={form.fax} onChange={(e) => set('fax', e.target.value)} maxLength={40} />
          </Field>
          <Field label="Tax ID number" htmlFor="sup-taxid">
            <Input id="sup-taxid" value={form.taxId} onChange={(e) => set('taxId', e.target.value)} maxLength={60} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Address</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Street" htmlFor="sup-street" className="sm:col-span-2">
            <Input id="sup-street" value={form.street} onChange={(e) => set('street', e.target.value)} maxLength={300} />
          </Field>
          <Field label="City" htmlFor="sup-city">
            <Input id="sup-city" value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={100} />
          </Field>
          <Field label="Province / Region / State" htmlFor="sup-province">
            <Input id="sup-province" value={form.province} onChange={(e) => set('province', e.target.value)} maxLength={100} />
          </Field>
          <Field label="Postal code" htmlFor="sup-postal">
            <Input id="sup-postal" value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} maxLength={40} />
          </Field>
          <Field label="Country" htmlFor="sup-country">
            <Input id="sup-country" value={form.country} onChange={(e) => set('country', e.target.value)} maxLength={100} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Opening balance</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Opening balance"
            htmlFor="sup-balance"
            hint="As entered when the vendor was added — QuickBooks tracks the live payable balance."
            error={openingBalanceInvalid ? 'Must be a number' : undefined}
          >
            <Input
              id="sup-balance"
              inputMode="decimal"
              value={form.openingBalance}
              onChange={(e) => set('openingBalance', e.target.value)}
            />
          </Field>
          <Field label="As of date" htmlFor="sup-balance-date">
            <Input
              id="sup-balance-date"
              type="date"
              value={form.openingBalanceDate}
              onChange={(e) => set('openingBalanceDate', e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div>
            <div className="text-sm font-medium">Active</div>
            <p className="text-xs text-muted-foreground">
              Inactive vendors are kept for history but hidden from day-to-day lists.
            </p>
          </div>
          <Switch checked={form.isActive} onCheckedChange={(v) => set('isActive', v)} aria-label="Active" />
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !form.name.trim() || openingBalanceInvalid} isLoading={busy}>
          {supplier ? 'Save changes' : 'Create vendor'}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </Label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
