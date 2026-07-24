'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { Session } from '@/lib/auth';
import {
  CUSTOMER_TYPE_LABELS,
  createCustomer,
  type CustomerType,
  type ManagedCustomer,
} from '@/lib/customers-api';

const TYPE_OPTIONS = Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[];

/**
 * Compact customer create from inside the POS — never leaves the checkout. On
 * success the caller selects the returned customer in the cart.
 */
export function QuickAddCustomerDialog({
  open,
  session,
  onClose,
  onCreated,
}: {
  open: boolean;
  session: Session;
  onClose: () => void;
  onCreated: (customer: ManagedCustomer) => void;
}) {
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [customerType, setCustomerType] = React.useState<CustomerType>('RETAIL');
  const [email, setEmail] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName('');
      setPhone('');
      setCustomerType('RETAIL');
      setEmail('');
      setAddress('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createCustomer(session, {
        name: name.trim(),
        phone: phone.trim() || null,
        customerType,
        email: email.trim() || null,
        street: address.trim() || null,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add customer');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New customer"
      description="Add a customer without leaving the sale."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Add & select'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="qac-name">Name *</Label>
          <Input id="qac-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ravi Perera" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="qac-phone">Phone</Label>
            <Input id="qac-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qac-type">Type</Label>
            <Select id="qac-type" value={customerType} onChange={(e) => setCustomerType(e.target.value as CustomerType)}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {CUSTOMER_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qac-email">Email</Label>
          <Input id="qac-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qac-address">Address</Label>
          <Input id="qac-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
