'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';

import { AreaChip } from '@/components/restaurant/area-chip';
import {
  ReservationFormDialog,
  toDateInputValue,
} from '@/components/restaurant/calendar/reservation-form-dialog';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Session } from '@/lib/auth';
import { diningAreas, openingHours, reservations, restaurantTables } from '@/lib/restaurant/api';
import {
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
} from '@/lib/restaurant/labels';
import { formatHours, resolveHoursForDate } from '@/lib/restaurant/opening-hours';
import {
  assignReservationLanes,
  type LanedReservation,
} from '@/lib/restaurant/reservation-lanes';
import type {
  DiningAreaView,
  OpeningHoursView,
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
/*
 * D90 — the visible window now comes from the branch's configured opening
 * hours (Settings → Hours), resolved per date. These two remain as the
 * last-resort fallback for a schedule that has not loaded yet, and they are
 * the same 08:00–23:00 the calendar drew before hours were configurable, so
 * an unconfigured branch is unchanged.
 */
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 23;

interface Snapshot {
  areas: DiningAreaView[];
  tablesByArea: Map<string, RestaurantTableView[]>;
  reservations: ReservationView[];
}

const EMPTY: Snapshot = { areas: [], tablesByArea: new Map(), reservations: [] };

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
  /*
   * Area filter. 'ALL' is the default and is a real selection, not the absence
   * of one — a branch with four floors wants the whole book most of the time,
   * and only narrows to work one section during service.
   *
   * It filters the CHART only. The reservation dialogs keep offering every
   * table, because "show me the terrace" is a viewing choice and must not
   * quietly become "you may only book the terrace".
   */
  const [selectedArea, setSelectedArea] = React.useState<string>('ALL');
  const [state, setState] = React.useState<{
    status: 'loading' | 'ready' | 'error';
    snapshot: Snapshot;
    error?: string;
  }>({ status: 'loading', snapshot: EMPTY });

  /*
   * D90 — the branch's opening hours. Loaded once per branch rather than per
   * day: the whole schedule (the week plus its exceptions) arrives in one
   * response, and paging through days must not re-fetch it.
   *
   * `null` means unresolved, and resolves to the default window rather than
   * to "closed" — a slow request is not a shut restaurant (D31).
   */
  const [hours, setHours] = React.useState<OpeningHoursView | null>(null);

  // Pre-filled create-dialog target from a click on an empty slot.
  const [createAt, setCreateAt] = React.useState<{ tableId?: string; startAt?: Date } | null>(null);
  const [manage, setManage] = React.useState<ReservationView | null>(null);

  const dayStart = React.useMemo(() => startOfDay(dateInput), [dateInput]);
  const dayEnd = React.useMemo(() => new Date(dayStart.getTime() + 24 * 3_600_000), [dayStart]);
  const isPastDay = dayEnd.getTime() <= Date.now();
  const isToday = toDateInputValue(new Date()) === dateInput;

  React.useEffect(() => {
    let cancelled = false;
    openingHours
      .get(session, branchId)
      // A failed hours request must not take the calendar down with it: the
      // bookings are the point, and the window falls back to the default.
      .then((next) => !cancelled && setHours(next))
      .catch(() => !cancelled && setHours(null));
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  const today = React.useMemo(() => resolveHoursForDate(hours, dayStart), [hours, dayStart]);

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

  const visibleAreas = React.useMemo(
    () =>
      selectedArea === 'ALL'
        ? state.snapshot.areas
        : state.snapshot.areas.filter((a) => a.id === selectedArea),
    [state.snapshot.areas, selectedArea],
  );

  // Rows the chart will actually draw. Separate from `allTables` because the
  // "no tables at all" empty state and the "this area is empty" one are
  // different problems with different fixes.
  const visibleTables = React.useMemo(
    () => visibleAreas.flatMap((a) => state.snapshot.tablesByArea.get(a.id) ?? []),
    [visibleAreas, state.snapshot.tablesByArea],
  );

  // Visible window: the default service hours, widened to fit every booking
  // loaded for the day so nothing can render off-chart.
  const { firstHour, lastHour } = React.useMemo(() => {
    /*
     * D90 — start from the hours configured for THIS date (override beats
     * weekday rule beats default), then widen as before. A closed day still
     * gets a window: its bookings are drawn, because hiding a reservation
     * because the door is shut loses a guest who is going to turn up anyway.
     */
    let first = today.isClosed ? DEFAULT_FIRST_HOUR : Math.floor(today.opensAt / 60);
    let last = today.isClosed
      ? DEFAULT_LAST_HOUR
      : Math.ceil(today.closesAt / 60);
    // Only the bookings on screen widen it. Filtering to the terrace must not
    // leave the chart stretched to 02:00 by a late booking on another floor,
    // with nothing drawn out there to explain the empty space.
    const shown = new Set(visibleTables.map((t) => t.id));
    for (const r of state.snapshot.reservations) {
      if (!shown.has(r.tableId)) continue;
      const s = new Date(r.startAt);
      const e = new Date(r.endAt);
      if (s >= dayStart) first = Math.min(first, s.getHours());
      if (e <= dayEnd) last = Math.max(last, Math.min(24, e.getHours() + (e.getMinutes() > 0 ? 1 : 0)));
    }
    // The chart can run past midnight for a late kitchen, but never past the
    // 24-hour grid it draws: a booking after midnight belongs to the next
    // day's chart, which is where the day window would have put it anyway.
    return { firstHour: Math.max(0, first), lastHour: Math.min(24, Math.max(last, first + 1)) };
  }, [state.snapshot.reservations, visibleTables, dayStart, dayEnd, today]);

  const windowStart = React.useMemo(
    () => new Date(dayStart.getTime() + firstHour * 3_600_000),
    [dayStart, firstHour],
  );
  const windowMinutes = (lastHour - firstHour) * 60;
  const slotCount = windowMinutes / SLOT_MINUTES;
  const trackWidth = slotCount * SLOT_WIDTH_PX;

  const byTable = React.useMemo(() => {
    const grouped = new Map<string, ReservationView[]>();
    for (const r of state.snapshot.reservations) {
      const list = grouped.get(r.tableId) ?? [];
      list.push(r);
      grouped.set(r.tableId, list);
    }
    /*
     * Overlaps are legal whenever at most one of the blocks still holds the
     * slot (a cancelled 17:30 under its 17:30 rebooking, a completed lunch
     * under an evening double-booking of the freed table) — drawn as lanes,
     * never one block painted over another.
     */
    const map = new Map<string, LanedReservation<ReservationView>[]>();
    for (const [tableId, list] of grouped) map.set(tableId, assignReservationLanes(list));
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
        {/*
          * D90 — say which hours this day is drawn against, and where they
          * came from. A chart that silently narrows is indistinguishable
          * from one with no bookings in the missing hours.
          */}
        <span
          className={
            'ml-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ' +
            (today.isClosed
              ? 'bg-danger-soft text-danger'
              : 'bg-muted text-muted-foreground')
          }
          title={
            today.source === 'override'
              ? `Set for this date${today.note ? ` — ${today.note}` : ''}`
              : today.source === 'weekly'
                ? 'From the weekly opening hours'
                : 'Branch default — set opening hours in Settings'
          }
        >
          {today.isClosed ? 'Closed today' : formatHours(today)}
          {today.note ? <span className="font-normal">· {today.note}</span> : null}
        </span>
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

      {/* Area filter. Mirrors the Tables page chip strip so the same gesture
          works on both restaurant screens. Hidden when there is nothing to
          choose between — a one-area branch gains only clutter from it. */}
      {state.snapshot.areas.length > 1 ? (
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Show
          </span>
          <ChipRow
            ariaLabel="Filter by dining area"
            activeKey={selectedArea}
            className="min-w-0 flex-1"
          >
            <AreaChip
              label="All areas"
              active={selectedArea === 'ALL'}
              onClick={() => setSelectedArea('ALL')}
            />
            {state.snapshot.areas.map((a) => (
              <AreaChip
                key={a.id}
                label={a.name}
                active={selectedArea === a.id}
                onClick={() => setSelectedArea(a.id)}
              />
            ))}
          </ChipRow>
        </div>
      ) : null}

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
      ) : visibleTables.length === 0 ? (
        // The branch HAS tables; this area does not. Said distinctly from the
        // message above, and with the way out, so the filter never looks like
        // a calendar that failed to load.
        <Card>
          <CardContent className="space-y-4 py-16 text-center">
            <p className="text-sm text-muted-foreground">No tables in this area.</p>
            <Button variant="outline" onClick={() => setSelectedArea('ALL')}>
              Show all areas
            </Button>
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

                {visibleAreas.map((area) => {
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
                            {(byTable.get(table.id) ?? []).map(({ reservation: r, lane, laneCount }) => (
                              <ReservationBlock
                                key={r.id}
                                reservation={r}
                                lane={lane}
                                laneCount={laneCount}
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
          hours={hours}
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
          hours={hours}
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
  lane,
  laneCount,
  windowStart,
  windowMinutes,
  trackWidth,
  onOpen,
}: {
  reservation: ReservationView;
  lane: number;
  laneCount: number;
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

  // Blocks that overlap in time split the row instead of painting over each
  // other (a cancelled slot under its rebooking). Same 6px row padding the
  // full-height block always had; 2px between lanes.
  const PAD_Y = 6;
  const LANE_GAP = 2;
  const usable = ROW_HEIGHT_PX - PAD_Y * 2;
  const height = (usable - LANE_GAP * (laneCount - 1)) / laneCount;
  const top = PAD_Y + lane * (height + LANE_GAP);

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
        'absolute z-20 flex items-center overflow-hidden rounded-lg border text-left text-xs font-medium shadow-sm transition-shadow hover:shadow-md ' +
        (laneCount > 1 ? 'gap-1 px-1.5 ' : 'gap-1.5 px-2 ') +
        BLOCK_TONES[reservation.status]
      }
      style={{ left, width: Math.max(right - left, 44), top, height }}
    >
      <span className="truncate">{reservation.customerName}</span>
      <span className="shrink-0 text-[10px] opacity-70">{reservation.partySize}p</span>
    </button>
  );
}

// ── Manage dialog ───────────────────────────────────────────────────────────

function ManageReservationDialog({
  session,
  branchId,
  reservation,
  tables,
  areas,
  hours,
  canManage,
  onClose,
  onChanged,
}: {
  session: Session;
  branchId: string;
  reservation: ReservationView;
  tables: RestaurantTableView[];
  areas: DiningAreaView[];
  hours: OpeningHoursView | null;
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
        hours={hours}
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
