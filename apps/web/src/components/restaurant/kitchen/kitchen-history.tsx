'use client';

import { Search, X } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { TicketOrderDialog } from '@/components/restaurant/kitchen/ticket-order-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination, PAGE_SIZES } from '@/components/ui/pagination';
import type { Session } from '@/lib/auth';
import { formatSaleStamp } from '@/lib/dates';
import { kitchen } from '@/lib/restaurant/api';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type { KitchenTicketView } from '@/lib/restaurant/types';
import { normalizeSearchTerm } from '@/lib/search-term';

interface Props {
  session: Session;
  branchId: string;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * D142, D150 — the kitchen's history: every ticket this branch's kitchen holds.
 *
 * The board's Done lane answers "what have we finished this service" and is
 * cut to the shop's day. This answers the question that outgrew it — "when did
 * that go out, and who was on it" — over a set that only grows, so it pages and
 * searches on the SERVER. Today's tickets are in it deliberately: the lane
 * drops a ticket at midnight, and a screen that started the day after would
 * leave the one bumped an hour ago findable in neither place.
 *
 * D150 — and every LANE, not just Done. The server used to filter this list to
 * COMPLETED, so a round still queued or on the pass was on this screen nowhere:
 * searching its ticket number here answered "no tickets match" about a ticket
 * hanging on the board. The table was always built for all of it — the badge
 * names the lane, and an unfinished row simply has no finish stamp and nobody
 * to name — so what changed is the query behind it and the words around it.
 * Cancelled work stays out (D115) and there is still no date bound (D142).
 *
 * No polling. A record of what already happened does not move under the reader,
 * and a five-second refresh would fight the operator's paging.
 *
 * D147 — six columns, not seven. A ticket is a whole round rather than one
 * station's share of it, so there is no station to name here and no station
 * leg in the search: the term still matches the ticket number, the order
 * number, where it went and the dishes on it.
 */
export function KitchenHistory({ session, branchId }: Props) {
  const [rows, setRows] = React.useState<KitchenTicketView[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = React.useState('');
  const [term, setTerm] = React.useState('');
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  /*
   * In flight, as distinct from the FIRST load. `status` settles on 'ready'
   * and never goes back, so it cannot say whether a later search or page turn
   * is still running — and a pager left live during its own refetch invites a
   * second tap that lands on a page the incoming total will not have.
   */
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  /** The row whose whole order is open, or null. */
  const [detailFor, setDetailFor] = React.useState<KitchenTicketView | null>(null);

  /*
   * The shared normaliser, not a bare trim: the server matches literally, so
   * "rice  curry" typed with two spaces would find nothing while the operator
   * watched a dish they can see on the board fail to appear.
   */
  React.useEffect(() => {
    const id = window.setTimeout(() => setTerm(normalizeSearchTerm(search)), 250);
    return () => window.clearTimeout(id);
  }, [search]);

  // Narrowing returns to page 1: staying on page 6 of a result set that now has
  // two pages shows an empty table and reads as "no matches".
  React.useEffect(() => {
    setPage(1);
  }, [term, pageSize, branchId]);

  React.useEffect(() => {
    /*
     * `cancelled` is what stops an OLDER response from overwriting a newer
     * one: typing narrows the term while the previous page is still in the
     * air, and without this the slower first request lands last and the table
     * shows the wrong answer to the question on screen.
     */
    let cancelled = false;
    setLoading(true);
    kitchen
      .history(session, branchId, { page, pageSize, search: term || undefined })
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
        setStatus('ready');
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Could not load the ticket history.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId, page, pageSize, term]);

  /*
   * A row is a mouse shortcut to the same dialog its button opens. Two clicks
   * are deliberately not it: one that lands on something interactive, which
   * owns its own behaviour, and one that ends a text selection — reading a
   * ticket number off the table is a copy, not a click.
   */
  const openFrom = (event: React.MouseEvent<HTMLTableRowElement>, ticket: KitchenTicketView) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    if (window.getSelection()?.toString().trim()) return;
    setDetailFor(ticket);
  };

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticket, order, table, or dish…"
          // The server refuses a longer term with a 400 (D142's DTO). Stopping
          // it here turns a pasted paragraph into a search that finds nothing,
          // rather than into an error banner.
          maxLength={120}
          // The placeholder is not an accessible name — it disappears the
          // moment anyone types, leaving the field unlabelled.
          aria-label="Search ticket history"
          className="pl-10 pr-10"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {status === 'error' ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">
            {error ?? 'Could not load the ticket history.'}
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        {/* Wide on a wall tablet: the table scrolls inside its own box rather
            than pushing the page sideways. */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Ticket
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Where
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Items
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Started
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Finished
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  By
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {status === 'loading' ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                    Loading history…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                    {/* Three different facts, and saying the wrong one is worse
                        than saying nothing: the request failed, nothing matched
                        the term, or this kitchen has genuinely been sent
                        nothing. The failure case defers to the banner above —
                        telling a busy branch it has no history because the
                        network blipped is the one message here that is actually
                        false.

                        D150 — "no tickets yet", not "nothing finished yet". The
                        list now holds unfinished work too, so the old wording
                        would have read as "you have finished nothing" to a
                        kitchen whose only ticket was on the pass, and hidden
                        the fact that this screen would have shown it. */}
                    {status === 'error'
                      ? 'History unavailable.'
                      : term
                        ? `No tickets match “${term}”.`
                        : 'No tickets have reached this kitchen yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((t) => (
                  <tr
                    key={t.id}
                    className="cursor-pointer align-top transition-colors hover:bg-muted/50"
                    onClick={(event) => openFrom(event, t)}
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      {/*
                       * The button is the keyboard and screen-reader path; the
                       * row click is a mouse convenience over the same action
                       * (the sales list draws the same line). Naming the ticket
                       * in the label keeps twenty rows of "Details" apart.
                       */}
                      <button
                        type="button"
                        onClick={() => setDetailFor(t)}
                        aria-label={`Show the whole order for ${t.ticketNumber}`}
                        className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t.ticketNumber}
                      </button>
                      <div>
                        <StatusBadge
                          label={KITCHEN_TICKET_STATUS_LABELS[t.status]}
                          tone={KITCHEN_TICKET_STATUS_TONES[t.status]}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{t.placeLabel ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">
                        {t.orderNumber ?? '—'}
                        {t.roundNumber !== null ? ` · Round ${t.roundNumber}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">{summariseItems(t)}</td>
                    {/* When the ticket reached the kitchen and work on it began
                        — the other end of the turnaround the pass is judged on. */}
                    <td className="whitespace-nowrap px-4 py-3">
                      {formatFinishedStamp(t.createdAt)}
                    </td>
                    {/* D150 — a ticket still on the pass has no finish stamp
                        and nobody to name, so both cells read "—", and the
                        turnaround under the stamp is absent rather than a
                        running "so far" figure. This screen does not poll (a
                        record does not move under its reader), so an elapsed
                        time printed here would be wrong seconds after it
                        painted; live work is timed on the board. */}
                    <td className="whitespace-nowrap px-4 py-3">
                      {t.completedAt ? formatFinishedStamp(t.completedAt) : '—'}
                      {t.completedAt ? (
                        <div className="text-xs text-muted-foreground">
                          {formatElapsed(t.createdAt, new Date(t.completedAt))} on the pass
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{t.completedByName ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {detailFor ? (
        <TicketOrderDialog
          session={session}
          branchId={branchId}
          ticket={detailFor}
          onClose={() => setDetailFor(null)}
        />
      ) : null}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        pageSizes={PAGE_SIZES}
        disabled={loading}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

/**
 * The dishes on a ticket, in the order the kitchen received them.
 *
 * Quantities are decimal strings on the wire (D59), and a whole number of
 * portions is the overwhelming case — "3 × Kottu" rather than "3.000 × Kottu",
 * while a weighed line keeps the precision that makes it different.
 */
export function summariseItems(ticket: Pick<KitchenTicketView, 'items'>): string {
  if (ticket.items.length === 0) return '—';
  return ticket.items
    .map((i) => {
      const qty = Number(i.quantity);
      const shown = Number.isFinite(qty) && Number.isInteger(qty) ? String(qty) : i.quantity;
      return `${shown} × ${i.menuItemName}${i.variantName ? ` (${i.variantName})` : ''}`;
    })
    .join(', ');
}

/**
 * When a ticket was finished, read across days.
 *
 * Today keeps the bare time — that is what a stamp on today's service means and
 * the day would be noise on every row. Anything older leads with the day,
 * because "7:30 PM" alone on a ticket from last Tuesday reads as if it just
 * went out, and this list exists precisely to be read weeks later.
 */
export function formatFinishedStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? formatTime(iso) : `${formatSaleStamp(iso, now)} · ${formatTime(iso)}`;
}
