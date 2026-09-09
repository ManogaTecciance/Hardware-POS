'use client';

import { Check, ChefHat, Clock, ListTree, RotateCcw, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ChipRow } from '@/components/ui/chip-row';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { kitchen, kitchenStations } from '@/lib/restaurant/api';
import { playNewOrderChime } from '@/lib/restaurant/new-order-chime';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type {
  KitchenOrderView,
  KitchenStationView,
  KitchenTicketView,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

/*
 * D115/D116 — three lanes, bump-bar style, each ticket in exactly one: To
 * make (queued), Preparing (started, D113), Done (bumped). Cancelled work
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
const FETCH_FOR: Record<Filter, 'OUTSTANDING' | 'COMPLETED'> = {
  TO_MAKE: 'OUTSTANDING',
  PREPARING: 'OUTSTANDING',
  COMPLETED: 'COMPLETED',
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
 * table, its order and its round the way a printed KOT used to.
 *
 * Kitchen staff start a ticket when they take it (D113 — Preparing), mark
 * it done when the food is up, and recall it when the bump was wrong
 * (D100). That is the whole write surface; the floor is not theirs and
 * neither is the money. Start/done ripple to the round and any takeaway
 * profile server-side, which is what moves the Orders queue.
 *
 * Polls every 5 s. Shorter cadences read as jitter on a wall-mounted screen;
 * longer ones leave a dish sitting unseen while a table waits. The poll
 * doubles as the age-escalation tick: every refresh re-renders the cards,
 * which is where the timers and colours advance — and as the chime's watch:
 * a poll that brings an unseen ticket onto "To make" rings the same
 * new-order chime the orders queue uses, because a wall-mounted board is
 * not being stared at between tickets (mainstream KDS units beep).
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
   * The station filter. `null` is every station.
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
     * The chime answers "is there work for THIS screen?", so it hears only
     * the selected station. A grill screen ringing for a dessert is noise,
     * and silencing that is most of the reason to mount a filtered board.
     *
     * The station is part of the baseline key for the same reason the fetch
     * filter is: switching Grill → All reveals tickets this screen has never
     * seen, which is a change of view, not an arrival. Re-baseline instead of
     * ringing.
     */
    const chimeKey = `${fetchFilter}|${stationId ?? 'ALL'}`;
    try {
      const next = await kitchen.listTickets(session, branchId, fetchFilter);
      setTickets(next);
      setStatus('ready');
      const heard = stationId ? next.filter((t) => t.stationId === stationId) : next;
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
      setStatus('error');
    }
  }, [session, branchId, filter, stationId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
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
   * D115 — the lane the active tab shows, cut from the fetched list. The
   * queued family (QUEUED + the retired print statuses) is To make; started
   * tickets are Preparing; Done renders its fetch whole.
   */
  const inLane = (rows: KitchenTicketView[], lane: Filter): KitchenTicketView[] =>
    lane === 'TO_MAKE'
      ? rows.filter((t) => t.status !== 'IN_PROGRESS')
      : lane === 'PREPARING'
        ? rows.filter((t) => t.status === 'IN_PROGRESS')
        : rows;

  /*
   * The station cut comes first and everything downstream reads from it, so
   * the lane counts describe the board actually on screen. A strip reading
   * "To make 11" above two visible cards is worse than no count at all.
   */
  const scoped = stationId ? tickets.filter((t) => t.stationId === stationId) : tickets;
  const visible = inLane(scoped, filter);
  /** Both outstanding lanes' counts are live from the one shared fetch. */
  const laneCount = (key: Filter): number | null => {
    if (FETCH_FOR[filter] !== 'OUTSTANDING' || FETCH_FOR[key] !== 'OUTSTANDING') {
      return key === filter ? visible.length : null;
    }
    return inLane(scoped, key).length;
  };
  /*
   * Station counts are for the CURRENT lane across every station, so they
   * answer "where is the work?" while the lane strip answers "what state is
   * it in?". Deliberately not scoped by `stationId`: a chip that only ever
   * counted its own selection would read zero on every station but one.
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
        <span className="shrink-0 text-xs text-muted-foreground">Refreshes every 5 s.</span>
      </div>

      {/*
       * Only worth a strip when there is a routing decision to make. One
       * station means every ticket is already this screen's, and a lone
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
            {/* Naming the station matters more than the lane copy here: an
                empty board is otherwise indistinguishable from a filter the
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
              'Nothing completed yet.'
            )}
          </CardContent>
        </Card>
      ) : (
        // Three across from `lg` (1024) rather than `xl` (1280): the kitchen
        // board is usually a wall-mounted landscape tablet, where two columns
        // of narrow cards wastes half the screen the pass is reading from.
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
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
 * D83 — the whole order behind one ticket.
 *
 * A card shows only what THIS station is making, which is right for cooking
 * and wrong for timing: the grill cannot tell whether it is plating alone or
 * alongside a curry the main kitchen has not started. Every item on the
 * order is listed here with the station that received it, so the pass can
 * see the table as the guests will.
 */
function TicketOrderDialog({
  session,
  branchId,
  ticket,
  onClose,
}: {
  session: Session;
  branchId: string;
  ticket: KitchenTicketView;
  onClose: () => void;
}) {
  const [order, setOrder] = React.useState<KitchenOrderView | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    kitchen
      .order(session, branchId, ticket.id)
      .then((o) => {
        if (!cancelled) setOrder(o);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the order');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId, ticket.id]);

  const byRound = React.useMemo(() => {
    const groups = new Map<number | null, KitchenOrderView['items']>();
    for (const item of order?.items ?? []) {
      const list = groups.get(item.roundNumber) ?? [];
      list.push(item);
      groups.set(item.roundNumber, list);
    }
    return [...groups.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  }, [order]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={ticket.placeLabel ?? ticket.ticketNumber}
      description={
        order
          ? `${order.orderNumber ?? ''}${order.waiterName ? ` · ${order.waiterName}` : ''} · whole order`
          : 'Loading the order…'
      }
      className="sm:max-w-lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {/*
       * min-h on BOTH states: the dialog used to open at spinner height and
       * jump open when the order landed, which read as a glitch at the pass.
       * With a shared floor the common one-round order never resizes at all;
       * a long order still grows, but downward, once.
       */}
      <div className="min-h-44">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {!order && !error ? (
          // A skeleton in the shape of the answer: a round header and a few
          // item lines, where they will actually appear.
          <div className="space-y-3" aria-hidden>
            <div className="h-3 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-5 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-5 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-5 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ) : null}

        {order ? (
          <div className="space-y-4">
            {byRound.map(([round, items]) => (
              <div key={round ?? 'x'}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {round ? `Round ${round}` : 'Items'}
                </p>
                <ul className="space-y-1.5">
                  {items.map((item) => (
                    <li key={item.id} className="text-sm">
                      <span className="font-medium">
                        {trimQuantity(item.quantity)}× {item.name}
                        {item.variantName ? ` (${item.variantName})` : ''}
                      </span>
                      {/* The station is what makes this view worth opening: it
                          says who else is working on this table. */}
                      {item.stationName ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {item.stationName}
                        </span>
                      ) : (
                        <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning">
                          no station
                        </span>
                      )}
                      {item.modifierNames.length > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {item.modifierNames.join(', ')}
                        </span>
                      ) : null}
                      {item.specialInstructions ? (
                        <span className="block text-xs font-medium text-warning">
                          {item.specialInstructions}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

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
   * The station and the round both left this line for the ribbon, leaving the
   * order and the waiter. Joining the survivors beats prefixing each one with
   * a separator: the prefix form emits a leading " · " the moment the part
   * that used to be first is gone, which is now every ticket without an order
   * number.
   */
  const provenance = [ticket.orderNumber, ticket.waiterName].filter(Boolean).join(' · ');
  return (
    <Card
      className={`flex h-full flex-col overflow-hidden ${done ? 'opacity-70' : (URGENCY_CARD_CLASS[urgency] ?? '')}`}
    >
      {/* D68 put the station in the subtitle, where it was the first grey item
          in a truncated four-part run. A station-split order puts the SAME
          table on two cards and the station is the only thing telling a cook
          which of them is theirs, so it runs as a ribbon across the top: the
          one position that survives a narrow column, reads before the card is
          fully in view, and never competes with the place for the eye.
          `overflow-hidden` on the card is what lets the ribbon sit flush and
          take the rounded corners from its parent. */}
      <div className="flex items-center justify-between gap-2 bg-brand-50 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700">
        {/* The station can be long ("Main Kitchen") and the round never is, so
            the station takes the truncation and the round is pinned. */}
        <span className="truncate">{ticket.stationName}</span>
        {/* Absent on a legacy ticket that predates rounds, and the ribbon must
            not then render a bare "Round". */}
        {ticket.roundNumber ? <span className="shrink-0">Round {ticket.roundNumber}</span> : null}
      </div>
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
                  <span className="truncate">{ticket.ticketNumber}</span>
                </>
              )}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              leftIcon={<ListTree className="h-4 w-4" />}
              onClick={onDetails}
            >
              Details
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
