'use client';

import * as React from 'react';
import { Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ChipRow } from '@/components/ui/chip-row';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import {
  createCustomer,
  fetchCustomers,
  type ManagedCustomer,
} from '@/lib/customers-api';
import { reservations } from '@/lib/restaurant/api';
import {
  FALLBACK_HOURS,
  formatHours,
  minutesToTimeInput,
  resolveHoursForDate,
} from '@/lib/restaurant/opening-hours';
import type {
  DiningAreaView,
  OpeningHoursView,
  ReservationView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

/** Local YYYY-MM-DD for `<input type="date">` — NOT toISOString (that is UTC). */
export function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DURATION_OPTIONS = [30, 45, 60, 90, 120, 150, 180, 240] as const;

/*
 * Phone rules — the same numbers as the POS customer-capture popup, so the
 * two places a phone is typed toward a customer record police it identically.
 * Nine digits is the shortest full local number once a leading 0 is dropped;
 * fifteen is the E.164 ceiling. The reservation snapshot caps the string at
 * 32 (`CreateReservationDto`), which the 24-character input cap stays inside.
 */
const MOBILE_MIN_DIGITS = 9;
const MOBILE_MAX_DIGITS = 15;
const MOBILE_MAX_CHARS = 24;

/** `CreateReservationDto.customerName` — @Length(1, 120). */
const NAME_MAX = 120;
/** `CreateReservationDto.notes` — @MaxLength(500). */
const NOTES_MAX = 500;
/** `CreateReservationDto.partySize` — @Max(200). */
const PARTY_MAX = 200;

/**
 * Mirrors the server's PAST_GRACE_MS: a host typing in a walk-up party that
 * arrived five minutes ago is recording reality, not booking the past. The
 * client blocks what the server would refuse, with a reason, instead of
 * letting the whole form be filled and failed at submit.
 */
const PAST_GRACE_MS = 15 * 60_000;

/** The chart's rendering granularity; the time dropdown offers the same steps. */
const SLOT_STEP_MINUTES = 30;

/**
 * Booking horizon offered by the date dropdown. The chart itself pages to any
 * date; the dropdown covers the stretch a restaurant actually takes bookings
 * for, and a selected date outside it stays listed (truth outranks the menu).
 * Offering only today-forward is also what makes a past booking structurally
 * impossible to CREATE — no date to pick means no error to explain.
 */
const DATE_HORIZON_DAYS = 60;

/** Keep digits, spaces, dashes and one leading +; cap the length. */
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
 * The number a customer record answers to. POS-captured customers carry it in
 * `mobile` (that popup writes nothing else); imported/QBO ones often only in
 * `phone`. Reading `.phone` alone is how the match list used to show blank
 * rows for every customer the till had ever created.
 */
function bestNumber(c: ManagedCustomer): string | null {
  return c.mobile ?? c.phone;
}

export function ReservationFormDialog({
  session,
  branchId,
  tables,
  areas,
  hours,
  defaultDate,
  initialTableId,
  initialStartAt,
  existing,
  onClose,
  onSaved,
}: {
  session: Session;
  branchId: string;
  tables: RestaurantTableView[];
  areas: DiningAreaView[];
  /** D90 branch opening hours — bounds the time chips; null falls back. */
  hours: OpeningHoursView | null;
  defaultDate: string;
  initialTableId?: string;
  initialStartAt?: Date;
  existing?: ReservationView;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const areaName = React.useMemo(
    () => new Map(areas.map((a) => [a.id, a.name] as const)),
    [areas],
  );
  const existingDuration = existing
    ? Math.round((new Date(existing.endAt).getTime() - new Date(existing.startAt).getTime()) / 60_000)
    : null;

  const [tableId, setTableId] = React.useState(existing?.tableId ?? initialTableId ?? tables[0]?.id ?? '');
  const [customerName, setCustomerName] = React.useState(existing?.customerName ?? '');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [customerPhone, setCustomerPhone] = React.useState(existing?.customerPhone ?? '');
  const [customerId, setCustomerId] = React.useState<string | null>(existing?.customerId ?? null);
  const [partySize, setPartySize] = React.useState(existing ? String(existing.partySize) : '2');
  const [date, setDate] = React.useState(
    existing ? toDateInputValue(new Date(existing.startAt)) : initialStartAt ? toDateInputValue(initialStartAt) : defaultDate,
  );
  const [time, setTime] = React.useState(() => {
    const source = existing ? new Date(existing.startAt) : initialStartAt;
    if (!source) return '19:00';
    return `${String(source.getHours()).padStart(2, '0')}:${String(source.getMinutes()).padStart(2, '0')}`;
  });
  const [duration, setDuration] = React.useState(String(existingDuration ?? 90));
  const [notes, setNotes] = React.useState(existing?.notes ?? '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Lightweight existing-customer lookup: type ≥2 chars, pick a match to link
  // it (and snapshot its name/number); free-text stays the default path. The
  // server search matches phone/mobile digits however either was formatted.
  const [customerQuery, setCustomerQuery] = React.useState('');
  const [matches, setMatches] = React.useState<ManagedCustomer[]>([]);
  React.useEffect(() => {
    const q = customerQuery.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const page = await fetchCustomers(session, { search: q, pageSize: 6 });
        if (!cancelled) setMatches(page.items);
      } catch {
        if (!cancelled) setMatches([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [customerQuery, session]);

  const todayStr = toDateInputValue(new Date());
  const startAt = React.useMemo(() => new Date(`${date}T${time}`), [date, time]);

  const dateOptions = React.useMemo(() => {
    const opts: string[] = [];
    const cursor = new Date();
    for (let i = 0; i <= DATE_HORIZON_DAYS; i++) {
      opts.push(toDateInputValue(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    // An edited past booking, or a calendar paged beyond the horizon, keeps
    // its date listed rather than being silently shown as something else.
    if (date && !opts.includes(date)) return [date, ...opts].sort();
    return opts;
  }, [date]);

  const tomorrowStr = React.useMemo(() => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return toDateInputValue(t);
  }, []);

  /** Two chip lines: "Today"/"Tmrw"/weekday on top, "05 Sep" below. */
  const dayChipLines = (value: string): [string, string] => {
    // Noon dodges any DST boundary shifting the parsed day.
    const d = new Date(`${value}T12:00`);
    const top =
      value === todayStr
        ? 'Today'
        : value === tomorrowStr
          ? 'Tmrw'
          : d.toLocaleDateString('en-GB', { weekday: 'short' });
    return [top, d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })];
  };

  /** D90 — which hours the selected date keeps. */
  const dayHours = React.useMemo(
    () => resolveHoursForDate(hours, new Date(`${date}T12:00`)),
    [hours, date],
  );

  /*
   * The time chips: 30-minute slots INSIDE the day's opening hours — a
   * booking widget should offer what the restaurant will actually seat, not
   * a full day of times. A day marked closed still gets the fallback window
   * (same D90 stance as the chart: a shut door is a warning, not a wall).
   * On today's date the slots already gone (beyond the grace) are not
   * offered. Slots past midnight belong to the NEXT day's date, the same
   * rule the chart draws by, so the last seating is one step before close
   * capped at 23:30. The selected value always stays listed even when
   * off-step or past (an API-created booking, or an edit of one currently
   * underway) — chips that silently show a different time than the record
   * holds lie.
   */
  const timeOptions = React.useMemo(() => {
    const win = dayHours.isClosed ? FALLBACK_HOURS : dayHours;
    const firstSlot = Math.ceil(win.opensAt / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
    const lastSlot = Math.min(win.closesAt, 24 * 60) - SLOT_STEP_MINUTES;
    const all: string[] = [];
    for (let m = firstSlot; m <= lastSlot; m += SLOT_STEP_MINUTES) {
      all.push(minutesToTimeInput(m));
    }
    const cutoff = Date.now() - PAST_GRACE_MS;
    const offered =
      date === todayStr
        ? all.filter((t) => new Date(`${date}T${t}`).getTime() >= cutoff)
        : all;
    if (time && !offered.includes(time)) {
      return [...offered, time].sort();
    }
    return offered;
  }, [dayHours, date, time, todayStr]);

  const party = Number(partySize);
  const table = tables.find((t) => t.id === tableId);

  /*
   * The slot's past-check applies only when the slot MOVES — mirroring the
   * server, which lets the notes of a booking currently underway be edited
   * without rejecting the start time that is now behind us.
   */
  const slotMoved =
    !existing ||
    tableId !== existing.tableId ||
    startAt.getTime() !== new Date(existing.startAt).getTime() ||
    Number(duration) !== existingDuration;

  const trimmedName = customerName.trim();
  const nameError = nameTouched && trimmedName === '' ? 'Customer name is required.' : null;

  // No length policing while a customer is linked: the field then mirrors the
  // stored record, and the rules are for numbers typed toward a new one.
  const phoneDigits = digitsOf(customerPhone);
  const phoneError =
    customerId || customerPhone.trim() === ''
      ? null
      : phoneDigits.length < MOBILE_MIN_DIGITS
        ? `Phone number needs at least ${MOBILE_MIN_DIGITS} digits.`
        : phoneDigits.length > MOBILE_MAX_DIGITS
          ? `Phone number cannot be more than ${MOBILE_MAX_DIGITS} digits.`
          : null;

  const partyError = !Number.isInteger(party)
    ? 'Party size must be a whole number.'
    : party < 1
      ? 'At least 1 guest.'
      : party > PARTY_MAX
        ? `Maximum ${PARTY_MAX} guests.`
        : null;

  const pastError =
    slotMoved && !Number.isNaN(startAt.getTime()) && startAt.getTime() < Date.now() - PAST_GRACE_MS
      ? 'That time has already passed.'
      : null;

  /*
   * Capacity is a WARNING, not a block: parties larger than the table are
   * routinely seated on joined tables, and the server accepts them. The form
   * just makes sure nobody books 12 onto a deuce without noticing.
   */
  const capacityWarning =
    table && Number.isInteger(party) && table.capacity != null && party > table.capacity
      ? `${table.label ?? table.code} seats ${table.capacity} — a party of ${party} may not fit.`
      : null;

  const valid =
    !!tableId &&
    trimmedName.length > 0 &&
    !phoneError &&
    !partyError &&
    !pastError &&
    !Number.isNaN(startAt.getTime());

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      /*
       * PO (2026-09-03): a reservation taken with a name and phone should
       * leave a customer record behind, so the next booking finds them by
       * number. Link an exact digit match if one exists; otherwise create.
       * Strictly best-effort — a 403 (no CUSTOMER_MANAGE) or a blip must not
       * cost the booking, which proceeds unlinked.
       */
      let linkedId = customerId;
      const phoneTrimmed = customerPhone.trim();
      if (!existing && !linkedId && phoneTrimmed && !phoneError) {
        try {
          const page = await fetchCustomers(session, { search: phoneTrimmed, pageSize: 3 });
          const exact = page.items.find((c) => {
            const number = bestNumber(c);
            return number !== null && digitsOf(number) === phoneDigits;
          });
          if (exact) {
            linkedId = exact.id;
          } else {
            const created = await createCustomer(session, {
              name: trimmedName,
              mobile: phoneTrimmed,
            });
            linkedId = created.id;
          }
        } catch {
          linkedId = null;
        }
      }

      const common = {
        tableId,
        customerName: trimmedName,
        partySize: party,
        startAt: startAt.toISOString(),
        durationMinutes: Number(duration),
      };
      if (existing) {
        // Everything is sent explicitly: an emptied phone or notes field
        // CLEARS the stored value, and null customerId UNLINKS the record.
        // (`?? undefined` here made both silent no-ops — JSON drops the key.)
        await reservations.update(session, existing.id, {
          ...common,
          customerId: linkedId,
          customerPhone: phoneTrimmed,
          notes: notes.trim(),
        });
      } else {
        await reservations.create(session, branchId, {
          ...common,
          customerId: linkedId ?? undefined,
          customerPhone: phoneTrimmed || undefined,
          notes: notes.trim() || undefined,
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the reservation');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.reservationNumber}` : 'New reservation'}
      description={
        existing ? undefined : 'Book a table for a customer. The slot is held once saved.'
      }
      // Wider than the default: the date strip and the time-slot grid are the
      // point of this dialog, and at max-w-md they fold into clutter.
      className="sm:max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={saving} disabled={!valid}>
            {existing ? 'Save changes' : 'Book table'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="space-y-1.5">
          <Label>Table</Label>
          <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {(t.areaId && areaName.get(t.areaId) ? `${areaName.get(t.areaId)} — ` : '') + (t.label ?? t.code)} ({t.capacity ?? '—'} seats)
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Find existing customer (optional)</Label>
          <Input
            value={customerQuery}
            onChange={(e) => setCustomerQuery(e.target.value)}
            placeholder="Search by name or phone…"
          />
          {matches.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-border">
              {matches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-muted"
                  onClick={() => {
                    setCustomerId(c.id);
                    setCustomerName(c.name);
                    // Mirror whichever number the record actually answers to —
                    // POS-captured customers carry it in `mobile`, not `phone`.
                    const number = bestNumber(c);
                    if (number) setCustomerPhone(number);
                    setCustomerQuery('');
                    setMatches([]);
                  }}
                >
                  <span>{c.name}</span>
                  <span className="text-xs text-muted-foreground">{bestNumber(c) ?? ''}</span>
                </button>
              ))}
            </div>
          ) : null}
          {customerId ? (
            <p className="text-xs text-muted-foreground">
              Linked to customer record.{' '}
              <button type="button" className="underline" onClick={() => setCustomerId(null)}>
                Unlink
              </button>
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Customer name</Label>
            <Input
              value={customerName}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setNameTouched(true);
                setCustomerName(e.target.value);
              }}
              placeholder="Nimal Perera"
            />
            {nameError ? <p className="text-xs text-danger">{nameError}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input
              value={customerPhone}
              maxLength={MOBILE_MAX_CHARS}
              inputMode="tel"
              onChange={(e) => setCustomerPhone(sanitizeMobile(e.target.value))}
              placeholder="0771234567"
            />
            {phoneError ? <p className="text-xs text-danger">{phoneError}</p> : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Date</Label>
          <ChipRow ariaLabel="Reservation date" activeKey={date}>
            {dateOptions.map((d) => {
              const [top, bottom] = dayChipLines(d);
              const active = date === d;
              return (
                <button
                  key={d}
                  type="button"
                  data-date={d}
                  data-active={active}
                  onClick={() => setDate(d)}
                  className={`flex h-12 w-16 shrink-0 flex-col items-center justify-center rounded-xl text-xs font-medium transition-colors ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground hover:bg-border'
                  }`}
                >
                  <span className={active ? 'opacity-90' : 'text-muted-foreground'}>{top}</span>
                  <span className="text-sm font-semibold">{bottom}</span>
                </button>
              );
            })}
          </ChipRow>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label>Time</Label>
            {/* Say which window the chips come from — same D90 stance as the
                chart toolbar: hours that silently narrow look like a bug. */}
            <span className="text-xs text-muted-foreground">
              {dayHours.isClosed ? 'Closed this day' : formatHours(dayHours)}
            </span>
          </div>
          {dayHours.isClosed ? (
            <p className="text-xs font-medium text-warning">
              Marked closed this day — this books outside the opening hours.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {timeOptions.map((t) => (
              <button
                key={t}
                type="button"
                data-time={t}
                data-active={time === t}
                onClick={() => setTime(t)}
                className={`h-9 rounded-lg px-2.5 text-sm font-medium tabular-nums transition-colors ${
                  time === t
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground hover:bg-border'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Duration</Label>
            <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
              {DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {/* 90 → "1.5 h": floor the hours — `m / 60` already carries
                      the half, and dividing AND appending printed "1.5.5 h". */}
                  {m < 60 ? `${m} min` : `${Math.floor(m / 60)}${m % 60 ? '.5' : ''} h`}
                </option>
              ))}
              {existingDuration !== null && !DURATION_OPTIONS.some((m) => m === existingDuration) ? (
                // The record's actual duration outranks the menu (API-created
                // bookings can hold any 15–720 min span).
                <option value={existingDuration}>{existingDuration} min</option>
              ) : null}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Party size</Label>
            {/* Stepper first, typing still possible: hosts count heads up and
                down far more often than they type them. */}
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon"
                aria-label="Fewer guests"
                disabled={Number.isInteger(party) && party <= 1}
                onClick={() =>
                  setPartySize(String(Math.max(1, (Number.isInteger(party) ? party : 2) - 1)))
                }
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                min={1}
                max={PARTY_MAX}
                value={partySize}
                onChange={(e) => setPartySize(e.target.value)}
                className="text-center"
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="More guests"
                disabled={Number.isInteger(party) && party >= PARTY_MAX}
                onClick={() =>
                  setPartySize(String(Math.min(PARTY_MAX, (Number.isInteger(party) ? party : 1) + 1)))
                }
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
        {partyError ? <p className="text-xs text-danger">{partyError}</p> : null}
        {pastError ? <p className="text-xs text-danger">{pastError}</p> : null}
        {capacityWarning ? <p className="text-xs font-medium text-warning">{capacityWarning}</p> : null}

        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea
            rows={2}
            maxLength={NOTES_MAX}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Window seat, birthday cake at 8…"
          />
        </div>
      </div>
    </Dialog>
  );
}
