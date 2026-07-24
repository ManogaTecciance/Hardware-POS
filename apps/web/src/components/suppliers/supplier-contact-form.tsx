'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { Session } from '@/lib/auth';
import { validateContactDraft, type ContactFieldErrors } from '@/lib/suppliers/format';
import { addSupplierContact, updateSupplierContact } from '@/lib/suppliers/suppliers-api';
import {
  COMMUNICATION_LABELS,
  CONTACT_TYPE_LABELS,
  type CommunicationMethod,
  type SupplierContact,
  type SupplierContactInput,
  type SupplierContactType,
} from '@/lib/suppliers/types';
import { cn } from '@/lib/utils';

interface State {
  fullName: string;
  jobTitle: string;
  contactType: SupplierContactType;
  phone: string;
  whatsapp: string;
  email: string;
  preferredMethod: CommunicationMethod;
  isPrimary: boolean;
  isActive: boolean;
}

function initial(c?: SupplierContact): State {
  return {
    fullName: c?.fullName ?? '',
    jobTitle: c?.jobTitle ?? '',
    contactType: c?.contactType ?? 'SALES',
    phone: c?.phone ?? '',
    whatsapp: c?.whatsapp ?? '',
    email: c?.email ?? '',
    preferredMethod: c?.preferredMethod ?? 'PHONE',
    isPrimary: c?.isPrimary ?? false,
    isActive: c?.isActive ?? true,
  };
}

export function SupplierContactForm({
  open,
  session,
  supplierId,
  contact,
  onClose,
  onSaved,
}: {
  open: boolean;
  session: Session;
  supplierId: string;
  contact?: SupplierContact;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!contact;
  const [form, setForm] = React.useState<State>(() => initial(contact));
  const [errors, setErrors] = React.useState<ContactFieldErrors>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setForm(initial(contact));
      setErrors({});
      setError(null);
    }
  }, [open, contact]);

  const set = <K extends keyof State>(k: K, v: State[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const input: SupplierContactInput = {
      fullName: form.fullName.trim(),
      jobTitle: form.jobTitle.trim() || null,
      contactType: form.contactType,
      phone: form.phone.trim() || null,
      whatsapp: form.whatsapp.trim() || null,
      email: form.email.trim() || null,
      preferredMethod: form.preferredMethod,
      isPrimary: form.isPrimary,
      isActive: form.isActive,
    };
    const v = validateContactDraft(input);
    setErrors(v);
    if (v.fullName || v.contact || v.email) return;

    setBusy(true);
    setError(null);
    try {
      if (editing && contact) await updateSupplierContact(session, supplierId, contact.id, input);
      else await addSupplierContact(session, supplierId, input);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the contact.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit contact' : 'Add contact'}
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={busy}>
            {editing ? 'Save contact' : 'Add contact'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <F label="Full name" required error={errors.fullName} className="sm:col-span-2">
          <Input value={form.fullName} onChange={(e) => set('fullName', e.target.value)} aria-invalid={!!errors.fullName || undefined} />
        </F>
        <F label="Job title">
          <Input value={form.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} placeholder="Optional" />
        </F>
        <F label="Contact type">
          <Select value={form.contactType} onChange={(e) => set('contactType', e.target.value as SupplierContactType)}>
            {(Object.keys(CONTACT_TYPE_LABELS) as SupplierContactType[]).map((t) => (
              <option key={t} value={t}>
                {CONTACT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </F>
        <F label="Phone" error={errors.contact}>
          <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" aria-invalid={!!errors.contact || undefined} />
        </F>
        <F label="WhatsApp">
          <Input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} inputMode="tel" placeholder="Optional" />
        </F>
        <F label="Email" error={errors.email} className="sm:col-span-2">
          <Input value={form.email} onChange={(e) => set('email', e.target.value)} inputMode="email" aria-invalid={!!errors.email || undefined} />
        </F>
        <F label="Preferred method">
          <Select value={form.preferredMethod} onChange={(e) => set('preferredMethod', e.target.value as CommunicationMethod)}>
            {(Object.keys(COMMUNICATION_LABELS) as CommunicationMethod[]).map((m) => (
              <option key={m} value={m}>
                {COMMUNICATION_LABELS[m]}
              </option>
            ))}
          </Select>
        </F>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 sm:col-span-2">
          <span className="text-sm font-medium">Primary contact</span>
          <Switch checked={form.isPrimary} onCheckedChange={(v) => set('isPrimary', v)} aria-label="Primary contact" />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 sm:col-span-2">
          <span className="text-sm font-medium">Active</span>
          <Switch checked={form.isActive} onCheckedChange={(v) => set('isActive', v)} aria-label="Active contact" />
        </div>
        {error ? <p className="text-sm text-danger sm:col-span-2">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function F({
  label,
  required,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
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
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
