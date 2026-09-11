'use client';

import { Filter, Search, X } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { TicketOrderDialog } from '@/components/restaurant/kitchen/ticket-order-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination, PAGE_SIZES } from '@/components/ui/pagination';
import type { Session } from '@/lib/auth';
import { formatSaleStamp } from '@/lib/dates';
import { diningAreas, kitchen, kitchenStations, restaurantTables } from '@/lib/restaurant/api';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type {
  DiningAreaView,
  KitchenStationView,
  KitchenTicketView,
  RestaurantTableView,
} from '@/lib/restaurant/types';
import { normalizeSearchTerm } from '@/lib/search-term';

interface Props {
  session: Session;
  branchId: string;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * A list the filter panel needs and fetched once, in its three states.
 *
 * The failed state is kept apart from an empty list on purpose: a station row
 * with no chips in it is ALSO what a failed fetch looks like, and a cook shown
 * nothing would read "this branch has no stations" — false on every branch,
 * since D152 gives each one a Main — rather than "try again".
 */
type Fetched<T> = { status: 'loading' } | { status: 'ready'; rows: T } | { status: 'error' };

/** One dining area's tables, in the order the floor shows them. */
interface TableGroup {
  area: DiningAreaView;
  tables: RestaurantTableView[];
}

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
 * D152 — seven columns, and the seventh is the station again. D147 cut a round
 * down to ONE ticket routed nowhere, because there was no dependable place to
 * say which station cooks a dish. The station is now chosen when a menu item is
 * created, and a branch's "Main" catches anything still undecided, so a ticket
 * is one station's share of a round once more — and "which section cooked that"
 * is a question this record can answer again.
 *
 * D175 — the station and the table are FILTERS now, not legs of the search
 * term. D152 had put the station name back into the free-text search beside the
 * ticket number, the order number, where it went and the dishes; a term is the
 * wrong tool for either. "Grill" typed into a box that also matches dish names
 * finds the grilled prawns as readily as the Grill station, and "3" finds every
 * ticket with a 3 in its number. Both are closed sets the branch already knows,
 * so the panel under the Filters button offers them as chips — multi-select on
 * each axis, and the two axes AND together on the server — while the term keeps
 * the three things that are genuinely typed from memory: ticket number, order
 * number and dish. The table is the session's table, so a takeaway ticket has
 * none and is on this screen only while the table set is empty.
 *
 * The station is NULLABLE here and stays that way. A ticket cut during the D147
 * window was routed to no station and nothing was backfilled, so those rows have
 * no name to print and get the same em dash this table uses everywhere else for
 * a value it simply does not have — not "no station", which would describe a
 * routing fault that D152 has made impossible. Such a ticket belongs to no
 * station and so is under no station chip either.
 */
/**
 * Areas at or above this position are the server's synthetic holders for
 * takeaway (999) and delivery (998) sessions, not places a guest sits.
 * Mirrors `WALK_IN_AREA_POSITION` in the API's takeaway service.
 */
const SYNTHETIC_AREA_POSITION_FLOOR = 998;

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
   * D175 — the structured filters. Each is the SET of selected ids; empty is
   * "no filter on that axis", never "match nothing".
   *
   * The panel is closed until asked for. The search box is what most visits
   * want and the chips for a thirty-table floor would push the record itself
   * below the fold on a wall tablet; the button carries a count so a filter
   * left set behind a closed panel is never invisible.
   */
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [stationIds, setStationIds] = React.useState<string[]>([]);
  const [tableIds, setTableIds] = React.useState<string[]>([]);
  const [stations, setStations] = React.useState<Fetched<KitchenStationView[]>>({
    status: 'loading',
  });
  const [tableGroups, setTableGroups] = React.useState<Fetched<TableGroup[]>>({
    status: 'loading',
  });
  const panelId = React.useId();

  /*
   * The shared normaliser, not a bare trim: the server matches literally, so
   * "rice  curry" typed with two spaces would find nothing while the operator
   * watched a dish they can see on the board fail to appear.
   */
  React.useEffect(() => {
    const id = window.setTimeout(() => setTerm(normalizeSearchTerm(search)), 250);
    return () => window.clearTimeout(id);
  }, [search]);

  /*
   * Narrowing returns to page 1: staying on page 6 of a result set that now has
   * two pages shows an empty table and reads as "no matches". D175's filters
   * narrow exactly as the term does and reset the same way — without the
   * debounce, which exists for typing; a chip is one deliberate tap.
   */
  React.useEffect(() => {
    setPage(1);
  }, [term, pageSize, branchId, stationIds, tableIds]);

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
      .history(session, branchId, {
        page,
        pageSize,
        search: term || undefined,
        // An empty set is no filter, and travels as no parameter — the same
        // rule as the blank term above, so the request for "everything" is the
        // request it has always been.
        stationIds: stationIds.length > 0 ? stationIds : undefined,
        tableIds: tableIds.length > 0 ? tableIds : undefined,
      })
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
  }, [session, branchId, page, pageSize, term, stationIds, tableIds]);

  /*
   * D175 — the two lists the panel is built from, fetched ONCE per branch and
   * not on opening the panel: a filter that appeared a beat after the button
   * was pressed would be pressed again. Both come from their own endpoints
   * rather than from the tickets on screen, for the board's reason (D152): a
   * chip that exists only while a ticket for it is on the current page is not a
   * filter. Kitchen staff hold PLATFORM_PROFILE_READ, which is what all three
   * routes require.
   *
   * The two fetches are independent, and so are their failures: the areas
   * being down must not blank the station row, whose own request succeeded.
   */
  React.useEffect(() => {
    let cancelled = false;
    setStations({ status: 'loading' });
    setTableGroups({ status: 'loading' });
    void kitchenStations
      .list(session, branchId)
      .then((list) => {
        // Active only: an archived station cooks nothing now, and a chip for
        // it would filter down to whatever it cooked before it went.
        if (!cancelled) setStations({ status: 'ready', rows: list.filter((st) => st.isActive) });
      })
      .catch(() => {
        if (!cancelled) setStations({ status: 'error' });
      });
    void diningAreas
      .list(session, branchId)
      .then(async (areas) => {
        /*
         * D175 — a takeaway has no table a person would pick. The server parks
         * takeaway and delivery sessions on synthetic areas it creates lazily
         * (position 999 for walk-in, 998 for the delivery hub) so that every
         * session can hang off a table row. `diningAreas.list` returns those
         * areas like any other, and left in they would put a "Walk In" chip in
         * this panel — selecting it would admit takeaway tickets, which is the
         * opposite of what "filter by table" means. Hidden here rather than on
         * the server, because the floor plan DOES want to show them.
         */
        const real = areas.filter((a) => a.position < SYNTHETIC_AREA_POSITION_FLOOR);
        const sorted = real.slice().sort((a, b) => a.position - b.position);
        // No per-area `.catch(() => [])` as the floor does: an area silently
        // missing from a FILTER is a table nobody can select and no sign that
        // it exists, so one failed area makes the whole group unavailable.
        const lists = await Promise.all(sorted.map((a) => restaurantTables.list(session, a.id)));
        return (
          sorted
            .map((area, i) => ({
              area,
              tables: (lists[i] ?? [])
                .slice()
                .sort((x, y) =>
                  x.code.localeCompare(y.code, undefined, { numeric: true, sensitivity: 'base' }),
                ),
            }))
            // An area with no tables has nothing to offer, and a heading over an
            // empty row reads as a fetch that failed.
            .filter((group) => group.tables.length > 0)
        );
      })
      .then((groups) => {
        if (!cancelled) setTableGroups({ status: 'ready', rows: groups });
      })
      .catch(() => {
        if (!cancelled) setTableGroups({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  const toggleStation = (id: string) =>
    setStationIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleTable = (id: string) =>
    setTableIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const clearFilters = () => {
    setStationIds([]);
    setTableIds([]);
  };
  const activeFilters = stationIds.length + tableIds.length;

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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            // D175 — three legs, and the hint names exactly those. The station
            // and the table are chips under Filters now; a hint that still
            // listed them would send a cook typing "Grill" into a search that
            // matches dish names and answers with the grilled prawns.
            placeholder="Search ticket, order, or dish…"
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
        {/* D175 — the button reads "Filters · 2" while anything is set, so a
            narrowed list behind a CLOSED panel still says why it is narrow. The
            count is of selected chips, which is what "clear" will undo. */}
        <Button
          size="sm"
          variant={activeFilters > 0 ? 'secondary' : 'outline'}
          onClick={() => setFiltersOpen((v) => !v)}
          leftIcon={<Filter className="h-4 w-4" aria-hidden="true" />}
          aria-expanded={filtersOpen}
          aria-controls={panelId}
          className="h-10"
        >
          Filters{activeFilters > 0 ? ` · ${activeFilters}` : ''}
        </Button>
      </div>

      {filtersOpen ? (
        <Card id={panelId}>
          <CardContent className="space-y-4 py-4">
            <FilterGroup label="Station">
              {stations.status === 'loading' ? (
                <Unavailable>Loading stations…</Unavailable>
              ) : stations.status === 'error' ? (
                <Unavailable>Stations unavailable.</Unavailable>
              ) : stations.rows.length === 0 ? (
                <Unavailable>No active stations.</Unavailable>
              ) : (
                <div role="group" aria-label="Filter by station" className="flex flex-wrap gap-2">
                  {stations.rows.map((st) => (
                    <FilterChip
                      key={st.id}
                      pressed={stationIds.includes(st.id)}
                      onClick={() => toggleStation(st.id)}
                    >
                      {st.name}
                    </FilterChip>
                  ))}
                </div>
              )}
            </FilterGroup>

            <FilterGroup label="Table">
              {tableGroups.status === 'loading' ? (
                <Unavailable>Loading tables…</Unavailable>
              ) : tableGroups.status === 'error' ? (
                <Unavailable>Tables unavailable.</Unavailable>
              ) : tableGroups.rows.length === 0 ? (
                <Unavailable>No tables.</Unavailable>
              ) : (
                /*
                 * Grouped under the area's name rather than prefixed with it:
                 * two areas can each have a "Table 1", and the label alone
                 * cannot tell the Garden's from the Terrace's. The area heading
                 * is the group's accessible name for the same reason.
                 */
                <div role="group" aria-label="Filter by table" className="space-y-2">
                  {tableGroups.rows.map(({ area, tables }) => {
                    const headingId = `${panelId}-area-${area.id}`;
                    return (
                      <div
                        key={area.id}
                        role="group"
                        aria-labelledby={headingId}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span id={headingId} className="mr-1 text-sm text-muted-foreground">
                          {area.name}
                        </span>
                        {tables.map((t) => (
                          <FilterChip
                            key={t.id}
                            pressed={tableIds.includes(t.id)}
                            onClick={() => toggleTable(t.id)}
                          >
                            {t.label ?? `Table ${t.code}`}
                          </FilterChip>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </FilterGroup>

            {activeFilters > 0 ? (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

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
                {/* D152 — between what was cooked and when it started: the
                    station belongs with the dishes it cooked, not out beyond
                    the stamps that answer a different question. */}
                <th scope="col" className="px-4 py-3 font-medium">
                  Station
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
                  <td colSpan={7} className="px-4 py-16 text-center text-muted-foreground">
                    Loading history…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-muted-foreground">
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
                        the fact that this screen would have shown it.

                        D175 — a filter narrows exactly as a term does, so a
                        set filter with no term is "no match" too: "nothing has
                        reached this kitchen" over a Grill chip would tell a
                        branch with a full history that it had none. */}
                    {status === 'error'
                      ? 'History unavailable.'
                      : term && activeFilters > 0
                        ? `No tickets match “${term}” under these filters.`
                        : term
                          ? `No tickets match “${term}”.`
                          : activeFilters > 0
                            ? 'No tickets match these filters.'
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
                    {/* D152 — which section cooked this share of the round. A
                        ticket cut during the D147 window carries no station and
                        none was backfilled, so it reads as the em dash the rest
                        of this table uses for a value it does not have; every
                        ticket cut since carries a real one, Main at worst. */}
                    <td className="whitespace-nowrap px-4 py-3">{t.stationName ?? '—'}</td>
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

/** One axis of the D175 panel: a heading and whatever the axis has to offer. */
function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

/** What an axis says instead of chips — loading, failed, or genuinely empty. */
function Unavailable({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * A toggleable chip. `aria-pressed` rather than a checkbox: it is the board's
 * station chip (D152) with a second state, and a cook who has used one has
 * used the other.
 */
function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center rounded-full px-3 text-sm font-medium transition-colors ${
        pressed ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-border'
      }`}
    >
      {children}
    </button>
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
