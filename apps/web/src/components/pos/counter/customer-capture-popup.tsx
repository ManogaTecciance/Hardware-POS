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

/**
 * What the last completed lookup found.
 *
 * Deliberately has no `searching` member. It used to, and because the New
 * Customer fields render only for `notFound`, every keystroke wiped the result
 * to `searching` and tore the Name input out of the DOM — then put it back
 * 250ms later. A cashier typing a number watched the form jump, and lost focus
 * and caret position each time. Whether a request is in flight is a separate
 * question from what the last one returned, so it is separate state.
 */
type State =
  | { kind: 'idle' }
  | { kind: 'found'; id: string; name: string; phone: string | null }
  | { kind: 'notFound'; phone: string };

interface CustomerRow {
  id: string;
  name: string;
  phone?: string | null;
  mobile?: string | null;
}

/*
 * Mobile rules.
 *
 * Counted in DIGITS, not characters, so the separators the placeholder invites
 * ("+94 77 123 4567") do not eat the allowance. Nine is the shortest real
 * local number once a leading 0 is dropped; fifteen is the E.164 ceiling, so
 * an international number entered in full still fits. The server caps `mobile`
 * at 40 characters, which the 24-character input cap stays inside.
 */
const MOBILE_MIN_DIGITS = 9;
const MOBILE_MAX_DIGITS = 15;
const MOBILE_MAX_CHARS = 24;

/** Matches `CreateCustomerDto.name` — @MaxLength(200) — so the form can never
 *  build a payload the server will refuse at the end of the order flow. */
const NAME_MAX = 200;
/** A single character is a slip, not a name; it makes the record unsearchable. */
const NAME_MIN = 2;

/**
 * Keep what a phone number is made of and drop the rest as it is typed.
 *
 * Filtering on entry rather than validating after the fact: `inputMode="tel"`
 * is only a soft-keyboard hint, so on a desktop till every letter went
 * straight through to the customer record. A cashier who pastes "077 123 4567
 * (home)" gets the number, not an error they have to go back and fix.
 *
 * `+` survives only in first position, where it means a country code; anywhere
 * else it is a typo.
 */
function sanitizeMobile(raw: string): string {
  const kept = raw.replace(/[^\d+\s-]/g, '');
  const plus = kept.startsWith('+') ? '+' : '';
  return (plus + kept.replace(/\+/g, '')).slice(0, MOBILE_MAX_CHARS);
}

/** Just the digits, which is what the length rules are about. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
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
  /** A lookup is in flight. Never clears {@link state} — see its docblock. */
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Debounced search on the phone field.
  React.useEffect(() => {
    const q = phone.trim();
    if (q.length < 3) {
      // Too short to look anything up, so there is no result to keep.
      setState({ kind: 'idle' });
      setSearching(false);
      return;
    }
    setSearching(true);
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
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      // The debounce was cancelled by another keystroke, so nothing is in
      // flight — but the previous result stays on screen until the next one
      // lands, which is what keeps the Name field mounted.
      setSearching(false);
    };
    // Intentionally not including `name` — we only want to auto-fill on the
    // debounced tick, not every keystroke of the name field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, session]);

  /*
   * Both messages are null while the field is untouched: a form that turns red
   * before anything has been typed reads as broken, and Skip is still a valid
   * way out of this dialog for Dine In and Takeaway.
   */
  const phoneDigits = digitsOf(phone);
  const mobileError =
    phone.trim() === ''
      ? null
      : phoneDigits.length < MOBILE_MIN_DIGITS
        ? `Mobile number needs at least ${MOBILE_MIN_DIGITS} digits.`
        : phoneDigits.length > MOBILE_MAX_DIGITS
          ? `Mobile number cannot be more than ${MOBILE_MAX_DIGITS} digits.`
          : null;

  const trimmedName = name.trim();
  const nameError =
    trimmedName === ''
      ? null
      : trimmedName.length < NAME_MIN
        ? `Name needs at least ${NAME_MIN} characters.`
        : trimmedName.length > NAME_MAX
          ? `Name cannot be longer than ${NAME_MAX} characters.`
          : null;

  const invalid = !!mobileError || !!nameError;

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
    // Belt and braces with the disabled button: Enter-to-submit and a stale
    // click both reach here without going through it.
    if (!name.trim() || !phone.trim() || invalid) return;
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
              disabled={
                !name.trim() || !phone.trim() || invalid || (isDelivery && !address.trim())
              }
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
              // Filtered on entry — see `sanitizeMobile`. `inputMode` only
              // suggests a keypad; it never stopped a desktop till from
              // typing letters straight into the customer record.
              onChange={(e) => setPhone(sanitizeMobile(e.target.value))}
              placeholder="+94 77 123 4567"
              autoFocus
              className="pl-9"
              inputMode="tel"
              maxLength={MOBILE_MAX_CHARS}
              aria-invalid={mobileError ? true : undefined}
              aria-describedby={mobileError ? 'cust-phone-error' : undefined}
            />
            {searching ? (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                Searching…
              </span>
            ) : null}
          </div>
          {mobileError ? (
            <p id="cust-phone-error" className="text-xs text-danger" role="alert">
              {mobileError}
            </p>
          ) : null}
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
                maxLength={NAME_MAX}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'cust-name-error' : undefined}
              />
              {nameError ? (
                <p id="cust-name-error" className="text-xs text-danger" role="alert">
                  {nameError}
                </p>
              ) : null}
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
