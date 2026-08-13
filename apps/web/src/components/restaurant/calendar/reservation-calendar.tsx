'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import { fetchCustomers, type ManagedCustomer } from '@/lib/customers-api';
import { diningAreas, reservations, restaurantTables } from '@/lib/restaurant/api';
import {
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
} from '@/lib/restaurant/labels';
import type {
  DiningAreaView,
  ReservationStatus,
  ReservationView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

/**
 * Reservation calendar (D47): one service day as a booking chart — tables
 * (grouped by dining area) down the side, the day as 30-minute slots across.
 * 30 minutes is purely a rendering granularity; the API stores arbitrary
 * `[startAt, endAt)` instants.
 *
 * The day window is computed in the BROWSER's timezone and sent to the API as
 * explicit instants — the server never guesses what "Wednesday" means here.
 */

const SLOT_MINUTES = 30;
const SLOT_WIDTH_PX = 52;
const ROW_HEIGHT_PX = 48;
/** Default visible service window; auto-widened to fit any loaded booking. */
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 23;

const DURATION_OPTIONS = [30, 45, 60, 90, 120, 150, 180, 240] as const;

interface Snapshot {
  areas: DiningAreaView[];
  tablesByArea: Map<string, RestaurantTableView[]>;
  reservations: ReservationView[];
}

const EMPTY: Snapshot = { areas: [], tablesByArea: new Map(), reservations: [] };

/** Local YYYY-MM-DD for `<input type="date">` — NOT toISOString (that is UTC). */
function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(dateInput: string): Date {
  const [y = 1970, m = 1, d = 1] = dateInput.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function hourLabel(hour: number): string {
  return `${String(hour % 24).padStart(2, '0')}:00`;
}

export function ReservationCalendar({
  session,
  branchId,
  canCreate,
  canManage,
}: {
  session: Session;
  branchId: string;
  canCreate: boolean;
  canManage: boolean;
}) {
  const [dateInput, setDateInput] = React.useState(() => toDateInputValue(new Date()));
  const [showClosed, setShowClosed] = React.useState(false);
  const [state, setState] = React.useState<{
    status: 'loading' | 'ready' | 'error';
    snapshot: Snapshot;
    error?: string;
  }>({ status: 'loading', snapshot: EMPTY });

  // Pre-filled create-dialog target from a click on an empty slot.
  const [createAt, setCreateAt] = React.useState<{ tableId?: string; startAt?: Date } | null>(null);
  const [manage, setManage] = React.useState<ReservationView | null>(null);

  const dayStart = React.useMemo(() => startOfDay(dateInput), [dateInput]);
  const dayEnd = React.useMemo(() => new Date(dayStart.getTime() + 24 * 3_600_000), [dayStart]);
  const isPastDay = dayEnd.getTime() <= Date.now();
  const isToday = toDateInputValue(new Date()) === dateInput;

  const load = React.useCallback(async () => {
    try {
      const [areas, dayReservations] = await Promise.all([
        diningAreas.list(session, branchId, false),
        reservations.list(session, branchId, dayStart, dayEnd, showClosed),
      ]);
      const areaSorted = areas.slice().sort((a, b) => a.position - b.position);
      const lists = await Promise.all(
        areaSorted.map((a) => restaurantTables.list(session, a.id, false).catch(() => [])),
      );
      const tablesByArea = new Map<string, RestaurantTableView[]>();
      areaSorted.forEach((a, i) => {
        tablesByArea.set(
          a.id,
          (lists[i] ?? [])
            .slice()
            .sort((x, y) =>
              x.code.localeCompare(y.code, undefined, { numeric: true, sensitivity: 'base' }),
            ),
        );
      });
      setState({
        status: 'ready',
        snapshot: { areas: areaSorted, tablesByArea, reservations: dayReservations },
      });
    } catch (err) {
      setState({
        status: 'error',
        snapshot: EMPTY,
        error: err instanceof Error ? err.message : 'Failed to load the calendar',
      });
    }
  }, [session, branchId, dayStart, dayEnd, showClosed]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const shiftDay = (days: number) => {
    const next = new Date(dayStart);
    next.setDate(next.getDate() + days);
    setDateInput(toDateInputValue(next));
  };

  // Visible window: the default service hours, widened to fit every booking
  // loaded for the day so nothing can render off-chart.
  const { firstHour, lastHour } = React.useMemo(() => {
    let first = DEFAULT_FIRST_HOUR;
    let last = DEFAULT_LAST_HOUR;
    for (const r of state.snapshot.reservations) {
      const s = new Date(r.startAt);
      const e = new Date(r.endAt);
      if (s >= dayStart) first = Math.min(first, s.getHours());
      if (e <= dayEnd) last = Math.max(last, Math.min(24, e.getHours() + (e.getMinutes() > 0 ? 1 : 0)));
    }
    return { firstHour: first, lastHour: last };
  }, [state.snapshot.reservations, dayStart, dayEnd]);

  const windowStart = React.useMemo(
    () => new Date(dayStart.getTime() + firstHour * 3_600_000),
    [dayStart, firstHour],
  );
  const windowMinutes = (lastHour - firstHour) * 60;
  const slotCount = windowMinutes / SLOT_MINUTES;
  const trackWidth = slotCount * SLOT_WIDTH_PX;

  const byTable = React.useMemo(() => {
    const map = new Map<string, ReservationView[]>();
    for (const r of state.snapshot.reservations) {
      const list = map.get(r.tableId) ?? [];
      list.push(r);
      map.set(r.tableId, list);
    }
    return map;
  }, [state.snapshot.reservations]);

  const allTables = React.useMemo(
    () => [...state.snapshot.tablesByArea.values()].flat(),
    [state.snapshot.tablesByArea],
  );

  const onTrackClick = (table: RestaurantTableView, e: React.MouseEvent<HTMLDivElement>) => {
    if (!canCreate || isPastDay) return;
    // Ignore clicks that bubbled from a reservation block — those open manage.
    if ((e.target as HTMLElement).closest('[data-reservation]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = ((e.clientX - rect.left) / SLOT_WIDTH_PX) * SLOT_MINUTES;
    const snapped = Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES;
    setCreateAt({ tableId: table.id, startAt: new Date(windowStart.getTime() + snapped * 60_000) });
  };

  const nowOffsetPx = isToday
    ? ((Date.now() - windowStart.getTime()) / 60_000 / SLOT_MINUTES) * SLOT_WIDTH_PX
    : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous day" onClick={() => shiftDay(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input
            type="date"
            value={dateInput}
            onChange={(e) => e.target.value && setDateInput(e.target.value)}
            className="w-44"
            aria-label="Calendar date"
          />
          <Button variant="ghost" size="icon" aria-label="Next day" onClick={() => shiftDay(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={() => setDateInput(toDateInputValue(new Date()))}
            disabled={isToday}
          >
            Today
          </Button>
        </div>
        <label className="ml-2 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Show cancelled / no-show
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          {canCreate && !isPastDay ? (
            <Button onClick={() => setCreateAt({})}>
              <Plus className="mr-1.5 h-4 w-4" /> New reservation
            </Button>
          ) : null}
        </div>
      </div>

      {isPastDay ? (
        <p className="text-sm text-muted-foreground">
          Viewing a past day — reservation history is read-only.
        </p>
      ) : null}

      {state.status === 'error' ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-6 text-sm">
            <span className="text-danger">{state.error}</span>
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : state.status === 'loading' ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading the day…
          </CardContent>
        </Card>
      ) : allTables.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No tables yet — add dining areas and tables on the Tables page first.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <div style={{ minWidth: trackWidth + 176 }}>
                {/* Time header */}
                <div className="flex border-b border-border bg-surface-muted/50">
                  <div className="w-44 shrink-0 border-r border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                    Table
                  </div>
                  <div className="relative" style={{ width: trackWidth }}>
                    <div className="flex">
                      {Array.from({ length: lastHour - firstHour }, (_, i) => (
                        <div
                          key={i}
                          className="border-r border-border py-2 text-center text-xs text-muted-foreground"
                          style={{ width: SLOT_WIDTH_PX * (60 / SLOT_MINUTES) }}
                        >
                          {hourLabel(firstHour + i)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {state.snapshot.areas.map((area) => {
                  const tables = state.snapshot.tablesByArea.get(area.id) ?? [];
                  if (tables.length === 0) return null;
                  return (
                    <React.Fragment key={area.id}>
                      <div className="border-b border-border bg-surface-muted/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {area.name}
                      </div>
                      {tables.map((table) => (
                        <div key={table.id} className="flex border-b border-border last:border-b-0">
                          <div
                            className="flex w-44 shrink-0 items-center gap-2 border-r border-border px-3"
                            style={{ height: ROW_HEIGHT_PX }}
                          >
                            <span className="text-sm font-medium">{table.label ?? table.code}</span>
                            <span className="text-xs text-muted-foreground">·  {table.capacity} seats</span>
                          </div>
                          {/* Booking track */}
                          <div
                            className={
                              'relative ' +
                              (canCreate && !isPastDay ? 'cursor-pointer hover:bg-surface-muted/40' : '')
                            }
                            style={{
                              width: trackWidth,
                              height: ROW_HEIGHT_PX,
                              backgroundImage:
                                'repeating-linear-gradient(to right, transparent, transparent ' +
                                (SLOT_WIDTH_PX - 1) +
                                'px, var(--sem-border-subtle, rgba(128,128,128,0.15)) ' +
                                (SLOT_WIDTH_PX - 1) +
                                'px, var(--sem-border-subtle, rgba(128,128,128,0.15)) ' +
                                SLOT_WIDTH_PX +
                                'px)',
                            }}
                            role={canCreate && !isPastDay ? 'button' : undefined}
                            aria-label={
                              canCreate && !isPastDay
                                ? `Book ${table.label ?? table.code} — click a timeslot`
                                : undefined
                            }
                            onClick={(e) => onTrackClick(table, e)}
                          >
                            {nowOffsetPx !== null && nowOffsetPx >= 0 && nowOffsetPx <= trackWidth ? (
                              <div
                                aria-hidden
                                className="absolute bottom-0 top-0 z-10 w-0.5 bg-danger/70"
                                style={{ left: nowOffsetPx }}
                              />
                            ) : null}
                            {(byTable.get(table.id) ?? []).map((r) => (
                              <ReservationBlock
                                key={r.id}
                                reservation={r}
                                windowStart={windowStart}
                                windowMinutes={windowMinutes}
                                trackWidth={trackWidth}
                                onOpen={() => setManage(r)}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {createAt ? (
        <ReservationFormDialog
          session={session}
          branchId={branchId}
          tables={allTables}
          areas={state.snapshot.areas}
          defaultDate={dateInput}
          initialTableId={createAt.tableId}
          initialStartAt={createAt.startAt}
          onClose={() => setCreateAt(null)}
          onSaved={async () => {
            setCreateAt(null);
            await load();
          }}
        />
      ) : null}

      {manage ? (
        <ManageReservationDialog
          session={session}
          branchId={branchId}
          reservation={manage}
          tables={allTables}
          areas={state.snapshot.areas}
          canManage={canManage}
          onClose={() => setManage(null)}
          onChanged={async () => {
            setManage(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const BLOCK_TONES: Record<ReservationStatus, string> = {
  BOOKED: 'border-info/60 bg-info/15 text-foreground',
  SEATED: 'border-success/60 bg-success/15 text-foreground',
  COMPLETED: 'border-border bg-surface-muted text-muted-foreground',
  CANCELLED: 'border-border bg-surface-muted/60 text-muted-foreground line-through',
  NO_SHOW: 'border-danger/50 bg-danger/10 text-muted-foreground',
};

function ReservationBlock({
  reservation,
  windowStart,
  windowMinutes,
  trackWidth,
  onOpen,
}: {
  reservation: ReservationView;
  windowStart: Date;
  windowMinutes: number;
  trackWidth: number;
  onOpen: () => void;
}) {
  const startMin = (new Date(reservation.startAt).getTime() - windowStart.getTime()) / 60_000;
  const endMin = (new Date(reservation.endAt).getTime() - windowStart.getTime()) / 60_000;
  const left = Math.max(0, (startMin / windowMinutes) * trackWidth);
  const right = Math.min(trackWidth, (endMin / windowMinutes) * trackWidth);
  if (right <= 0 || left >= trackWidth) return null;

  return (
    <button
      type="button"
      data-reservation
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={`${reservation.reservationNumber} — ${reservation.customerName}, ${reservation.partySize} pax, ${formatTime(reservation.startAt)}–${formatTime(reservation.endAt)}`}
      className={
        'absolute top-1.5 z-20 flex h-[calc(100%-12px)] items-center gap-1.5 overflow-hidden rounded-lg border px-2 text-left text-xs font-medium shadow-sm transition-shadow hover:shadow-md ' +
        BLOCK_TONES[reservation.status]
      }
      style={{ left, width: Math.max(right - left, 44) }}
    >
      <span className="truncate">{reservation.customerName}</span>
      <span className="shrink-0 text-[10px] opacity-70">{reservation.partySize}p</span>
    </button>
  );
}

// ── Create / edit dialog ────────────────────────────────────────────────────

function ReservationFormDialog({
  session,
  branchId,
  tables,
  areas,
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
  // it (and snapshot its name/phone); free-text stays the default path.
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

  const startAt = React.useMemo(() => new Date(`${date}T${time}`), [date, time]);
  const party = Number(partySize);
  const valid =
    !!tableId &&
    customerName.trim().length > 0 &&
    Number.isInteger(party) &&
    party >= 1 &&
    !Number.isNaN(startAt.getTime());

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        tableId,
        customerId: customerId ?? undefined,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim() || undefined,
        partySize: party,
        startAt: startAt.toISOString(),
        durationMinutes: Number(duration),
        notes: notes.trim() || undefined,
      };
      if (existing) {
        await reservations.update(session, existing.id, body);
      } else {
        await reservations.create(session, branchId, body);
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
                    if (c.phone) setCustomerPhone(c.phone);
                    setCustomerQuery('');
                    setMatches([]);
                  }}
                >
                  <span>{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.phone ?? ''}</span>
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
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Nimal Perera"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="0771234567"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Time</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} step={300} />
          </div>
          <div className="space-y-1.5">
            <Label>Duration</Label>
            <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
              {DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60}${m % 60 ? '.5' : ''} h`}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Party size</Label>
            <Input
              type="number"
              min={1}
              value={partySize}
              onChange={(e) => setPartySize(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Window seat, birthday cake at 8…"
          />
        </div>
      </div>
    </Dialog>
  );
}

// ── Manage dialog ───────────────────────────────────────────────────────────

function ManageReservationDialog({
  session,
  branchId,
  reservation,
  tables,
  areas,
  canManage,
  onClose,
  onChanged,
}: {
  session: Session;
  branchId: string;
  reservation: ReservationView;
  tables: RestaurantTableView[];
  areas: DiningAreaView[];
  canManage: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const table = tables.find((t) => t.id === reservation.tableId);
  const isActive = reservation.status === 'BOOKED' || reservation.status === 'SEATED';

  const transition = async (status: ReservationStatus) => {
    if (busy) return;
    setBusy(status);
    setError(null);
    try {
      await reservations.setStatus(session, reservation.id, status);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the reservation');
      setBusy(null);
    }
  };

  if (editing) {
    return (
      <ReservationFormDialog
        session={session}
        branchId={branchId}
        tables={tables}
        areas={areas}
        defaultDate={toDateInputValue(new Date(reservation.startAt))}
        existing={reservation}
        onClose={() => setEditing(false)}
        onSaved={onChanged}
      />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${reservation.reservationNumber} — ${reservation.customerName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={!!busy}>
            Close
          </Button>
          {canManage && isActive ? (
            <Button variant="outline" onClick={() => setEditing(true)} disabled={!!busy}>
              Edit
            </Button>
          ) : null}
          {canManage && reservation.status === 'BOOKED' ? (
            <Button onClick={() => void transition('SEATED')} isLoading={busy === 'SEATED'}>
              Seat guests
            </Button>
          ) : null}
          {canManage && reservation.status === 'SEATED' ? (
            <Button onClick={() => void transition('COMPLETED')} isLoading={busy === 'COMPLETED'}>
              Complete
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error ? <p className="text-danger">{error}</p> : null}
        <div className="flex items-center gap-2">
          <StatusBadge
            label={RESERVATION_STATUS_LABELS[reservation.status]}
            tone={RESERVATION_STATUS_TONES[reservation.status]}
          />
          <span className="text-muted-foreground">
            {new Date(reservation.startAt).toLocaleDateString('en-GB', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
            })}{' '}
            · {formatTime(reservation.startAt)}–{formatTime(reservation.endAt)}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Table</dt>
          <dd>{table ? (table.label ?? table.code) : reservation.tableId}</dd>
          <dt className="text-muted-foreground">Party size</dt>
          <dd>{reservation.partySize}</dd>
          <dt className="text-muted-foreground">Phone</dt>
          <dd>{reservation.customerPhone ?? '—'}</dd>
          {reservation.notes ? (
            <>
              <dt className="text-muted-foreground">Notes</dt>
              <dd>{reservation.notes}</dd>
            </>
          ) : null}
        </dl>
        {canManage && isActive ? (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {reservation.status === 'BOOKED' ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void transition('NO_SHOW')}
                  isLoading={busy === 'NO_SHOW'}
                >
                  No-show
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-danger"
                  onClick={() => void transition('CANCELLED')}
                  isLoading={busy === 'CANCELLED'}
                >
                  Cancel reservation
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void transition('BOOKED')}
                isLoading={busy === 'BOOKED'}
              >
                Un-seat (back to booked)
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
