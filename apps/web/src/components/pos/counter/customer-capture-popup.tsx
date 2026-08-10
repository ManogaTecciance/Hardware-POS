'use client';

import { AlertTriangle, Phone, User } from 'lucide-react';
import * as React from 'react';

import { ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import { type Session } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import type { PosMode } from '../pos-mode-selector';

export interface ChosenCustomer {
  /** Populated when the operator picked an existing tenant customer. */
  customerId?: string;
  name: string | null;
  phone: string | null;
  /** Delivery only — freeform address; stored in TakeawayOrderProfile.notes with a `[Delivery]` prefix. */
  deliveryAddress?: string;
}

interface Props {
  session: Session;
  mode: PosMode;
  onChoose: (customer: ChosenCustomer | null) => void;
  onBack: () => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; id: string; name: string; phone: string | null }
  | { kind: 'notFound'; phone: string };

interface CustomerRow {
  id: string;
  name: string;
  phone?: string | null;
  mobile?: string | null;
}

/**
 * The single popup that captures the customer between Place Order and
 * Payment.
 *
 * Behaviour by mode:
 *   - Dine In counter / Takeaway: Skip is allowed → walk-in / anonymous.
 *   - Delivery: name + phone + address are required; Skip is hidden.
 *
 * Search matches on the free-text `search` param of the existing
 * `GET /customers` endpoint, which searches name + phone + email + company
 * inside the tenant. Debounced to 250 ms so a fast-typing cashier doesn't
 * hammer the API.
 */
export function CustomerCapturePopup({ session, mode, onChoose, onBack }: Props) {
  const isDelivery = mode === 'THIRD_PARTY';

  const [phone, setPhone] = React.useState('');
  const [name, setName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [state, setState] = React.useState<State>({ kind: 'idle' });
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Debounced search on the phone field.
  React.useEffect(() => {
    const q = phone.trim();
    if (q.length < 3) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'searching' });
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ items: CustomerRow[] }>(
          `/customers?search=${encodeURIComponent(q)}&pageSize=1`,
          { token: session.token, tenantId: session.user.tenantId },
        );
        const first = res?.items?.[0];
        if (first) {
          setState({
            kind: 'found',
            id: first.id,
            name: first.name,
            phone: first.mobile ?? first.phone ?? null,
          });
          if (!name) setName(first.name);
        } else {
          setState({ kind: 'notFound', phone: q });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
        setState({ kind: 'idle' });
      }
    }, 250);
    return () => clearTimeout(t);
    // Intentionally not including `name` — we only want to auto-fill on the
    // debounced tick, not every keystroke of the name field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, session]);

  const canContinue = isDelivery
    ? !!name.trim() && !!phone.trim() && !!address.trim()
    : true; // dine-in / takeaway allows skip → walk-in

  const useExisting = () => {
    if (state.kind !== 'found') return;
    onChoose({
      customerId: state.id,
      name: state.name,
      phone: state.phone,
      deliveryAddress: isDelivery ? address.trim() || undefined : undefined,
    });
  };

  const saveAndContinue = async () => {
    if (!name.trim() || !phone.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<{ id: string; name: string }>(
        '/customers',
        {
          name: name.trim(),
          mobile: phone.trim(),
          customerType: 'RETAIL',
        },
        { token: session.token, tenantId: session.user.tenantId },
      );
      onChoose({
        customerId: created.id,
        name: created.name,
        phone: phone.trim(),
        deliveryAddress: isDelivery ? address.trim() || undefined : undefined,
      });
    } catch (err) {
      // Permission-denied likely means the cashier lacks CUSTOMER_MANAGE.
      if (err instanceof ApiError && err.status === 403) {
        setError(
          "You don't have permission to create a customer. Ask a manager, or Skip to continue as walk-in.",
        );
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create customer');
      }
      setSaving(false);
    }
  };

  const skip = () => onChoose(null);

  return (
    <Dialog
      open
      onClose={onBack}
      title="Customer details"
      description={
        isDelivery
          ? 'Delivery requires name, phone and address so the rider can reach the customer.'
          : 'Optional for Dine In and Takeaway — Skip to continue as walk-in.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          {!isDelivery ? (
            <Button variant="outline" onClick={skip}>
              Skip
            </Button>
          ) : null}
          {state.kind === 'found' ? (
            <Button onClick={useExisting}>Use customer</Button>
          ) : (
            <Button
              onClick={saveAndContinue}
              isLoading={saving}
              disabled={!name.trim() || !phone.trim() || (isDelivery && !address.trim())}
            >
              Save & Continue
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="cust-phone">
            Mobile number
          </label>
          <div className="relative">
            <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="cust-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+94 77 123 4567"
              autoFocus
              className="pl-9"
              inputMode="tel"
            />
            {state.kind === 'searching' ? (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                Searching…
              </span>
            ) : null}
          </div>
        </div>

        {state.kind === 'found' ? (
          <div className="rounded-md border border-success/40 bg-success-soft p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-success">
              Customer found
            </p>
            <p className="mt-1 flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4" /> {state.name}
            </p>
            {state.phone ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{state.phone}</p>
            ) : null}
          </div>
        ) : null}

        {(state.kind === 'notFound' || (isDelivery && state.kind !== 'found')) ? (
          <>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="cust-name">
                Name
              </label>
              <Input
                id="cust-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Customer name"
              />
            </div>
            {isDelivery ? (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="cust-address">
                  Delivery address
                </label>
                <textarea
                  id="cust-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street, city, landmarks the rider needs"
                  rows={2}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Backend gap: no `deliveryAddress` column on TakeawayOrderProfile yet.
                  Stored in `notes` with a `[Delivery]` prefix for the pilot.
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        {canContinue && !isDelivery ? (
          <p className="text-xs text-muted-foreground">
            Tip: press <kbd className="rounded border border-border px-1 text-[10px]">Enter</kbd> after
            the phone to accept the found customer or reveal the New Customer form.
          </p>
        ) : null}

        {error ? (
          <p className="flex items-center gap-1 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
