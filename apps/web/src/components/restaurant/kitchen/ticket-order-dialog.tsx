'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { Session } from '@/lib/auth';
import { kitchen } from '@/lib/restaurant/api';
import type { KitchenOrderView, KitchenTicketView } from '@/lib/restaurant/types';

/**
 * D83 — the whole order behind one ticket: every item the table asked for,
 * grouped by round.
 *
 * Extracted from the kitchen board by D142a so the history screen opens the
 * SAME dialog. A ticket is ONE STATION's share of one round (D152), so the card
 * and the history row both show a slice — this station's dishes from this
 * round, not the curry the main kitchen is plating alongside them and not the
 * two rounds the table ate an hour ago; this is the only place either can see
 * what the table actually ordered, and a second copy of it would be a second
 * answer to that question.
 *
 * D152 — the station is back on the item lines, and it is what makes this view
 * worth opening: a card shows only what THIS station is making, which is right
 * for cooking and wrong for timing. The grill cannot otherwise tell whether it
 * is plating alone or alongside a curry the main kitchen has not started.
 *
 * What does NOT come back is the chip's other state. Before D147 an item with
 * no station link printed "no station" in warning colours, which was most of
 * them and read as a fault on the plate rather than on the setup. D152 settles
 * that at the routing end — an unlinked dish cooks at Main — so an item the
 * join cannot name is simply left unlabelled rather than flagged.
 */
export function TicketOrderDialog({
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
                      {/* D152 — the station is what makes this view worth
                          opening: it says who else is working on this table.
                          Muted, never the warning tone the pre-D147 chip used
                          for its empty half — see the note at the top. */}
                      {item.stationName ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {item.stationName}
                        </span>
                      ) : null}
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

function trimQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
