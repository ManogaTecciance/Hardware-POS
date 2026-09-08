'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { openingHours as api } from '@/lib/restaurant/api';
import {
  WEEKDAY_NAMES,
  formatHours,
  minutesToTimeInput,
  timeInputToMinutes,
} from '@/lib/restaurant/opening-hours';
import type { OpeningHoursView } from '@/lib/restaurant/types';

/**
 * D90 — opening and closing hours, per weekday and per date.
 *
 * The week is edited as a unit and saved as one replacement, which is also
 * how the API takes it: "back to the usual hours" is a weekday the owner
 * un-ticks, not a delete they have to find.
 *
 * A weekday left un-ticked is NOT closed — it uses the branch default, and
 * the row says which default that is. Conflating "I have not set this" with
 * "we are shut" is how a calendar ends up empty for a restaurant that is
 * open.
 */

interface DayRow {
  dayOfWeek: number;
  /** Un-ticked = follow the default, which is not the same as closed. */
  enabled: boolean;
  isClosed: boolean;
  opens: string;
  closes: string;
  /** Ticked when the kitchen shuts after midnight — closes += 24h. */
  pastMidnight: boolean;
}

interface OverrideRow {
  id: string;
  date: string;
  isClosed: boolean;
  opens: string;
  closes: string;
  pastMidnight: boolean;
  note: string;
}

function rowsFromView(view: OpeningHoursView): { days: DayRow[]; overrides: OverrideRow[] } {
  const days: DayRow[] = WEEKDAY_NAMES.map((_, dayOfWeek) => {
    const found = view.weekly.find((w) => w.dayOfWeek === dayOfWeek);
    return {
      dayOfWeek,
      enabled: !!found,
      isClosed: found?.isClosed ?? false,
      opens: minutesToTimeInput(found?.opensAt ?? view.defaults.opensAt),
      closes: minutesToTimeInput(found?.closesAt ?? view.defaults.closesAt),
      pastMidnight: (found?.closesAt ?? 0) >= 1440,
    };
  });
  const overrides: OverrideRow[] = view.overrides.map((o, i) => ({
    id: `${o.date}-${i}`,
    date: o.date,
    isClosed: o.isClosed,
    opens: minutesToTimeInput(o.opensAt),
    closes: minutesToTimeInput(o.closesAt),
    pastMidnight: o.closesAt >= 1440,
    note: o.note ?? '',
  }));
  return { days, overrides };
}

/** `HH:MM` plus the past-midnight tick → minutes since the same midnight. */
function closingMinutes(closes: string, pastMidnight: boolean): number | null {
  const base = timeInputToMinutes(closes);
  if (base === null) return null;
  return pastMidnight ? base + 1440 : base;
}

export function HoursTab({ session, branchId }: { session: Session; branchId: string }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.RESTAURANT_CONFIG_MANAGE);

  const [view, setView] = React.useState<OpeningHoursView | null>(null);
  const [days, setDays] = React.useState<DayRow[]>([]);
  const [overrides, setOverrides] = React.useState<OverrideRow[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const apply = React.useCallback((next: OpeningHoursView) => {
    setView(next);
    const { days: d, overrides: o } = rowsFromView(next);
    setDays(d);
    setOverrides(o);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get(session, branchId)
      .then((next) => {
        if (cancelled) return;
        apply(next);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load opening hours');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId, apply]);

  const setDay = (dayOfWeek: number, patch: Partial<DayRow>) =>
    setDays((cur) => cur.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)));

  const setOverride = (id: string, patch: Partial<OverrideRow>) =>
    setOverrides((cur) => cur.map((o) => (o.id === id ? { ...o, ...patch } : o)));

  const addOverride = () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    setOverrides((cur) => [
      ...cur,
      {
        // Seeded from the default window rather than blank: an owner adding a
        // date usually wants to change one end of it, not type both.
        id: `new-${cur.length}-${date}`,
        date,
        isClosed: false,
        opens: minutesToTimeInput(view?.defaults.opensAt ?? 480),
        closes: minutesToTimeInput(view?.defaults.closesAt ?? 1380),
        pastMidnight: false,
        note: '',
      },
    ]);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const weekly = [];
      for (const d of days) {
        if (!d.enabled) continue;
        const opensAt = timeInputToMinutes(d.opens);
        const closesAt = closingMinutes(d.closes, d.pastMidnight);
        if (opensAt === null || closesAt === null) {
          throw new Error(`${WEEKDAY_NAMES[d.dayOfWeek]}: enter a time as HH:MM`);
        }
        if (!d.isClosed && closesAt <= opensAt) {
          throw new Error(
            `${WEEKDAY_NAMES[d.dayOfWeek]}: closing must be after opening. Tick "closes after midnight" for a late kitchen.`,
          );
        }
        weekly.push({ dayOfWeek: d.dayOfWeek, isClosed: d.isClosed, opensAt, closesAt });
      }

      const seen = new Set<string>();
      const payloadOverrides = [];
      for (const o of overrides) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error('Pick a date for every exception');
        if (seen.has(o.date)) throw new Error(`Two sets of hours for ${o.date}`);
        seen.add(o.date);
        const opensAt = timeInputToMinutes(o.opens);
        const closesAt = closingMinutes(o.closes, o.pastMidnight);
        if (opensAt === null || closesAt === null) throw new Error(`${o.date}: enter a time as HH:MM`);
        if (!o.isClosed && closesAt <= opensAt) {
          throw new Error(`${o.date}: closing must be after opening`);
        }
        payloadOverrides.push({
          date: o.date,
          isClosed: o.isClosed,
          opensAt,
          closesAt,
          ...(o.note.trim() ? { note: o.note.trim() } : {}),
        });
      }

      const next = await api.update(session, branchId, { weekly, overrides: payloadOverrides });
      apply(next);
      setMessage('Saved. The calendar uses these hours immediately.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save opening hours');
    } finally {
      setSaving(false);
    }
  };

  if (status === 'loading') {
    return (
      <Card className="max-w-3xl">
        <CardContent className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading opening hours…
        </CardContent>
      </Card>
    );
  }
  if (status === 'error' || !view) {
    return (
      <Card className="max-w-3xl">
        <CardContent className="py-16 text-center text-sm text-danger">
          {error ?? 'Could not load opening hours.'}
        </CardContent>
      </Card>
    );
  }

  const defaultLabel = formatHours({
    isClosed: false,
    opensAt: view.defaults.opensAt,
    closesAt: view.defaults.closesAt,
  });

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Opening hours</CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The calendar draws its day from these. A weekday left un-ticked follows the branch
            default of {defaultLabel} — un-ticked is not the same as closed.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {days.map((d) => (
            <div
              key={d.dayOfWeek}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border p-3"
            >
              <label className="flex min-w-[9.5rem] items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={d.enabled}
                  disabled={!canManage}
                  onChange={(e) => setDay(d.dayOfWeek, { enabled: e.target.checked })}
                  aria-label={`Set hours for ${WEEKDAY_NAMES[d.dayOfWeek]}`}
                />
                {WEEKDAY_NAMES[d.dayOfWeek]}
              </label>

              {!d.enabled ? (
                <span className="text-sm text-muted-foreground">Default — {defaultLabel}</span>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={d.isClosed}
                      disabled={!canManage}
                      onChange={(e) => setDay(d.dayOfWeek, { isClosed: e.target.checked })}
                      aria-label={`${WEEKDAY_NAMES[d.dayOfWeek]} closed all day`}
                    />
                    Closed
                  </label>
                  {!d.isClosed ? (
                    <>
                      <Input
                        type="time"
                        className="w-32"
                        value={d.opens}
                        disabled={!canManage}
                        onChange={(e) => setDay(d.dayOfWeek, { opens: e.target.value })}
                        aria-label={`${WEEKDAY_NAMES[d.dayOfWeek]} opening time`}
                      />
                      <span className="text-sm text-muted-foreground">to</span>
                      <Input
                        type="time"
                        className="w-32"
                        value={d.closes}
                        disabled={!canManage}
                        onChange={(e) => setDay(d.dayOfWeek, { closes: e.target.value })}
                        aria-label={`${WEEKDAY_NAMES[d.dayOfWeek]} closing time`}
                      />
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={d.pastMidnight}
                          disabled={!canManage}
                          onChange={(e) => setDay(d.dayOfWeek, { pastMidnight: e.target.checked })}
                          aria-label={`${WEEKDAY_NAMES[d.dayOfWeek]} closes after midnight`}
                        />
                        closes after midnight
                      </label>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Specific dates</CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A poya day, a holiday, a private function. These beat the weekday hours above, and
            only for the date named.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No exceptions. Every date follows the week above.
            </p>
          ) : null}

          {overrides.map((o) => (
            <div
              key={o.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border p-3"
            >
              <Input
                type="date"
                className="w-44"
                value={o.date}
                disabled={!canManage}
                onChange={(e) => setOverride(o.id, { date: e.target.value })}
                aria-label="Exception date"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={o.isClosed}
                  disabled={!canManage}
                  onChange={(e) => setOverride(o.id, { isClosed: e.target.checked })}
                  aria-label={`Closed on ${o.date}`}
                />
                Closed
              </label>
              {!o.isClosed ? (
                <>
                  <Input
                    type="time"
                    className="w-32"
                    value={o.opens}
                    disabled={!canManage}
                    onChange={(e) => setOverride(o.id, { opens: e.target.value })}
                    aria-label={`Opening time on ${o.date}`}
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    type="time"
                    className="w-32"
                    value={o.closes}
                    disabled={!canManage}
                    onChange={(e) => setOverride(o.id, { closes: e.target.value })}
                    aria-label={`Closing time on ${o.date}`}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={o.pastMidnight}
                      disabled={!canManage}
                      onChange={(e) => setOverride(o.id, { pastMidnight: e.target.checked })}
                      aria-label={`Closes after midnight on ${o.date}`}
                    />
                    closes after midnight
                  </label>
                </>
              ) : null}
              <Input
                className="w-44 flex-1"
                placeholder="Note, e.g. Poya day"
                value={o.note}
                disabled={!canManage}
                onChange={(e) => setOverride(o.id, { note: e.target.value })}
                aria-label={`Note for ${o.date}`}
              />
              <button
                type="button"
                disabled={!canManage}
                onClick={() => setOverrides((cur) => cur.filter((x) => x.id !== o.id))}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                aria-label={`Remove ${o.date}`}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}

          <Button variant="secondary" disabled={!canManage} onClick={addOverride}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add a date
          </Button>
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-success">{message}</p> : null}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button isLoading={saving} disabled={!canManage} onClick={() => void save()}>
          Save opening hours
        </Button>
        {!canManage ? (
          <span className="text-xs text-muted-foreground">
            Your role can view these but not change them.
          </span>
        ) : null}
      </div>
    </div>
  );
}
