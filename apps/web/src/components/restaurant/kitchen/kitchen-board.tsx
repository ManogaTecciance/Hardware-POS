'use client';

import { Check, ChefHat, Clock, ListTree, RotateCcw, UtensilsCrossed } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { TicketOrderDialog } from '@/components/restaurant/kitchen/ticket-order-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { kitchen } from '@/lib/restaurant/api';
import { playNewOrderChime } from '@/lib/restaurant/new-order-chime';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type { KitchenLaneCounts, KitchenTicketView } from '@/lib/restaurant/types';

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
   * D142b — the counts for the lanes this board is NOT fetching. The active
   * lane keeps deriving its own from the list it already has, so a bump moves
   * its chip instantly instead of waiting up to five seconds for the poll.
   */
  const [counts, setCounts] = React.useState<KitchenLaneCounts | null>(null);

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
    key: (typeof FETCH_FOR)[Filter];
    ids: Set<string>;
  } | null>(null);

  const load = React.useCallback(async () => {
    // D115 — keyed on the FETCH, not the tab: To make ↔ Preparing share the
    // outstanding list, so flipping between them keeps the baseline and a
    // genuine arrival rings on either; Done re-baselines as before.
    const fetchFilter = FETCH_FOR[filter];
    try {
      const next = await kitchen.listTickets(session, branchId, fetchFilter);
      setTickets(next);
      setStatus('ready');
      const prev = chimeBaseline.current;
      // Only outstanding work rings: a ticket appearing on Done is someone
      // bumping, not work arriving. A recall by ANOTHER screen does ring —
      // it lands on the outstanding list as a ticket the pass has not seen.
      if (
        fetchFilter === 'OUTSTANDING' &&
        prev?.key === fetchFilter &&
        next.some((t) => !prev.ids.has(t.id))
      ) {
        playNewOrderChime();
      }
      chimeBaseline.current = { key: fetchFilter, ids: new Set(next.map((t) => t.id)) };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load kitchen tickets');
      setStatus('error');
    }
    /*
     * Best effort, and deliberately after the list: a chip without a number is
     * a smaller problem than a board that will not load, so a failing count
     * must not take the tickets down with it. The last known numbers stay on
     * screen rather than blinking out on one bad poll.
     */
    try {
      setCounts(await kitchen.laneCounts(session, branchId));
    } catch {
      /* keep whatever the last successful poll reported */
    }
  }, [session, branchId, filter]);

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

  /** The lane the active tab shows. There is no further cut: every ticket a
      branch is working on belongs on this board, one card per round (D147). */
  const visible = inLane(tickets, filter);

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
   */
  const laneCount = (key: Filter): number | null =>
    FETCH_FOR[key] === FETCH_FOR[filter]
      ? inLane(tickets, key).length
      : (counts?.[COUNT_KEY[key]] ?? null);

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
            {filter === 'TO_MAKE'
              ? 'Nothing to make. New tickets appear here as waiters send them.'
              : filter === 'PREPARING'
                ? canUpdate
                  ? 'Nothing on the stove. Start a ticket from To make.'
                  : // D94 — the till reads the board but holds no verb; do not send
                    // it to a button it does not have.
                    'Nothing on the stove.'
                : 'Nothing finished today yet. Earlier tickets are in Ticket history.'}
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
 * One card — one round, whole (D147).
 *
 * A card used to be one STATION's share of a round, so a single "send" broke
 * the table across as many cards as it had stations, and the grill could not
 * tell whether it was plating alone or alongside a curry the main kitchen had
 * not started. Worse, a dish linked to no station reached no card at all: with
 * more than one station in the branch the routing had nowhere to put it, so it
 * was ordered, billed and never cooked. There is no reachable screen for
 * linking a dish to a station, which made that the ordinary case rather than
 * the edge one. The round is now the unit: every item a waiter confirmed in it
 * is on this card, and the Details dialog remains the way to see the rest of
 * the ORDER — the earlier rounds this card is not.
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
   * D147 — order, round, waiter. This line is built as a FILTERED JOIN rather
   * than as fragments each prefixed with ` · `: the prefix form was only ever
   * safe while its first part was always present, and it emits a leading
   * separator the moment that part goes missing — which, with the station gone
   * from every ticket, is now the ordinary card. Nothing left is guaranteed
   * either (a takeaway before its order number lands carries none of the
   * three), which is why an empty line is dropped instead of printed.
   */
  const provenance = [
    ticket.orderNumber,
    ticket.roundNumber ? `round ${ticket.roundNumber}` : null,
    ticket.waiterName,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    // The board is a grid, so the row stretches every card to its tallest
    // member. `h-full` is what makes this card ACCEPT that height, and without
    // it the actions' `mt-auto` below has nothing to push against — the two
    // only line a row's buttons up as a pair.
    <Card
      className={`flex h-full flex-col ${done ? 'opacity-70' : (URGENCY_CARD_CLASS[urgency] ?? '')}`}
    >
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
