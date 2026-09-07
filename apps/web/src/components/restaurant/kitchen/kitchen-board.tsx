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
import { kitchen } from '@/lib/restaurant/api';
import { playNewOrderChime } from '@/lib/restaurant/new-order-chime';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type { KitchenOrderView, KitchenTicketView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

type Filter = 'OUTSTANDING' | 'COMPLETED';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'OUTSTANDING', label: 'To make' },
  { key: 'COMPLETED', label: 'Done' },
];

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
 * Kitchen staff start a ticket when they take it (D106 — Preparing), mark
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
  // Gates BOTH write verbs. D94 grants the till KOT_VIEW alone, so a cashier
  // sees this board with no buttons on it — that contrast is pinned by WS-408.
  const canUpdate = hasPermission(Permission.KITCHEN_STATUS_UPDATE);

  const [tickets, setTickets] = React.useState<KitchenTicketView[]>([]);
  const [filter, setFilter] = React.useState<Filter>('OUTSTANDING');
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  /** D83 — the ticket whose whole order is being read. */
  const [detailFor, setDetailFor] = React.useState<KitchenTicketView | null>(null);

  /*
   * Ticket ids seen on the last poll, per filter — the chime's memory (same
   * rule as the orders queue: null until the first response lands, so opening
   * the board never dings, and a filter switch re-baselines instead of
   * ringing for cards that merely became visible). Unlike the queue this
   * compares IDS, not a total: the list is unpaged so ids are exact, and a
   * count would stay flat when one ticket is bumped in the same poll that
   * another arrives — exactly the arrival the pass must hear.
   */
  const chimeBaseline = React.useRef<{ key: Filter; ids: Set<string> } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const next = await kitchen.listTickets(session, branchId, filter);
      setTickets(next);
      setStatus('ready');
      const prev = chimeBaseline.current;
      // Only "To make" rings: a ticket appearing on the Done tab is someone
      // bumping, not work arriving. A recall by ANOTHER screen does ring —
      // it lands on this tab as a ticket the pass has not seen.
      if (
        filter === 'OUTSTANDING' &&
        prev?.key === filter &&
        next.some((t) => !prev.ids.has(t.id))
      ) {
        playNewOrderChime();
      }
      chimeBaseline.current = { key: filter, ids: new Set(next.map((t) => t.id)) };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load kitchen tickets');
      setStatus('error');
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
   * D106 — the first tap: the card STAYS on "To make" (unlike both verbs
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ChipRow
          ariaLabel="Filter kitchen tickets"
          activeKey={filter}
          className="min-w-0 flex-1"
        >
          {FILTERS.map((f) => (
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
              {filter === f.key ? (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary-foreground/20 px-1.5 text-xs">
                  {tickets.length}
                </span>
              ) : null}
            </button>
          ))}
        </ChipRow>
        <span className="shrink-0 text-xs text-muted-foreground">Refreshes every 5 s.</span>
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
      ) : tickets.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {filter === 'OUTSTANDING'
              ? 'Nothing to make. New tickets appear here as waiters send them.'
              : 'Nothing completed yet.'}
          </CardContent>
        </Card>
      ) : (
        // Three across from `lg` (1024) rather than `xl` (1280): the kitchen
        // board is usually a wall-mounted landscape tablet, where two columns
        // of narrow cards wastes half the screen the pass is reading from.
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {tickets.map((t) => (
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
  /** D106 — started but not bumped: the card carries a Preparing badge. */
  const preparing = ticket.status === 'IN_PROGRESS';
  // Completed tickets stop ageing: the colour answers "how long has this
  // dish been waiting?", which a done dish no longer is.
  const urgency: Urgency = done ? 'fresh' : urgencyOf(ticket.createdAt, new Date());
  return (
    <Card className={done ? 'opacity-70' : URGENCY_CARD_CLASS[urgency]}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* The place is the biggest thing on the card: a dish the pass
                cannot place is a dish that does not leave the kitchen. */}
            <p className="truncate text-xl font-semibold">
              {ticket.placeLabel ?? 'No table'}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {ticket.stationName}
              {ticket.orderNumber ? ` · ${ticket.orderNumber}` : ''}
              {ticket.roundNumber ? ` · round ${ticket.roundNumber}` : ''}
              {ticket.waiterName ? ` · ${ticket.waiterName}` : ''}
            </p>
          </div>
          {done ? (
            <StatusBadge
              tone={KITCHEN_TICKET_STATUS_TONES[ticket.status]}
              label={KITCHEN_TICKET_STATUS_LABELS[ticket.status]}
            />
          ) : (
            // The timer sits where a status badge would, because on the
            // outstanding tab the age IS the status — every badge there read
            // "To make", which the tab already says. D106's Preparing is the
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

        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {done ? (
                <>
                  <Check className="h-4 w-4" />
                  {ticket.completedByName ?? 'Done'}
                  {ticket.completedAt ? ` · ${formatTime(ticket.completedAt)}` : ''}
                </>
              ) : (
                <>
                  <Clock className="h-4 w-4" />
                  {ticket.ticketNumber}
                </>
              )}
            </span>
            <Button
              size="sm"
              variant="ghost"
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
           * D106 — ONE verb per state, industry bump-bar style: a queued
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
