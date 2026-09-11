'use client';

import { Check, ChefHat, Clock, ListTree, Printer, RotateCcw, UtensilsCrossed } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { TicketOrderDialog } from '@/components/restaurant/kitchen/ticket-order-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { kitchen, kitchenStations } from '@/lib/restaurant/api';
import { printKitchenTicket } from '@/lib/restaurant/kot-print';
import { playNewOrderChime } from '@/lib/restaurant/new-order-chime';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  formatElapsed,
  formatTime,
  sendLabel,
} from '@/lib/restaurant/labels';
import type {
  KitchenLaneCounts,
  KitchenStationView,
  KitchenTicketView,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

/*
 * D115/D116 — three lanes, bump-bar style, each ticket in exactly one: To
 * make (queued), Preparing (started, D113), Done (bumped TODAY — D142; every
 * other ticket, cooked or still waiting, is on Ticket history — D150).
 * Cancelled work
 * never renders here at all: the read excludes it (D115), so a mid-cook
 * cancel simply pulls the card off the board. Cancelling — and reviewing
 * what was cancelled — is the ORDERS QUEUE's business (D116): the kitchen
 * decides doneness, never whether an order still exists.
 */
type Filter = 'TO_MAKE' | 'PREPARING' | 'COMPLETED';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'TO_MAKE', label: 'To make' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'COMPLETED', label: 'Done' },
];

/*
 * To make and Preparing are client-side views of ONE fetch: they split the
 * same outstanding list, so switching between them is instant, both counts
 * are live at once, and the new-ticket chime keeps one baseline across
 * both (an arrival rings whichever of the two the cook is reading).
 */
const FETCH_FOR: Record<Filter, 'OUTSTANDING' | 'COMPLETED_TODAY'> = {
  TO_MAKE: 'OUTSTANDING',
  PREPARING: 'OUTSTANDING',
  /*
   * D142 — TODAY's, not everything ever bumped. The lane answers "what have we
   * finished this service"; left unbounded it grew without limit, so the
   * ticket somebody was actually looking for sank below a week of older ones.
   * The day is cut on the SHOP's midnight, which is why the server decides it
   * and this only names the lane.
   */
  COMPLETED: 'COMPLETED_TODAY',
};

/*
 * D100 — age escalation. A ticket's age is the first thing the pass needs
 * from the board, and grey footer text does not survive being read from
 * across a kitchen: the timer is large, and the whole card turns amber and
 * then red as the dish waits. Thresholds follow the mainstream KDS defaults
 * rather than a per-tenant setting — a setting nobody has asked for is
 * configuration debt, and the constants can move to config the day a tenant
 * asks.
 */
const WARN_AFTER_MS = 10 * 60_000;
const LATE_AFTER_MS = 15 * 60_000;

type Urgency = 'fresh' | 'warn' | 'late';

function urgencyOf(createdAtIso: string, now: Date): Urgency {
  const age = now.getTime() - new Date(createdAtIso).getTime();
  if (Number.isNaN(age)) return 'fresh';
  if (age >= LATE_AFTER_MS) return 'late';
  if (age >= WARN_AFTER_MS) return 'warn';
  return 'fresh';
}

const URGENCY_CARD_CLASS: Record<Urgency, string | undefined> = {
  fresh: undefined,
  warn: 'border-2 border-warning',
  late: 'border-2 border-danger',
};

const URGENCY_TIMER_CLASS: Record<Urgency, string> = {
  fresh: 'text-muted-foreground',
  warn: 'text-warning',
  late: 'text-danger',
};

/**
 * The kitchen board (D68).
 *
 * Every item a waiter confirms onto an order lands here within a poll of
 * being sent, and this screen is the ONLY place it is ever delivered —
 * nothing prints. That raises the bar on what a card has to carry: the pass
 * cannot plate a dish it can see but cannot place, so each ticket names its
 * table, its order, its station and its round the way a printed KOT used to.
 *
 * Kitchen staff start a ticket when they take it (D113 — Preparing), mark
 * it done when the food is up, and recall it when the bump was wrong
 * (D100). That is the whole write surface; the floor is not theirs and
 * neither is the money. Start/done ripple to the round and any takeaway
 * profile server-side, which is what moves the Orders queue.
 *
 * Polls every 5 s, in ONE request (D154; a station cut adds the station's
 * lane counts beside it — D174, see `load`): shorter cadences read as jitter on
 * a wall-mounted screen; longer ones leave a dish sitting unseen while a table
 * waits. The poll doubles as the age-escalation tick: every refresh re-renders
 * the cards, which is where the timers and colours advance — and as the
 * chime's watch: a poll that brings an unseen ticket onto "To make" rings the
 * same new-order chime the orders queue uses, because a wall-mounted board is
 * not being stared at between tickets (mainstream KDS units beep).
 *
 * D154 — and it stops while the tab is hidden, coming back the moment it is
 * looked at again. Nothing on this screen is worth refreshing for a tab
 * nobody is reading.
 */
export function KitchenBoard({ session, branchId }: Props) {
  const { hasPermission } = useAuth();
  // Gates every write verb — Start preparing, Mark done and Recall (D113
  // added the first). D94 grants the till KOT_VIEW alone, so a cashier
  // sees this board with no buttons on it — that contrast is pinned by WS-408.
  const canUpdate = hasPermission(Permission.KITCHEN_STATUS_UPDATE);

  const [tickets, setTickets] = React.useState<KitchenTicketView[]>([]);
  const [filter, setFilter] = React.useState<Filter>('TO_MAKE');
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  /** D83 — the ticket whose whole order is being read. */
  const [detailFor, setDetailFor] = React.useState<KitchenTicketView | null>(null);
  /*
   * D142b — the counts for the lanes this board is NOT fetching. The active
   * lane keeps deriving its own from the list it already has, so a bump moves
   * its chip instantly instead of waiting up to five seconds for the poll.
   *
   * D154 — they ride in the ticket read's envelope now, off the same snapshot,
   * rather than arriving from a second request behind it.
   *
   * D174 — under a station cut they are that STATION's numbers, read from the
   * counts route beside the list (see `load`). The tag records which station a
   * set answers, on the lesson D154 learned for the rows: state that answers
   * a question the screen has stopped asking must not be relabelled as the
   * answer to the new one. `laneCount` reads a set only while its tag is the
   * station on screen.
   */
  const [counts, setCounts] = React.useState<{
    /** The station the numbers were read for; `null` is the whole branch. */
    stationId: string | null;
    lanes: KitchenLaneCounts;
  } | null>(null);

  /*
   * D152 — the station filter. `null` is every station.
   *
   * The list comes from the stations endpoint rather than from the tickets on
   * screen: a chip that vanishes when its last ticket is bumped, and returns
   * when the next one lands, is unusable on a wall-mounted screen. Kitchen
   * staff already hold PLATFORM_PROFILE_READ, which is what that endpoint
   * requires, so the strip is available to exactly the people who need it.
   *
   * A failed fetch leaves the list empty and the strip hidden. The board is
   * the job; the filter is a convenience, and must never be able to take the
   * board down with it.
   */
  const [stations, setStations] = React.useState<KitchenStationView[]>([]);
  const [stationId, setStationId] = React.useState<string | null>(null);
  const stationStorageKey = `kitchen.stationFilter.${branchId}`;

  /*
   * Ticket ids seen on the last poll, per filter — the chime's memory (same
   * rule as the orders queue: null until the first response lands, so opening
   * the board never dings, and a filter switch re-baselines instead of
   * ringing for cards that merely became visible). Unlike the queue this
   * compares IDS, not a total: the list is unpaged so ids are exact, and a
   * count would stay flat when one ticket is bumped in the same poll that
   * another arrives — exactly the arrival the pass must hear.
   */
  /*
   * D154 — which fetch the rows currently on screen answer.
   *
   * The failed-poll path below keeps the last good cards, and that is right
   * only while the board is still asking the SAME question. After a lane
   * switch it is not: the rows in state answer the lane the cook just left,
   * and `inLane` would re-label them as the new one — a queued card sitting
   * on Done offering "Start preparing", counted by the Done chip.
   */
  const loadedFetch = React.useRef<(typeof FETCH_FOR)[Filter] | null>(null);

  const chimeBaseline = React.useRef<{
    /** `<fetch filter>|<station id or ALL>` — see the chime block in `load`. */
    key: string;
    ids: Set<string>;
  } | null>(null);

  /*
   * Restore the screen's own station after a reload. A kitchen board is
   * mounted at a station and left there, so making the cook re-pick Grill
   * every refresh defeats the filter. Read in an effect, not in a useState
   * initialiser: this component server-renders, and localStorage does not
   * exist there.
   */
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(stationStorageKey);
      if (saved) setStationId(saved);
    } catch {
      // Private mode or blocked storage. An unremembered filter is fine.
    }
  }, [stationStorageKey]);

  React.useEffect(() => {
    let cancelled = false;
    void kitchenStations
      .list(session, branchId)
      .then((rows) => {
        if (!cancelled) setStations(rows.filter((st) => st.isActive));
      })
      .catch(() => {
        if (!cancelled) setStations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  /*
   * A remembered station that has since been archived would otherwise filter
   * the board down to nothing for ever, with no clue why. Only drop it once
   * the list has actually arrived: an empty list is also what a failed fetch
   * looks like, and that must not silently clear the cook's selection.
   */
  React.useEffect(() => {
    if (stations.length === 0 || stationId === null) return;
    if (!stations.some((st) => st.id === stationId)) setStationId(null);
  }, [stations, stationId]);

  const selectStation = React.useCallback(
    (next: string | null) => {
      setStationId(next);
      try {
        if (next) window.localStorage.setItem(stationStorageKey, next);
        else window.localStorage.removeItem(stationStorageKey);
      } catch {
        // Not remembering the choice is survivable; failing the click is not.
      }
    },
    [stationStorageKey],
  );

  const load = React.useCallback(async () => {
    // D115 — keyed on the FETCH, not the tab: To make ↔ Preparing share the
    // outstanding list, so flipping between them keeps the baseline and a
    // genuine arrival rings on either; Done re-baselines as before.
    const fetchFilter = FETCH_FOR[filter];
    /*
     * D152 — the chime answers "is there work for THIS screen?", so it hears
     * only the selected station. A grill screen ringing for a dessert is
     * noise, and silencing that is most of the reason to mount a filtered
     * board.
     *
     * The station is part of the baseline key for the same reason the fetch
     * filter is: switching Grill → All reveals tickets this screen has never
     * seen, which is a change of view, not an arrival. Re-baseline instead of
     * ringing.
     */
    const chimeKey = `${fetchFilter}|${stationId ?? 'ALL'}`;
    try {
      /*
       * D154 — ONE request per tick on an unfiltered board. The lane counts
       * come back with the tickets, so the board does not chase
       * `kitchen.laneCounts` after every list read. Beyond the halved traffic
       * it is one server snapshot, so the cards and the chips can no longer
       * disagree about a ticket bumped between two reads.
       *
       * D174 — under a station cut, one more: the station's three lane counts
       * from the counts route, in parallel. The list itself stays UNSCOPED,
       * because the station strip below the lanes counts EVERY station's share
       * of the current lane (D152's "where is the work?") and could not do so
       * from a list the server had already cut to one. The envelope's own
       * counts would then be the branch's, which is the number D152 withheld
       * under a cut and the PO has now asked to see corrected rather than
       * hidden — so the cut asks the counts route, which takes the same
       * `stationId` as the list read and is pinned to it server-side, for the
       * three integers alone. Reading the cut list a second time to get those
       * integers would fetch every card twice; this fetches them once.
       *
       * What that costs: the other lane's number is a second snapshot. The
       * cards, the active lanes' chips and the strip all still derive from the
       * one list, so nothing ON SCREEN can disagree with a card the way D154
       * describes; only a lane with no cards showing reads from the second
       * read. One failure fails the tick: a banner over five-second-old
       * numbers, exactly as D154 handles a failed list read.
       */
      const [next, stationLanes] = await Promise.all([
        kitchen.listTickets(session, branchId, fetchFilter),
        stationId ? kitchen.laneCounts(session, branchId, stationId) : null,
      ]);
      setTickets(next.items);
      setCounts({ stationId, lanes: stationLanes ?? next.counts });
      setStatus('ready');
      loadedFetch.current = fetchFilter;
      // The banner is about the LAST poll, not about the mount. Without this a
      // single bad tick left a red error standing over a board that recovered
      // seconds later and went on working for the rest of the shift.
      setError(null);
      const heard = stationId ? next.items.filter((t) => t.stationId === stationId) : next.items;
      const prev = chimeBaseline.current;
      // Only outstanding work rings: a ticket appearing on Done is someone
      // bumping, not work arriving. A recall by ANOTHER screen does ring —
      // it lands on the outstanding list as a ticket the pass has not seen.
      if (
        fetchFilter === 'OUTSTANDING' &&
        prev?.key === chimeKey &&
        heard.some((t) => !prev.ids.has(t.id))
      ) {
        playNewOrderChime();
      }
      chimeBaseline.current = { key: chimeKey, ids: new Set(heard.map((t) => t.id)) };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load kitchen tickets');
      /*
       * D154 — the last good poll STAYS on screen. Two reads used to make this
       * automatic for the numbers: the counts call swallowed its own error, so
       * a failing count left the chips reading whatever they last knew. One
       * read makes that hedge moot, and the property it protected has to be
       * kept deliberately instead — neither `tickets` nor `counts` is cleared
       * here, and the board stays `ready` so it goes on rendering them. A wall
       * board that blanks the pass's work on one bad poll is worse than a
       * board showing five-second-old cards under a banner saying so.
       *
       * Two cases have nothing worth keeping and fall through to the error
       * card. A board that has NEVER loaded, because leaving it `loading`
       * would spin for ever on a branch whose kitchen read is refused
       * outright. And a board whose rows answer a DIFFERENT lane: showing the
       * cook the tab they just left, relabelled as the one they chose, is
       * worse than showing them nothing — the verbs on those cards belong to
       * the other lane, and the chip would count them for this one.
       */
      setStatus((cur) =>
        cur === 'loading' || loadedFetch.current !== fetchFilter ? 'error' : cur,
      );
    }
  }, [session, branchId, filter, stationId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /*
   * D154 — the 5 s poll runs only while the board is actually on a screen. A
   * board left open overnight was asking ~1,440 times an hour whether anything
   * had changed, for nobody. `focus`/`visibilitychange` refetch on the way
   * back, so returning to the board never means reading tickets as stale as
   * the time away — on a pass, where the poll IS the delivery, waiting out the
   * remainder of an interval is exactly the wrong four seconds.
   *
   * Same shape as the orders queue (orders-page.tsx) and the dashboard
   * (use-dashboard-data.ts); this is that idea written once more, not a third
   * dialect of it.
   */
  React.useEffect(() => {
    const loadIfVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const t = setInterval(loadIfVisible, 5000);
    window.addEventListener('focus', loadIfVisible);
    document.addEventListener('visibilitychange', loadIfVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', loadIfVisible);
      document.removeEventListener('visibilitychange', loadIfVisible);
    };
  }, [load]);

  /*
   * Both verbs move the ticket OFF the current tab (done leaves "To make",
   * recalled leaves "Done"), so they share the same optimistic shape: drop
   * the card immediately rather than waiting for the next poll — on a busy
   * pass a button that stays put for five seconds gets pressed again, and
   * the person doing it has both hands full.
   */
  const mutate = async (
    ticket: KitchenTicketView,
    send: () => Promise<unknown>,
    failure: string,
  ) => {
    setPending((cur) => new Set(cur).add(ticket.id));
    setError(null);
    try {
      await send();
      setTickets((cur) => cur.filter((t) => t.id !== ticket.id));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      await load();
    } finally {
      setPending((cur) => {
        const next = new Set(cur);
        next.delete(ticket.id);
        return next;
      });
    }
  };

  const complete = (ticket: KitchenTicketView) =>
    mutate(
      ticket,
      () => kitchen.complete(session, branchId, ticket.id),
      'Could not mark this ticket done',
    );

  /** D100 — the bump's undo. */
  const recall = (ticket: KitchenTicketView) =>
    mutate(
      ticket,
      () => kitchen.reopen(session, branchId, ticket.id),
      'Could not recall this ticket',
    );

  /**
   * D113 — the first tap: the card STAYS on "To make" (unlike both verbs
   * above), so instead of the optimistic drop it swaps in the server's
   * updated ticket — the verb flips to Mark done and the Preparing badge
   * appears without waiting a poll.
   */
  const start = async (ticket: KitchenTicketView) => {
    setPending((cur) => new Set(cur).add(ticket.id));
    setError(null);
    try {
      const updated = await kitchen.start(session, branchId, ticket.id);
      setTickets((cur) => cur.map((t) => (t.id === ticket.id ? updated : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start this ticket');
      await load();
    } finally {
      setPending((cur) => {
        const next = new Set(cur);
        next.delete(ticket.id);
        return next;
      });
    }
  };

  /*
   * D115 — one lane's share of a fetched list. The queued family (QUEUED + the
   * retired print statuses) is To make; started tickets are Preparing; Done
   * renders its fetch whole.
   *
   * A function of (rows, lane) rather than an inline ternary because the chips
   * ask it the same question about a lane the board is not showing (D142b).
   */
  const inLane = (rows: KitchenTicketView[], lane: Filter): KitchenTicketView[] =>
    lane === 'TO_MAKE'
      ? rows.filter((t) => t.status !== 'IN_PROGRESS')
      : lane === 'PREPARING'
        ? rows.filter((t) => t.status === 'IN_PROGRESS')
        : rows;

  /*
   * D152 — the station cut comes FIRST and everything downstream reads from
   * it, so the lane counts describe the board actually on screen. A strip
   * reading "To make 11" above two visible cards is worse than no count at
   * all.
   *
   * A ticket cut during the D147 window carries no station, so it belongs to
   * no chip and shows only under "All stations". It is never invisible on
   * every view, which is the property that matters.
   */
  const scoped = stationId ? tickets.filter((t) => t.stationId === stationId) : tickets;

  /** The lane the active tab shows, after the station cut. */
  const visible = inLane(scoped, filter);

  /** Which server count belongs to which chip. */
  const COUNT_KEY: Record<Filter, keyof KitchenLaneCounts> = {
    TO_MAKE: 'toMake',
    PREPARING: 'preparing',
    COMPLETED: 'doneToday',
  };

  /*
   * D142b — every chip carries a number, whichever lane is open.
   *
   * Two sources, and the split is the point. A lane sharing the CURRENT fetch
   * is counted from the list already in hand, so an optimistic bump moves both
   * outstanding chips at once instead of lagging a poll behind. Every other
   * lane takes the server's count — which is what the board could not know
   * before, and why "Done" showed nothing from To make, and To make and
   * Preparing showed nothing from Done.
   *
   * D174 — and that holds under a station cut too. D152 left the other lane's
   * chip bare under a cut, because the only number the board had was the
   * BRANCH's and "Done 7" over a lane that would show two is a lie; the PO
   * has ruled that a bare chip is the worse answer. The lie is now fixed at
   * its source instead: `load` reads the station's own three numbers, so the
   * chip carries the count the cook will actually find on that lane. A ticket
   * from the D147 window belongs to no station and is in no station's number,
   * exactly as it is on no station's board; it is still in "All stations".
   *
   * The one moment a chip is bare is while the numbers in hand answer a
   * DIFFERENT station from the one selected — the round trip after a station
   * tap, or a poll that failed on the way. Those are not this station's
   * numbers, and D154's rule for the rows applies to them: never relabel the
   * old answer as the new one. The chip fills as soon as the poll lands.
   */
  const laneCount = (key: Filter): number | null => {
    if (FETCH_FOR[key] === FETCH_FOR[filter]) return inLane(scoped, key).length;
    return counts?.stationId === stationId ? counts.lanes[COUNT_KEY[key]] : null;
  };

  /*
   * D152 — station counts are for the CURRENT lane across every station, so
   * they answer "where is the work?" while the lane strip answers "what state
   * is it in?". Deliberately not scoped by `stationId`: a chip that only ever
   * counted its own selection would read zero on every station but one.
   *
   * D174 — which is why `load` keeps the list read unscoped and asks the
   * counts route for the station's lane numbers, rather than cutting the list
   * on the server: a list the server had cut to Grill holds nothing for these
   * chips to count for Main.
   */
  const inLaneAllStations = inLane(tickets, filter);
  const stationCount = (id: string): number =>
    inLaneAllStations.filter((t) => t.stationId === id).length;
  const selectedStationName = stations.find((st) => st.id === stationId)?.name ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ChipRow ariaLabel="Filter kitchen tickets" activeKey={filter} className="min-w-0 flex-1">
          {FILTERS.map((f) => {
            const count = laneCount(f.key);
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                data-active={filter === f.key}
                className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${
                  filter === f.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground hover:bg-border'
                }`}
              >
                {f.label}
                {count !== null ? (
                  <span
                    className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs ${
                      filter === f.key ? 'bg-primary-foreground/20' : 'bg-border'
                    }`}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </ChipRow>
        {filter === 'COMPLETED' ? (
          // D142 — the lane holds today only, so the way to everything older
          // belongs beside it rather than only on the rail: the cook looking
          // for last night's ticket is looking HERE when they fail to find it.
          <Link
            href="/kitchen/history"
            className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {/* D150 — the destination is no longer only the past, so the
                link no longer promises it. */}
            All tickets → Ticket history
          </Link>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">Refreshes every 5 s.</span>
        )}
      </div>

      {/*
       * D152 — only worth a strip when there is a routing decision to make.
       * One station means every ticket is already this screen's, and a lone
       * "All stations" chip beside it would be furniture. Same reasoning as
       * D67's single-station fallback on the routing side.
       */}
      {stations.length > 1 ? (
        <ChipRow
          ariaLabel="Filter by kitchen station"
          activeKey={stationId ?? 'ALL'}
          className="min-w-0"
        >
          {[{ id: null as string | null, name: 'All stations' }, ...stations].map((st) => {
            const active = stationId === st.id;
            const count = st.id === null ? inLaneAllStations.length : stationCount(st.id);
            return (
              <button
                key={st.id ?? 'ALL'}
                type="button"
                onClick={() => selectStation(st.id)}
                data-active={active}
                aria-pressed={active}
                className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground hover:bg-border'
                }`}
              >
                {st.name}
                <span
                  className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs ${
                    active ? 'bg-primary-foreground/20' : 'bg-border'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </ChipRow>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="py-3 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : null}

      {status === 'loading' ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading tickets…
          </CardContent>
        </Card>
      ) : status === 'error' ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">
            {error ?? 'Could not load kitchen tickets.'}
          </CardContent>
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {/* D152 — naming the station matters more than the lane copy here:
                an empty board is otherwise indistinguishable from a filter the
                cook forgot they left on. */}
            {selectedStationName ? (
              <>
                Nothing for {selectedStationName} on this lane.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => selectStation(null)}
                >
                  Show all stations
                </button>
                {/* D142 — the Done lane holds TODAY wherever the station cut
                    lands, so the way to the rest survives the filter: without
                    it, "today only" reads as a defect on a filtered board too. */}
                {filter === 'COMPLETED' ? ' Earlier tickets are in Ticket history.' : null}
              </>
            ) : filter === 'TO_MAKE' ? (
              'Nothing to make. New tickets appear here as waiters send them.'
            ) : filter === 'PREPARING' ? (
              canUpdate ? (
                'Nothing on the stove. Start a ticket from To make.'
              ) : (
                // D94 — the till reads the board but holds no verb; do not send
                // it to a button it does not have.
                'Nothing on the stove.'
              )
            ) : (
              'Nothing finished today yet. Earlier tickets are in Ticket history.'
            )}
          </CardContent>
        </Card>
      ) : (
        // Three across from `lg` (1024) rather than `xl` (1280): the kitchen
        // board is usually a wall-mounted landscape tablet, where two columns
        // of narrow cards wastes half the screen the pass is reading from.
        //
        // D177 — and never FOUR. The footer row carries the KOT number, a
        // Print button and a Details button (D153 added the middle one), and
        // at four columns on a wide screen the number was the thing that gave
        // — "KOT-0000…" is what the pass got. A card that cannot show its own
        // number is not a card the pass can call out, so the fourth column is
        // gone and the number no longer truncates (see the footer).
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              canUpdate={canUpdate}
              pending={pending.has(t.id)}
              onStart={() => void start(t)}
              onComplete={() => void complete(t)}
              onRecall={() => void recall(t)}
              onDetails={() => setDetailFor(t)}
            />
          ))}
        </div>
      )}

      {detailFor ? (
        <TicketOrderDialog
          session={session}
          branchId={branchId}
          ticket={detailFor}
          onClose={() => setDetailFor(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One card — one station's share of a round (D152).
 *
 * D147 made the card the whole round because routing was an accident: a dish
 * linked to no station reached no card at all, so at a multi-station branch it
 * was ordered, billed and never cooked, and there was no screen on which anyone
 * could have linked it. D152 removes both halves of that — the station is
 * chosen when the menu item is created, and anything still undecided routes to
 * the branch's Main station — so the split comes back with nothing able to fall
 * through it. A table with a grill dish and a curry is two cards again, which
 * is what lets each cook see their own work and only their own.
 *
 * The Details dialog remains the way to see the rest of the ORDER: the other
 * stations' share of this round, and the rounds the table ate an hour ago.
 */
function TicketCard({
  ticket,
  canUpdate,
  pending,
  onStart,
  onComplete,
  onRecall,
  onDetails,
}: {
  ticket: KitchenTicketView;
  canUpdate: boolean;
  pending: boolean;
  onStart: () => void;
  onComplete: () => void;
  onRecall: () => void;
  onDetails: () => void;
}) {
  const done = ticket.status === 'COMPLETED';
  /** D113 — started but not bumped: the card carries a Preparing badge. */
  const preparing = ticket.status === 'IN_PROGRESS';
  // Completed tickets stop ageing: the colour answers "how long has this
  // dish been waiting?", which a done dish no longer is.
  const urgency: Urgency = done ? 'fresh' : urgencyOf(ticket.createdAt, new Date());
  /*
   * The provenance line: order, waiter. D152 sends the station and the round
   * up to the ribbon, so neither is duplicated here.
   *
   * Built as a FILTERED JOIN rather than as fragments each prefixed with ` · `:
   * the prefix form was only ever safe while its first part was always present,
   * and it emits a leading separator the moment that part goes missing — a
   * takeaway before its order number lands carries neither part, which is why
   * an empty line is dropped instead of printed.
   */
  const provenance = [ticket.orderNumber, ticket.waiterName].filter(Boolean).join(' · ');
  /*
   * D152 — a ticket cut during the D147 window was routed to no station at all
   * and carries no name for one. The band still earns its place on those: the
   * round is on it, and inventing "Main" for a ticket that holds every
   * station's items would be a worse answer than an empty half.
   */
  const hasRibbon = Boolean(ticket.stationName) || Boolean(ticket.roundNumber);
  return (
    // The board is a grid, so the row stretches every card to its tallest
    // member. `h-full` is what makes this card ACCEPT that height, and without
    // it the actions' `mt-auto` below has nothing to push against — the two
    // only line a row's buttons up as a pair.
    //
    // `overflow-hidden` is what lets the ribbon below sit flush and take the
    // rounded corners from this parent. The urgency border still wraps both,
    // so a late ticket reads as one object.
    <Card
      className={`flex h-full flex-col overflow-hidden ${done ? 'opacity-70' : (URGENCY_CARD_CLASS[urgency] ?? '')}`}
    >
      {/* D68 put the station in the subtitle, where it was the first grey item
          in a truncated four-part run. A station-split order puts the SAME
          table on two cards (D152) and the station is the only thing telling a
          cook which of them is theirs, so it runs as a ribbon across the top:
          the one position that survives a narrow column, reads before the card
          is fully in view, and never competes with the place for the eye.
          `bg-brand-50` deliberately avoids the info/warning/success tones the
          status badge uses, so station identity never reads as ticket state. */}
      {hasRibbon ? (
        <div className="flex items-center justify-between gap-2 bg-brand-50 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700">
          {/* The station can be long ("Main Kitchen") and the round never is, so
              the station takes the truncation and the round is pinned. */}
          <span className="truncate">{ticket.stationName}</span>
          {/* Absent on a legacy ticket that predates rounds, and the ribbon must
              not then render a bare "Round". */}
          {ticket.roundNumber ? (
            <span className="shrink-0">{sendLabel(ticket.roundNumber)}</span>
          ) : null}
        </div>
      ) : null}
      <CardContent className="flex flex-1 flex-col space-y-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            {/* The place is the biggest thing on the card: a dish the pass
                cannot place is a dish that does not leave the kitchen. */}
            <p className="min-w-0 flex-1 truncate text-xl font-semibold">
              {ticket.placeLabel ?? 'No table'}
            </p>
            {done ? (
              <StatusBadge
                tone={KITCHEN_TICKET_STATUS_TONES[ticket.status]}
                label={KITCHEN_TICKET_STATUS_LABELS[ticket.status]}
              />
            ) : (
              // The timer sits where a status badge would, because on the
              // outstanding tab the age IS the status — every badge there read
              // "To make", which the tab already says. D113's Preparing is the
              // one outstanding state worth a badge, so it rides beside the
              // timer rather than displacing it: the dish still ages.
              <div className="flex shrink-0 items-center gap-2">
                {preparing ? (
                  <StatusBadge
                    tone={KITCHEN_TICKET_STATUS_TONES[ticket.status]}
                    label={KITCHEN_TICKET_STATUS_LABELS[ticket.status]}
                  />
                ) : null}
                <span
                  className={`shrink-0 text-xl font-bold tabular-nums ${URGENCY_TIMER_CLASS[urgency]}`}
                >
                  {formatElapsed(ticket.createdAt)}
                </span>
              </div>
            )}
          </div>
          {/* Its own full-width line. Sharing the header row with the timer
              left it roughly half a card, which truncated the waiter off the
              end of an ordinary ticket ("RO-000001 · Restauran..."). Nothing
              here is worth reading at half width. */}
          {provenance ? (
            <p className="mt-1 truncate text-sm text-muted-foreground">{provenance}</p>
          ) : null}
        </div>

        <ul className="space-y-2">
          {ticket.items.map((item) => (
            <li key={item.id} className="text-base">
              <span className="font-medium">
                {trimQuantity(item.quantity)}× {item.menuItemName}
                {item.variantName ? ` (${item.variantName})` : ''}
              </span>
              {item.modifierNames.length > 0 ? (
                <span className="block text-sm text-muted-foreground">
                  {item.modifierNames.join(', ')}
                </span>
              ) : null}
              {item.specialInstructions ? (
                // Special instructions are the one thing on a ticket that
                // ruins a plate when missed, so they are not muted.
                <span className="block text-sm font-medium text-warning">
                  {item.specialInstructions}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        {/*
         * The board is a grid, so every card is stretched to the tallest in
         * its row. Without mt-auto the verb sits wherever the dish list
         * happens to end, leaving a void beneath it and putting each card's
         * button at a different height - the thing a cook reaches for moves
         * every time the ticket beside it changes. Pinning the actions to the
         * bottom gives the row one button line to aim at.
         */}
        <div className="mt-auto space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            {/* min-w-0 + truncate, or a long "completed by" name wraps to a
                second line and drags Details up out of the row with it. The
                icon and the button keep their size; the name is what gives. */}
            <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              {done ? (
                <>
                  <Check className="h-4 w-4 shrink-0" />
                  {/* The name gives and the time is pinned: "who bumped it" is
                      recoverable from Details, "when" is the half a pass
                      actually scans a Done card for. */}
                  <span className="truncate">{ticket.completedByName ?? 'Done'}</span>
                  {ticket.completedAt ? (
                    <span className="shrink-0">· {formatTime(ticket.completedAt)}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <Clock className="h-4 w-4 shrink-0" />
                  {/* D177 — NOT truncated, unlike the completed-by name above
                      it: a ticket number the pass cannot read in full is the
                      one thing this row exists to show. The buttons beside it
                      shed their labels first (see below). */}
                  <span className="shrink-0 whitespace-nowrap">{ticket.ticketNumber}</span>
                </>
              )}
            </span>
            {/*
              D153 — the paper copy. Beside Details rather than in it: a pass
              that prints does it for every ticket as it lands, and one that
              does not never opens the dialog to find out.

              Ghost and icon-led, like Details, so neither competes with the
              bump verb below — the write action is still the whole bottom of
              the card (D100).
            */}
            {/* D177 — the labels hide below `lg` so the row has three things
                that shrink (two labels) and one that does not (the number).
                The icons stay, and each button keeps its accessible name, so
                nothing is lost to a screen reader or a wide screen. */}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Print ${ticket.ticketNumber}`}
              className="shrink-0"
              leftIcon={<Printer className="h-4 w-4" />}
              onClick={() => printKitchenTicket(ticket)}
            >
              <span className="hidden lg:inline">Print</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Details for ${ticket.ticketNumber}`}
              className="shrink-0"
              leftIcon={<ListTree className="h-4 w-4" />}
              onClick={onDetails}
            >
              <span className="hidden lg:inline">Details</span>
            </Button>
          </div>
          {/*
           * D100 — the write verb is the whole bottom of the card, because
           * the finger pressing it is wet, gloved, or holding a plate. Recall
           * is deliberately quieter than the bump (outline, not filled): it
           * is the undo, not the job.
           *
           * D113 — ONE verb per state, industry bump-bar style: a queued
           * ticket offers Start preparing, a started one offers Mark done.
           * Two stacked 48px buttons would halve how many tickets the pass
           * can see, and the two taps are adjacent in time anyway.
           */}
          {canUpdate ? (
            done ? (
              <Button
                variant="outline"
                className="h-12 w-full text-base"
                leftIcon={<RotateCcw className="h-5 w-5" />}
                isLoading={pending}
                onClick={onRecall}
              >
                Recall
              </Button>
            ) : preparing ? (
              <Button
                className="h-12 w-full text-base"
                leftIcon={<UtensilsCrossed className="h-5 w-5" />}
                isLoading={pending}
                onClick={onComplete}
              >
                Mark done
              </Button>
            ) : (
              <Button
                className="h-12 w-full text-base"
                leftIcon={<ChefHat className="h-5 w-5" />}
                isLoading={pending}
                onClick={onStart}
              >
                Start preparing
              </Button>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** `2.000` reads as machinery on a kitchen screen; `2` reads as two plates. */
function trimQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
