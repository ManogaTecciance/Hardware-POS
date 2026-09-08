'use client';

import { AlertTriangle, Phone, User } from 'lucide-react';
import * as React from 'react';

import { ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import { type Session } from '@/lib/auth';
import {
  MOBILE_MAX_CHARS,
  MOBILE_MAX_DIGITS,
  MOBILE_MIN_DIGITS,
  digitsOf,
  sanitizeMobile,
} from '@/lib/customer-mobile';
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
 * What the last completed lookup returned.
 *
 * Deliberately has no `searching` member. It used to, and because the New
 * Customer fields render only for `notFound`, every keystroke wiped the result
 * to `searching` and tore the Name input out of the DOM — then put it back
 * 250ms later. A cashier typing a number watched the form jump, and lost focus
 * and caret position each time. Whether a request is in flight is a separate
 * question from what the last one returned, so it is separate state.
 *
 * `results` holds the top matches for the cashier to pick from — the lookup
 * never decides on its own who the customer is (an auto-picked "found"
 * customer looked done while being silently wrong for shared or mistyped
 * numbers). Which row was actually picked is separate state again
 * (`selected`): a keystroke changes what the search shows, never who was
 * already chosen by hand.
 */
type State =
  | { kind: 'idle' }
  | { kind: 'results'; items: CustomerRow[] }
  | { kind: 'notFound'; phone: string };

interface CustomerRow {
  id: string;
  name: string;
  phone?: string | null;
  mobile?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

/* Mobile rules live in `lib/customer-mobile` — shared with the back-office
 * customer form so the two surfaces cannot drift apart. */

/** Matches `CreateCustomerDto.name` — @MaxLength(200) — so the form can never
 *  build a payload the server will refuse at the end of the order flow. */
const NAME_MAX = 200;
/** A single character is a slip, not a name; it makes the record unsearchable. */
const NAME_MIN = 2;

/**
 * One line the rider can read, built from the structured QBO-style address
 * columns on the customer record. Empty parts drop out; a customer with no
 * saved address yields ''.
 */
function savedAddressOf(row: CustomerRow): string {
  return [row.street, row.city, row.state, row.zip, row.country]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
}

/** Matches `CreateCustomerDto.street` — @MaxLength(300) — same reason as NAME_MAX. */
const STREET_MAX = 300;

/**
 * The till's freeform delivery address, shaped for the record's single
 * `street` column: the textarea allows newlines, a column that feeds
 * one-line displays (and QBO) should not carry them.
 */
function streetOf(address: string): string {
  return address
    .replace(/\s*\n+\s*/g, ', ')
    .trim()
    .slice(0, STREET_MAX);
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
 * hammer the API. Matches are offered as a pick-list; choosing one pins it
 * as a card with a Change affordance — the standard POS flow — and "New
 * customer" stays reachable even when matches exist, because a shared
 * family number matching the wrong person must not force a wrong record
 * onto the order.
 */
export function CustomerCapturePopup({ session, mode, onChoose, onBack }: Props) {
  const isDelivery = mode === 'THIRD_PARTY';

  const [phone, setPhone] = React.useState('');
  const [name, setName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [state, setState] = React.useState<State>({ kind: 'idle' });
  /** The row the cashier explicitly picked — see the State docblock. */
  const [selected, setSelected] = React.useState<CustomerRow | null>(null);
  /**
   * The cashier asked for the New Customer form even though matches exist —
   * right number, wrong person (a shared family phone, say).
   */
  const [composeNew, setComposeNew] = React.useState(false);
  /** A lookup is in flight. Never clears {@link state} — see its docblock. */
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  /**
   * Where this order goes when the pinned customer has a saved address:
   * the record's address, or a one-off typed for this order. The record
   * itself is never edited from here — "other" is a redirect, not a move.
   */
  const [destination, setDestination] = React.useState<'saved' | 'other'>('saved');

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
          `/customers?search=${encodeURIComponent(q)}&pageSize=5`,
          { token: session.token, tenantId: session.user.tenantId },
        );
        const items = res?.items ?? [];
        if (items.length > 0) {
          setState({ kind: 'results', items });
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
  }, [phone, session]);

  /*
   * Both messages are null while the field is untouched: a form that turns red
   * before anything has been typed reads as broken, and Skip is still a valid
   * way out of this dialog for Dine In and Takeaway.
   */
  const phoneDigits = digitsOf(phone);
  // No length policing while a customer is pinned: the field then mirrors the
  // stored record (which bulk import and QBO may have shaped differently),
  // and the rules are for numbers being typed toward a new one.
  const mobileError =
    selected || phone.trim() === ''
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

  const startNewCustomer = () => {
    // PO decision (2026-09-02): tapping "+ New customer with this number"
    // completes a half-typed number from the match already on screen — the
    // common case is a family member ordering from the same phone, and
    // retyping digits the till just displayed is wasted work. Only when it
    // is unambiguous: every listed match carries the same full number. A
    // prefix shared by different numbers stays as typed, and a complete
    // number the cashier entered is never replaced.
    if (state.kind === 'results' && mobileError) {
      const numbers = new Set(
        state.items.map((r) => (r.mobile ?? r.phone ?? '').trim()).filter(Boolean),
      );
      if (numbers.size === 1) {
        setPhone(sanitizeMobile([...numbers][0]!));
      }
    }
    setComposeNew(true);
  };

  // Unpinning keeps whatever one-off address the cashier typed — that is
  // their work; the saved-address option simply disappears with its owner.
  const unpin = () => setSelected(null);

  const selectCustomer = (row: CustomerRow) => {
    setSelected(row);
    setComposeNew(false);
    // Mirror the picked record's number into the field: the half-typed
    // prefix that surfaced the match is not the customer's number, and
    // leaving it behind kept a "needs at least 9 digits" warning on screen
    // for a number nobody was typing any more.
    const full = (row.mobile ?? row.phone ?? '').trim();
    if (full) setPhone(sanitizeMobile(full));
    // Default the chooser to the record's saved address — unless the
    // cashier already typed a destination, which outranks any default.
    setDestination(savedAddressOf(row) && !address.trim() ? 'saved' : 'other');
  };

  const savedAddr = selected ? savedAddressOf(selected) : '';
  /** The destination this order will actually use; '' while delivery still lacks one. */
  const orderAddress = !isDelivery
    ? ''
    : savedAddr && destination === 'saved'
      ? savedAddr
      : address.trim();

  const useExisting = () => {
    if (!selected) return;
    // Belt and braces with the disabled button, as in saveAndContinue: a
    // delivery order without a destination cannot leave this dialog.
    if (isDelivery && !orderAddress) return;
    // Backfill, don't overwrite: a record with no saved address adopts the
    // first delivery address used for it — otherwise a customer created
    // before addresses were captured starts every order from a blank box.
    // A record that already has one keeps it; "a different address" is a
    // per-order redirect (office today), not a change of home.
    if (isDelivery && !savedAddr) {
      void api
        .patch(
          `/customers/${selected.id}`,
          { street: streetOf(address) },
          { token: session.token, tenantId: session.user.tenantId },
        )
        .catch(() => {
          // Best-effort: a cashier without CUSTOMER_MANAGE, or a blip, must
          // not cost the order. The only loss is prefill on the next visit.
        });
    }
    onChoose({
      customerId: selected.id,
      name: selected.name,
      phone: selected.mobile ?? selected.phone ?? null,
      deliveryAddress: isDelivery ? orderAddress : undefined,
    });
  };

  const saveAndContinue = async () => {
    // Belt and braces with the disabled button: Enter-to-submit and a stale
    // click both reach here without going through it.
    if (!name.trim() || !phone.trim() || invalid || (isDelivery && !address.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<{ id: string; name: string }>(
        '/customers',
        {
          name: name.trim(),
          mobile: phone.trim(),
          customerType: 'RETAIL',
          // A delivery customer's first address becomes their saved address,
          // so the next order can prefill it. Without this the record was
          // born address-less and every later delivery started from a blank
          // box. Only at creation — picking an existing customer and editing
          // the address stays a per-order override, never a record edit.
          ...(isDelivery && address.trim() ? { street: streetOf(address) } : {}),
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
          {selected ? (
            <Button onClick={useExisting} disabled={isDelivery && !orderAddress}>
              Use customer
            </Button>
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
              onChange={(e) => {
                setPhone(sanitizeMobile(e.target.value));
                // A new number is a new search: whoever was pinned no longer
                // matches what is being typed, and neither does their prefill.
                unpin();
              }}
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

        {selected ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-success/40 bg-success-soft p-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-success">
                Customer
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium">
                <User className="h-4 w-4" /> {selected.name}
              </p>
              {(selected.mobile ?? selected.phone) ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selected.mobile ?? selected.phone}
                </p>
              ) : null}
              {/* No address here — the Deliver To chooser below owns it;
                  showing it twice confused the till. */}
            </div>
            <Button variant="ghost" size="sm" onClick={unpin}>
              Change
            </Button>
          </div>
        ) : state.kind === 'results' && !composeNew ? (
          <div className="overflow-hidden rounded-md border border-border">
            <p className="border-b border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {state.items.length === 1 ? '1 match' : `${state.items.length} matches`} — tap to
              select
            </p>
            <ul>
              {state.items.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => selectCustomer(row)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted"
                  >
                    <span className="font-medium">{row.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {row.mobile ?? row.phone ?? ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={startNewCustomer}
              className="w-full border-t border-border px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-muted"
            >
              + New customer with this number
            </button>
          </div>
        ) : null}

        {!selected &&
        (state.kind === 'notFound' || composeNew || (isDelivery && state.kind === 'idle')) ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium" htmlFor="cust-name">
                Name
              </label>
              {composeNew && state.kind === 'results' ? (
                <button
                  type="button"
                  onClick={() => setComposeNew(false)}
                  className="text-xs text-primary underline-offset-2 hover:underline"
                >
                  ← Back to matches
                </button>
              ) : null}
            </div>
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
        ) : null}

        {/*
         * Outside the notFound branch on purpose: the address belongs to the
         * order, not the customer record, so a found customer still needs one.
         * It used to live in the block above, and finding a customer unmounted
         * the field — taking the typed address with it and leaving delivery
         * orders with no destination at all.
         */}
        {/*
         * Backend gap, kept out of the cashier's face: TakeawayOrderProfile
         * has no `deliveryAddress` column yet, so the payment popup stores
         * the destination in `notes` with a `[Delivery]` prefix for the
         * pilot. A real column needs a migration, hence a decision record.
         */}
        {isDelivery && savedAddr ? (
          <div className="space-y-1.5">
            {/*
             * A chooser, not a prefilled box: mirroring the saved address
             * into an editable field duplicated it under the customer card,
             * and a one-off destination meant deleting it first. The saved
             * address stays read-only; "a different address" reveals an
             * empty box, and choosing it never edits the record.
             */}
            <p className="text-sm font-medium">Deliver to</p>
            <div
              role="radiogroup"
              aria-label="Deliver to"
              className="overflow-hidden rounded-md border border-border"
            >
              <label className="flex cursor-pointer items-start gap-2 px-3 py-2.5 text-sm hover:bg-muted">
                <input
                  type="radio"
                  name="deliver-to"
                  className="mt-0.5"
                  checked={destination === 'saved'}
                  onChange={() => setDestination('saved')}
                />
                <span>
                  <span className="block font-medium">Saved address</span>
                  <span className="block text-xs text-muted-foreground">{savedAddr}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 border-t border-border px-3 py-2.5 text-sm hover:bg-muted">
                <input
                  type="radio"
                  name="deliver-to"
                  className="mt-0.5"
                  checked={destination === 'other'}
                  onChange={() => setDestination('other')}
                />
                <span className="font-medium">A different address</span>
              </label>
            </div>
            {destination === 'other' ? (
              <textarea
                aria-label="Delivery address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, city, landmarks the rider needs"
                rows={2}
                autoFocus
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              />
            ) : null}
          </div>
        ) : isDelivery ? (
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
          </div>
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
