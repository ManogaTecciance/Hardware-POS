'use client';

import { Check, Clock, Loader2, ListTree, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ChipRow } from '@/components/ui/chip-row';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { kitchen } from '@/lib/restaurant/api';
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

/**
 * The kitchen board (D68).
 *
 * Every item a waiter confirms onto an order lands here within a poll of
 * being sent, and this screen is the ONLY place it is ever delivered —
 * nothing prints. That raises the bar on what a card has to carry: the pass
 * cannot plate a dish it can see but cannot place, so each ticket names its
 * table, its order and its round the way a printed KOT used to.
 *
 * Kitchen staff mark a ticket done when the food is up. That is the whole
 * write surface; the floor is not theirs and neither is the money.
 *
 * Polls every 5 s. Shorter cadences read as jitter on a wall-mounted screen;
 * longer ones leave a dish sitting unseen while a table waits.
 */
export function KitchenBoard({ session, branchId }: Props) {
  const { hasPermission } = useAuth();
  const canComplete = hasPermission(Permission.KITCHEN_STATUS_UPDATE);

  const [tickets, setTickets] = React.useState<KitchenTicketView[]>([]);
  const [filter, setFilter] = React.useState<Filter>('OUTSTANDING');
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  /** D83 — the ticket whose whole order is being read. */
  const [detailFor, setDetailFor] = React.useState<KitchenTicketView | null>(null);

  const load = React.useCallback(async () => {
    try {
      setTickets(await kitchen.listTickets(session, branchId, filter));
      setStatus('ready');
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

  const complete = async (ticket: KitchenTicketView) => {
    setPending((cur) => new Set(cur).add(ticket.id));
    setError(null);
    try {
      await kitchen.complete(session, branchId, ticket.id);
      /*
       * Drop the card immediately rather than waiting for the next poll: on
       * a busy pass a button that stays put for five seconds gets pressed
       * again, and the person doing it has both hands full.
       */
      setTickets((cur) => cur.filter((t) => t.id !== ticket.id));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark this ticket done');
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
              canComplete={canComplete && t.status !== 'COMPLETED'}
              pending={pending.has(t.id)}
              onComplete={() => void complete(t)}
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
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {!order && !error ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
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
    </Dialog>
  );
}

function TicketCard({
  ticket,
  canComplete,
  pending,
  onComplete,
  onDetails,
}: {
  ticket: KitchenTicketView;
  canComplete: boolean;
  pending: boolean;
  onComplete: () => void;
  onDetails: () => void;
}) {
  const done = ticket.status === 'COMPLETED';
  return (
    <Card className={done ? 'opacity-70' : undefined}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* The place is the biggest thing on the card: a dish the pass
                cannot place is a dish that does not leave the kitchen. */}
            <p className="truncate text-lg font-semibold">
              {ticket.placeLabel ?? 'No table'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {ticket.stationName}
              {ticket.orderNumber ? ` · ${ticket.orderNumber}` : ''}
              {ticket.roundNumber ? ` · round ${ticket.roundNumber}` : ''}
              {ticket.waiterName ? ` · ${ticket.waiterName}` : ''}
            </p>
          </div>
          <StatusBadge
            tone={KITCHEN_TICKET_STATUS_TONES[ticket.status]}
            label={KITCHEN_TICKET_STATUS_LABELS[ticket.status]}
          />
        </div>

        <ul className="space-y-2">
          {ticket.items.map((item) => (
            <li key={item.id} className="text-sm">
              <span className="font-medium">
                {trimQuantity(item.quantity)}× {item.menuItemName}
                {item.variantName ? ` (${item.variantName})` : ''}
              </span>
              {item.modifierNames.length > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  {item.modifierNames.join(', ')}
                </span>
              ) : null}
              {item.specialInstructions ? (
                // Special instructions are the one thing on a ticket that
                // ruins a plate when missed, so they are not muted.
                <span className="block text-xs font-medium text-warning">
                  {item.specialInstructions}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {done ? (
              <>
                <Check className="h-3.5 w-3.5" />
                {ticket.completedByName ?? 'Done'}
                {ticket.completedAt ? ` · ${formatTime(ticket.completedAt)}` : ''}
              </>
            ) : (
              <>
                <Clock className="h-3.5 w-3.5" />
                {formatElapsed(ticket.createdAt)} · {ticket.ticketNumber}
              </>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<ListTree className="h-4 w-4" />}
              onClick={onDetails}
            >
              Details
            </Button>
            {canComplete ? (
              <Button
                size="sm"
                leftIcon={<UtensilsCrossed className="h-4 w-4" />}
                isLoading={pending}
                onClick={onComplete}
              >
                Mark done
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** `2.000` reads as machinery on a kitchen screen; `2` reads as two plates. */
function trimQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
