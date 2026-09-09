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
 * Extracted from the kitchen board by D138a so the history screen opens the
 * SAME dialog. A ticket is ONE ROUND of an order (D143), so the card and the
 * history row both show a slice — this round, not the two the table ate an
 * hour ago; this is the only place either can see what the table actually
 * ordered, and a second copy of it would be a second answer to that question.
 *
 * D143 — the item lines no longer carry a station chip. A ticket is not
 * routed to a station any more, so "who else is working on this table" is
 * answered by the round headings alone; the chip's other state said "no
 * station" in warning colours on the dish nobody had linked to one, which was
 * most of them, and read as a fault on the plate rather than on the setup.
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
