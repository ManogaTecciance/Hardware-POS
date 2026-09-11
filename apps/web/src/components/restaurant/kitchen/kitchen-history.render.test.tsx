/**
 * The ticket history screen — what it asks the server for, and what it shows.
 *
 * The query is asserted against the CALL rather than the rendered rows: an
 * empty table looks identical whether the request was wrong or there genuinely
 * were no matches, so the list cannot tell fixed from broken (the same reason
 * the Orders search spec gives).
 *
 * Both directions throughout. The two claims that matter are easy to fake:
 * a screen that never paged would pass "page 1 is requested" on its own, and a
 * screen that dropped the search term would pass "rows render" on its own.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/auth';
import type {
  DiningAreaView,
  KitchenStationView,
  KitchenTicketView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

const history = vi.fn();
const orderFn = vi.fn();
/*
 * D175 — the three lists the filter panel is built from. Separate spies so a
 * test can fail ONE of them and show the others still stand: the claim that a
 * failed station fetch does not blank the table group is only a claim if the
 * table fetch is a different call.
 */
const stationsFn = vi.fn();
const areasFn = vi.fn();
const tablesFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    history: (...args: unknown[]) => history(...args),
    // D142a — a row opens the whole order behind its ticket, through the same
    // dialog the board uses.
    order: (...args: unknown[]) => orderFn(...args),
  },
  kitchenStations: { list: (...args: unknown[]) => stationsFn(...args) },
  diningAreas: { list: (...args: unknown[]) => areasFn(...args) },
  restaurantTables: { list: (...args: unknown[]) => tablesFn(...args) },
}));

const { KitchenHistory, formatFinishedStamp, summariseItems } = await import('./kitchen-history');

const SESSION = { token: 'tok' } as unknown as Session;

function ticket(over: Partial<KitchenTicketView> = {}): KitchenTicketView {
  return {
    id: 'tkt_1',
    ticketNumber: 'K-000123',
    branchId: 'brn_1',
    roundId: 'rnd_1',
    /*
     * D152 — a ticket is one STATION's share of a round again, so every ticket
     * cut since that decision names the section that cooked it. Main at worst:
     * an item whose menu item links to no station routes to the branch's Main
     * rather than falling out of the round, so nothing raised from now on
     * arrives here unrouted.
     */
    stationId: 'stn_hot',
    stationName: 'Hot line',
    status: 'COMPLETED',
    orderNumber: 'O-000045',
    placeLabel: 'T3 · Garden',
    roundNumber: 2,
    waiterName: 'Nimal',
    items: [
      {
        id: 'itm_1',
        menuItemName: 'Chicken Kottu',
        variantName: null,
        quantity: '2.000',
        modifierNames: [],
        specialInstructions: null,
      },
    ],
    completedAt: '2026-09-08T14:05:00.000Z',
    completedByName: 'Chef Perera',
    createdAt: '2026-09-08T13:40:00.000Z',
    ...over,
  };
}

/**
 * D152 — a ticket cut during the D147 WINDOW, when a round was ONE ticket routed
 * nowhere.
 *
 * `KitchenTicket.stationId` stayed nullable through that window and D152 adds no
 * backfill, so these rows still reach this screen with no station at all and the
 * table has to say so. Every other fixture in this file carries one, and that is
 * the point: the em-dash assertions below are asserted in the SAME table as a
 * row that prints a real name, so neither direction can be green merely because
 * the column was handed nothing — the shape D30 forbids. Proven by mutation at
 * the foot of this file.
 */
function fromTheD147Window(t: KitchenTicketView): KitchenTicketView {
  return { ...t, stationId: null, stationName: null };
}

/**
 * What the Station cell of `row` prints.
 *
 * Located through the header by `cellUnder` rather than by index, and throwing
 * when the column is gone, so a deleted Station column fails these assertions
 * instead of turning them into claims about `undefined` (D30).
 */
function stationOn(row: HTMLElement): string {
  return cellUnder(row, 'Station').textContent?.trim() ?? '';
}

function page(items: KitchenTicketView[], over: Record<string, unknown> = {}) {
  return { items, total: items.length, page: 1, pageSize: 20, ...over };
}

/** The row whose Ticket cell names this ticket. */
function rowFor(ticketNumber: string): HTMLElement {
  return screen.getByText(ticketNumber).closest('tr')! as HTMLElement;
}

/**
 * The cell under a NAMED column, located through the header rather than a
 * hard-coded index.
 *
 * The D150 and D152 assertions turn on which cell holds the dash, and a
 * positional index quietly reads the wrong one the moment the columns move —
 * this table has already lost a column (D147) and got it back (D152). Throwing
 * rather than returning nothing is D30's rule for an analyser handed no input: a
 * missing column must fail the test, not turn it into an assertion about
 * `undefined`.
 */
function cellUnder(row: HTMLElement, column: string): HTMLElement {
  const headers = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim());
  const index = headers.indexOf(column);
  if (index < 0) throw new Error(`no “${column}” column: this assertion would inspect nothing`);
  const cell = row.querySelectorAll('td')[index];
  if (!cell) throw new Error(`no cell under “${column}”: this assertion would inspect nothing`);
  return cell as HTMLElement;
}

/** A clock time, however the runtime's locale data spaces or prefixes it. */
const A_TIME = /\d{1,2}:\d{2}/;

/**
 * D150 — everything a ticket still on the pass must NOT claim: no finish
 * stamp, nobody who bumped it, no turnaround.
 *
 * Shared so the mutation proof at the foot of this file can run it against a
 * row that DOES carry a finish and show it fail — a dash asserted on a table
 * that prints no times anywhere would be green for the wrong reason.
 */
function expectNoFinish(row: HTMLElement) {
  expect(cellUnder(row, 'Finished').textContent?.trim()).toBe('—');
  expect(cellUnder(row, 'Finished').textContent ?? '').not.toMatch(A_TIME);
  expect(cellUnder(row, 'By').textContent?.trim()).toBe('—');
  expect(within(row).queryByText(/on the pass/)).toBeNull();
}

/** The shape of one history read, as the screen hands it to the client. */
interface HistoryQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  /** D175 — the structured filters. Absent, not `[]`, when nothing is set. */
  stationIds?: string[];
  tableIds?: string[];
}

/** The query object of the last request the screen made. */
function lastQuery(): HistoryQuery {
  const call = history.mock.calls.at(-1);
  if (!call)
    throw new Error('the screen issued no request — every assertion below would be vacuous');
  return call[2] as HistoryQuery;
}

const searchBox = () => screen.getByLabelText('Search ticket history');

/** A promise whose settling this test controls — how two in-flight requests are
 *  made to land out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  history.mockReset();
  orderFn.mockReset();
  stationsFn.mockReset();
  areasFn.mockReset();
  tablesFn.mockReset();
  orderFn.mockImplementation(() => new Promise(() => undefined));
  history.mockResolvedValue(page([]));
  // Empty lists, not rejections: the suites above this one are about the
  // table, and a panel that failed to load would be noise in every one of them.
  // The D175 block hands the panel its own fixtures.
  stationsFn.mockResolvedValue([]);
  areasFn.mockResolvedValue([]);
  tablesFn.mockResolvedValue([]);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Type a term and let the 250 ms debounce fire. */
async function type(term: string) {
  fireEvent.change(searchBox(), { target: { value: term } });
  await vi.advanceTimersByTimeAsync(300);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('what the screen shows', () => {
  it('renders a finished ticket with where it went, what was on it and who bumped it', async () => {
    history.mockResolvedValue(page([ticket()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
    const row = screen.getByText('K-000123').closest('tr')! as HTMLElement;
    expect(within(row).getByText('T3 · Garden')).toBeTruthy();
    expect(within(row).getByText(/O-000045 · 2nd send/)).toBeTruthy();
    expect(within(row).getByText('2 × Chicken Kottu')).toBeTruthy();
    expect(within(row).getByText('Chef Perera')).toBeTruthy();
    /*
     * D152 rewrote this claim. It used to be `expectNoStationAnywhere(row)` —
     * the D147 negative that a whole-round ticket had no station to name. A
     * ticket is one station's share again, so the section that cooked it is on
     * the row, and the old assertion is not weakened but inverted.
     */
    expect(stationOn(row)).toBe('Hot line');
  });

  /*
   * D150 rewrote this claim. The empty state used to read "No tickets have been
   * finished in this branch yet", which was true only while the list was
   * filtered to COMPLETED; it now holds every lane, so that sentence would tell
   * a kitchen with three rounds on the pass that it had nothing — and hide the
   * fact that this screen would have shown them.
   */
  it('says nothing is here yet when the kitchen has been sent nothing', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() =>
      expect(screen.getByText(/No tickets have reached this kitchen yet/)).toBeTruthy(),
    );
    const empty = screen.getByText(/No tickets have reached this kitchen yet/);
    // NEGATIVE (D150) — the empty state does not promise a record of FINISHED
    // work. Scoped to the cell, because the table legitimately has a "Finished"
    // column header and a screen-wide match would be red for the wrong reason.
    expect(empty.textContent ?? '').not.toMatch(/finish/i);
    // NEGATIVE — the "no matches" wording belongs to a search, not to an empty
    // kitchen; a screen that showed it here would tell a new branch its history
    // was filtered away.
    expect(screen.queryByText(/No tickets match/)).toBeNull();
  });

  it('names the term when a SEARCH finds nothing — the two empties are different facts', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalled());

    await type('lamprais');

    await waitFor(() => expect(screen.getByText(/No tickets match “lamprais”/)).toBeTruthy());
    expect(screen.queryByText(/have reached this kitchen yet/)).toBeNull();
  });

  it('surfaces a failure instead of an empty table that looks like no history', async () => {
    history.mockRejectedValue(new Error('offline'));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy());
  });
});

describe('search', () => {
  it('sends the normalised term, not what was typed', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalled());

    // The server matches literally, so the inner double space would find
    // nothing for a dish that plainly exists.
    await type('  rice  curry ');

    await waitFor(() => expect(lastQuery().search).toBe('rice curry'));
  });

  it('sends no term at all when the box is cleared — a blank is not a filter', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await type('kottu');
    await waitFor(() => expect(lastQuery().search).toBe('kottu'));

    fireEvent.click(screen.getByLabelText('Clear search'));
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => expect(lastQuery().search).toBeUndefined());
    expect((searchBox() as HTMLInputElement).value).toBe('');
  });

  it('returns to page 1 when the term narrows', async () => {
    history.mockResolvedValue(page([ticket()], { total: 200 }));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(lastQuery().page).toBe(3));

    await type('kottu');

    // Staying on page 3 of a two-page result reads as "no matches" — the one
    // thing this screen must not say when there are matches.
    await waitFor(() => expect(lastQuery()).toEqual({ page: 1, pageSize: 20, search: 'kottu' }));
  });
});

describe('paging', () => {
  it('asks the server for the page it is on', async () => {
    history.mockResolvedValue(page([ticket()], { total: 200 }));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(lastQuery().page).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => expect(lastQuery().page).toBe(2));
  });

  it('pages on the SERVER — the whole history is never fetched at once', async () => {
    history.mockResolvedValue(page([ticket()], { total: 5000 }));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(history).toHaveBeenCalled());
    // A page size travels with every request. Without one the client would be
    // asking for five thousand tickets and slicing them itself.
    expect(lastQuery().pageSize).toBe(20);
    expect(lastQuery().page).toBe(1);
  });
});

describe('when a ticket started, and how long it was on the pass', () => {
  it('shows the start beside the finish, with the turnaround under it', async () => {
    history.mockResolvedValue(
      page([
        ticket({
          createdAt: '2026-09-08T13:40:00.000Z',
          completedAt: '2026-09-08T14:05:00.000Z',
        }),
      ]),
    );
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
    const row = screen.getByText('K-000123').closest('tr')!;
    // Both ends of the ticket's life, and the number the kitchen is judged on.
    expect(within(row).getByText(/25 min on the pass/)).toBeTruthy();
    // The column exists in the header, so the two stamps are labelled.
    expect(screen.getByRole('columnheader', { name: 'Started' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Finished' })).toBeTruthy();
  });

  it('NEGATIVE — a row with no finish claims no turnaround', async () => {
    history.mockResolvedValue(page([ticket({ completedAt: null })]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
    expect(screen.queryByText(/on the pass/)).toBeNull();
  });
});
/*
 * D150 — the history holds every LANE, not just Done.
 *
 * The server used to filter this list to COMPLETED, so a round still queued or
 * on the pass appeared on this screen nowhere at all: an operator searching a
 * ticket number was told no ticket matched while it hung on the board in front
 * of them. The table was always built for it — the badge names the lane, and an
 * unfinished row simply has no finish stamp and nobody to name — but nothing
 * here PROVED that, because every fixture in this file was COMPLETED.
 *
 * The three lanes are rendered into ONE table deliberately. A dash asserted on
 * a table where nothing ever prints a finish time is the vacuous shape D30
 * forbids: it would stay green if the Finished column were deleted outright.
 * Beside a bumped row that does print its stamp, the dash means what it says.
 * Proven by mutation at the foot of this file.
 */
describe('every lane, not just Done (D150)', () => {
  /** Raised, not yet started — "To make" on the board. */
  const queued = () =>
    ticket({
      id: 'tkt_q',
      ticketNumber: 'K-000201',
      status: 'QUEUED',
      completedAt: null,
      completedByName: null,
      createdAt: '2026-09-08T13:55:00.000Z',
    });

  /** Started, still on the pass — "Preparing". */
  const preparing = () =>
    ticket({
      id: 'tkt_p',
      ticketNumber: 'K-000202',
      status: 'IN_PROGRESS',
      completedAt: null,
      completedByName: null,
      createdAt: '2026-09-08T13:50:00.000Z',
    });

  /** Unfinished work first, exactly as the server now orders it (D150). */
  async function renderAllThreeLanes() {
    history.mockResolvedValue(page([queued(), preparing(), ticket()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
  }

  it('names the lane on every row — To make, Preparing and Done', async () => {
    await renderAllThreeLanes();

    expect(within(rowFor('K-000201')).getByText('To make')).toBeTruthy();
    expect(within(rowFor('K-000202')).getByText('Preparing')).toBeTruthy();
    expect(within(rowFor('K-000123')).getByText('Done')).toBeTruthy();
    /*
     * NEGATIVE — each row carries its OWN lane. The labels come from one record
     * keyed by status, so the way this breaks is every row wearing the same
     * badge: a screen that hard-coded "Done" (which is all the list used to
     * contain) would pass the three positives above one at a time and fail
     * here.
     */
    expect(within(rowFor('K-000201')).queryByText('Done')).toBeNull();
    expect(within(rowFor('K-000202')).queryByText('Done')).toBeNull();
    expect(within(rowFor('K-000123')).queryByText('To make')).toBeNull();
    expect(within(rowFor('K-000123')).queryByText('Preparing')).toBeNull();
  });

  it('leaves Finished and By empty while a ticket is on the pass — and fills them once it is bumped', async () => {
    await renderAllThreeLanes();

    for (const number of ['K-000201', 'K-000202']) {
      const row = rowFor(number);
      /*
       * POSITIVE first. The row DOES print a stamp — when the ticket reached
       * the kitchen — so the dashes below are a statement about the Finished
       * and By cells, not about a row that renders no times at all.
       */
      expect(cellUnder(row, 'Started').textContent ?? '').toMatch(A_TIME);
      expect(within(row).getByText(/2 × Chicken Kottu/)).toBeTruthy();
      // NEGATIVE — no finish, nobody on it, no turnaround.
      expectNoFinish(row);
    }

    /*
     * …and the other direction, in the SAME table: the bumped ticket prints its
     * finish stamp, who bumped it and how long it was on the pass. This is what
     * makes the dashes above meaningful rather than a fixture that never had a
     * value to show.
     */
    const done = rowFor('K-000123');
    expect(cellUnder(done, 'Finished').textContent ?? '').toMatch(A_TIME);
    expect(cellUnder(done, 'Finished').textContent?.trim()).not.toBe('—');
    expect(within(done).getByText(/25 min on the pass/)).toBeTruthy();
    expect(cellUnder(done, 'By').textContent?.trim()).toBe('Chef Perera');
  });
});

describe('opening a record', () => {
  /*
   * What this dialog is for, across two decisions. A ticket is one STATION's
   * share of one ROUND again (D152), so the row shows a slice twice over and
   * this is the only place either screen can see what the table actually
   * ordered — every round of it, including the two courses eaten an hour ago.
   */
  it('shows the WHOLE order behind the ticket — every round of it, not just this ticket’s', async () => {
    history.mockResolvedValue(page([ticket()]));
    orderFn.mockResolvedValue({
      ticketId: 'tkt_1',
      ticketNumber: 'K-000123',
      orderNumber: 'O-000045',
      placeLabel: 'T3 · Garden',
      waiterName: 'Nimal',
      placedAt: '2026-09-08T13:40:00.000Z',
      items: [
        {
          id: 'i1',
          name: 'Chicken Kottu',
          variantName: 'Large',
          quantity: '2.000',
          modifierNames: ['Extra spicy'],
          specialInstructions: 'No egg',
          roundNumber: 1,
          stationName: 'Hot line',
        },
        {
          id: 'i2',
          name: 'Watalappan',
          variantName: null,
          quantity: '1.000',
          modifierNames: [],
          specialInstructions: null,
          roundNumber: 2,
          // D152 — the per-item order view carries `stationName` again, and it
          // is nullable for the same reason the row's is: an item on a round
          // cut during the D147 window was routed nowhere. Both states are on
          // the wire here so whatever the dialog does with them is exercised.
          stationName: null,
        },
      ],
    });
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Show the whole order for K-000123/ }));

    const dialog = await screen.findByRole('dialog');
    expect(orderFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'tkt_1');
    // Every item the TABLE ordered, across stations and rounds — the row itself
    // only ever showed this ticket's own share.
    expect(within(dialog).getByText(/2× Chicken Kottu \(Large\)/)).toBeTruthy();
    expect(within(dialog).getByText(/1× Watalappan/)).toBeTruthy();
    expect(within(dialog).getByText('Extra spicy')).toBeTruthy();
    expect(within(dialog).getByText('No egg')).toBeTruthy();
    expect(within(dialog).getByText('1st send')).toBeTruthy();
    expect(within(dialog).getByText('2nd send')).toBeTruthy();
    /*
     * D152 rewrote what this test used to end with. The last assertion here was
     * `expectNoStationAnywhere(dialog)` — D147's claim that the per-item station
     * chip was gone in both of its states. Stations are back and the item view
     * carries `stationName` again, so that claim is simply false and cannot
     * stand. It is not weakened into silence but MOVED: the chip is
     * ticket-order-dialog.tsx's own markup, asserted where that component lives,
     * and what the HISTORY screen owns about the dialog is what the assertions
     * above pin — that opening a row fetches THAT ticket's order and lays out
     * every round of it. The station claim this spec owns is on the row, in
     * "the station on the row (D152)" below, against a table that renders both
     * a routed ticket and an unrouted one.
     */
  });

  it('opens from a click anywhere on the row, and closes again', async () => {
    history.mockResolvedValue(page([ticket()]));
    orderFn.mockResolvedValue({
      ticketId: 'tkt_1',
      ticketNumber: 'K-000123',
      orderNumber: 'O-000045',
      placeLabel: 'T3 · Garden',
      waiterName: 'Nimal',
      placedAt: '2026-09-08T13:40:00.000Z',
      items: [],
    });
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    // NEGATIVE first — nothing is open until something is clicked.
    expect(screen.queryByRole('dialog')).toBeNull();

    // The Station cell: a plain, non-interactive cell, which is what the row
    // shortcut is for. D147 removed it and the click moved to the dishes cell;
    // D152 gives it back, so the shortcut is exercised where it started.
    fireEvent.click(screen.getByText('Hot line'));
    const dialog = await screen.findByRole('dialog');

    // Escape rather than either Close control: the dialog offers two (a header
    // icon and a footer button, both named "Close"), and the key is the one
    // path a cook with flour on their hands actually uses.
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('two requests in the air', () => {
  it('ignores an older response that lands after a newer one', async () => {
    /*
     * The guard the component exists to have. A narrow search issued while the
     * previous page is still in flight is the ordinary case: if the slower
     * FIRST request lands last, the table shows the wrong answer to the
     * question on screen and nothing tells the operator.
     */
    const first = deferred<ReturnType<typeof page>>();
    const second = deferred<ReturnType<typeof page>>();
    history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));

    await type('kottu');
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));

    // The NEWER one answers first…
    second.resolve(page([ticket({ id: 'new', ticketNumber: 'K-NEW' })]));
    await waitFor(() => expect(screen.getByText('K-NEW')).toBeTruthy());

    /*
     * …and the older one, landing late, must not overwrite it. The flush has
     * to be an `act` over the settled promise rather than a timer tick: a
     * timer advance does not run the `.then` continuation, so this assertion
     * passed with the guard DELETED until it was mutation-proved (below).
     */
    first.resolve(page([ticket({ id: 'old', ticketNumber: 'K-STALE' })]));
    await act(async () => {
      await first.promise;
    });
    expect(screen.queryByText('K-STALE')).toBeNull();
    expect(screen.getByText('K-NEW')).toBeTruthy();
  });

  it('holds the pager still while a request is in flight, so a second tap cannot land on a stale page', async () => {
    const first = deferred<ReturnType<typeof page>>();
    history.mockReturnValueOnce(first.promise);
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));

    // In flight: every pager control is disabled.
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);

    first.resolve(page([ticket()], { total: 200 }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', false),
    );

    // A SECOND request must disable it again — the bug this replaced was a flag
    // that latched on the first load and never came back.
    const second = deferred<ReturnType<typeof page>>();
    history.mockReturnValueOnce(second.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true),
    );
    second.resolve(page([ticket()], { total: 200 }));
  });

  it('a failed load does not also claim the branch has cooked nothing', async () => {
    history.mockRejectedValue(new Error('offline'));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy());
    // NEGATIVE — the empty-state wording would be a false statement about the
    // kitchen; the table says the history is unavailable and leaves the reason
    // to the banner.
    expect(screen.queryByText(/have reached this kitchen yet/)).toBeNull();
    expect(screen.getByText('History unavailable.')).toBeTruthy();
  });
});

describe('formatFinishedStamp', () => {
  const now = new Date('2026-09-09T18:00:00.000Z');

  it('shows the time alone for today, and the day as well for anything older', () => {
    const today = formatFinishedStamp('2026-09-09T09:30:00.000Z', now);
    const older = formatFinishedStamp('2026-09-02T09:30:00.000Z', now);

    // Today: a bare time, no day anywhere in it.
    expect(today).toMatch(/\d/);
    expect(today).not.toMatch(/Sep/);
    // Older: the day leads, because a bare "9:30" on last week's ticket reads
    // as if it just went out — which is exactly what this screen is read for.
    expect(older).toMatch(/Sep/);
    expect(older.endsWith(today.slice(-2))).toBe(true);
    expect(older).not.toBe(today);
  });

  it('never renders "Invalid Date" for a stamp it cannot read', () => {
    expect(formatFinishedStamp('not-a-date', now)).toBe('—');
  });
});

describe('summariseItems', () => {
  it('drops the decimals a portion count never has, and keeps the ones a weighed line does', () => {
    expect(summariseItems({ items: [ticket().items[0]!] })).toBe('2 × Chicken Kottu');
    expect(
      summariseItems({
        items: [{ ...ticket().items[0]!, quantity: '0.750', menuItemName: 'Prawns' }],
      }),
    ).toBe('0.750 × Prawns');
  });

  it('names the variant, and says so plainly when a ticket carries nothing', () => {
    expect(
      summariseItems({
        items: [{ ...ticket().items[0]!, variantName: 'Large', quantity: '1.000' }],
      }),
    ).toBe('1 × Chicken Kottu (Large)');
    expect(summariseItems({ items: [] })).toBe('—');
  });
});

/*
 * D152 — the table's columns, as an exact SET, and where the restored one sits.
 *
 * A ticket is one station's share of a round again, so the Station column is
 * back between Items and Started: with the dishes it cooked, not out past the
 * stamps, which answer a different question. The set is asserted whole rather
 * than by presence — "there is a Station column" alone would still pass on a
 * table that had lost Items, or on one that had put the station at the end — and
 * its two neighbours are pinned as well, because a column in the wrong place is
 * exactly what a restore gets wrong. The two full-width rows are checked against
 * the header COUNT rather than the literal 7, because a stale `colSpan` is
 * exactly the damage adding a column does: the empty state would stop one column
 * short of the table's right edge.
 */
describe('the columns (D152)', () => {
  const headerNames = () =>
    screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim());

  it('offers exactly Ticket, Where, Items, Station, Started, Finished and By', async () => {
    history.mockResolvedValue(page([ticket()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    expect(headerNames()).toEqual([
      'Ticket',
      'Where',
      'Items',
      'Station',
      'Started',
      'Finished',
      'By',
    ]);
    /*
     * POSITIVE, spelled out as well as implied by the set above, because this is
     * the column the decision restored — and WHERE it sits is part of what was
     * restored, so its two neighbours are named rather than left to the set.
     */
    expect(screen.getByRole('columnheader', { name: 'Station' })).toBeTruthy();
    expect(headerNames().indexOf('Station')).toBe(headerNames().indexOf('Items') + 1);
    expect(headerNames().indexOf('Started')).toBe(headerNames().indexOf('Station') + 1);
    // NEGATIVE — D147's six-column shape, which is what this table looked like
    // an hour ago and what a half-applied restore would leave behind.
    expect(headerNames()).not.toEqual(['Ticket', 'Where', 'Items', 'Started', 'Finished', 'By']);
  });

  it('spans the empty state across every column the header actually has', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    const cell = await screen.findByText(/No tickets have reached this kitchen yet/);
    const td = cell.closest('td')!;
    expect(Number(td.getAttribute('colspan'))).toBe(headerNames().length);
    // The header count is now SEVEN, named so this stays a statement about the
    // restored column rather than a tautology of the table against itself.
    expect(headerNames()).toHaveLength(7);
  });

  it('spans the loading row across them too', async () => {
    // Never settles: the first paint is the state under test.
    history.mockReturnValue(new Promise(() => undefined));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    const td = (await screen.findByText(/Loading history…/)).closest('td')!;
    expect(Number(td.getAttribute('colspan'))).toBe(headerNames().length);
    expect(headerNames()).toHaveLength(7);
  });

  it('searches by ticket, order and dish — the station and the table are filters now', async () => {
    history.mockResolvedValue(page([ticket()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    /*
     * D175 rewrote this claim, which D152 had rewritten before it. It used to
     * pin "Search ticket, order, table, station, or dish…" — five legs, the
     * station rejoined. The station and the table have now LEFT the term for
     * the filter panel, so a hint that still promised them would send a cook
     * typing "Grill" into a search that answers with the grilled prawns. The
     * old assertion is not weakened but replaced with the new truth (D16), and
     * the wording it pinned becomes the negative below.
     *
     * The equality is what makes this a claim: `toContain('dish')` would pass
     * on a hint that merely mentioned the word. The server's own legs are
     * pinned in the API's suite; what this screen owns is the promise it makes.
     */
    const box = searchBox() as HTMLInputElement;
    expect(box.placeholder).toBe('Search ticket, order, or dish…');
    // NEGATIVE — neither D152's five-leg wording nor D147's four-leg one, both
    // of which promised a table leg the term no longer has.
    expect(box.placeholder).not.toBe('Search ticket, order, table, station, or dish…');
    expect(box.placeholder).not.toBe('Search ticket, order, table, or dish…');
    expect(box.placeholder).not.toMatch(/table|station/i);
  });
});

/*
 * D152 — the station on the row, and the fact that it is NULLABLE.
 *
 * Both rows are rendered into ONE table deliberately, exactly as D150's dashes
 * are. A dash asserted on a table where nothing ever prints a station name would
 * be green with the Station column deleted outright — the vacuous shape D30
 * forbids. Beside a row that does print a name, the dash means what it says.
 * Proven by mutation at the foot of this file.
 */
describe('the station on the row (D152)', () => {
  /** Cut today: routed to a station, the branch's Main at worst. */
  const routed = () =>
    ticket({
      id: 'tkt_r',
      ticketNumber: 'K-000301',
      stationId: 'stn_grill',
      stationName: 'Grill',
    });

  /** Cut during the D147 window: routed nowhere, and never backfilled. */
  const unrouted = () => fromTheD147Window(ticket({ id: 'tkt_u', ticketNumber: 'K-000302' }));

  async function renderBothKinds() {
    history.mockResolvedValue(page([routed(), unrouted()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000301')).toBeTruthy());
  }

  it('names the section that cooked the ticket', async () => {
    await renderBothKinds();

    expect(stationOn(rowFor('K-000301'))).toBe('Grill');
  });

  it('prints the table’s em dash for a ticket that reached no station', async () => {
    await renderBothKinds();

    /*
     * NEGATIVE, against a row that genuinely carries no station — and in the
     * same table as one that does, so a dash here cannot be the column being
     * absent. Deliberately NOT "no station": D152's Main means an unrouted DISH
     * no longer exists, so warning wording would describe a fault that cannot
     * happen, on the one ticket old enough to be innocent of it.
     */
    expect(stationOn(rowFor('K-000302'))).toBe('—');
    expect(within(rowFor('K-000302')).queryByText(/no station/i)).toBeNull();
    expect(within(rowFor('K-000302')).queryByText(/unrouted/i)).toBeNull();
    // …and the other direction in the same breath.
    expect(stationOn(rowFor('K-000301'))).not.toBe('—');
  });

  it('keeps each row’s OWN station — the column is not one value painted down it', async () => {
    history.mockResolvedValue(page([routed(), ticket(), unrouted()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000301')).toBeTruthy());

    /*
     * Three different answers in one column. A cell that hard-coded a name, or
     * read the first row's station for every row, would pass "names the section"
     * above on its own and fail here — which is the whole reason a second
     * station is in the fixture at all.
     */
    expect(stationOn(rowFor('K-000301'))).toBe('Grill');
    expect(stationOn(rowFor('K-000123'))).toBe('Hot line');
    expect(stationOn(rowFor('K-000302'))).toBe('—');
  });

  it('does not read the station off the Where cell, or the Where cell off the station', async () => {
    await renderBothKinds();

    /*
     * The two cells that could plausibly be confused for one another — both name
     * a place. A Station cell falling back to `placeLabel` (a fallback that
     * looks reasonable and is wrong) would put "T3 · Garden" here, and the
     * unrouted row's dash is what catches it.
     */
    expect(stationOn(rowFor('K-000302'))).not.toContain('T3');
    expect(cellUnder(rowFor('K-000301'), 'Where').textContent ?? '').not.toContain('Grill');
  });
});

/*
 * D175 — the station and the table are structured FILTERS, not legs of the
 * search term.
 *
 * Everything here is asserted against the CALL, for the reason at the top of
 * this file: the server does the filtering, so the rows on screen are the same
 * fixture whatever the panel sends, and a test that watched the table would be
 * green with the chips wired to nothing. The fixtures are built so that each
 * claim has something to break it: an INACTIVE station beside two active ones,
 * so "active only" is a filter and not the whole list; two areas that EACH hold
 * a "Table 1", so the grouping under the area name is what tells them apart;
 * and a station fixture that can fail on its own while the table fetch
 * succeeds. Proven by mutation at the foot of this file.
 */
describe('the filter panel (D175)', () => {
  const NOW = '2026-09-08T10:00:00.000Z';

  function station(over: Partial<KitchenStationView>): KitchenStationView {
    return {
      id: 'stn_hot',
      branchId: 'brn_1',
      code: 'HOT',
      name: 'Hot line',
      category: 'HOT',
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    };
  }

  function area(over: Partial<DiningAreaView>): DiningAreaView {
    return {
      id: 'area_g',
      branchId: 'brn_1',
      name: 'Garden',
      description: null,
      position: 1,
      isActive: true,
      createdByUserId: null,
      ...over,
    };
  }

  function table(over: Partial<RestaurantTableView>): RestaurantTableView {
    return {
      id: 'tbl_g1',
      areaId: 'area_g',
      branchId: 'brn_1',
      kind: 'PHYSICAL',
      code: '1',
      label: null,
      capacity: 4,
      positionX: null,
      positionY: null,
      status: 'AVAILABLE',
      isActive: true,
      createdByUserId: null,
      ...over,
    };
  }

  /** Two live stations and one archived one, which must NOT become a chip. */
  const STATIONS = [
    station({}),
    station({ id: 'stn_grill', code: 'GRL', name: 'Grill' }),
    station({ id: 'stn_old', code: 'OLD', name: 'Old fryer', isActive: false }),
  ];
  /** Listed out of floor order on purpose: the panel sorts by position. */
  const AREAS = [
    area({ id: 'area_t', name: 'Terrace', position: 2 }),
    area({}),
    // An area with no tables at all — a heading over an empty row would read
    // as a fetch that failed, so it must not appear.
    area({ id: 'area_bar', name: 'Bar', position: 3 }),
  ];
  /** "Table 1" exists in BOTH areas — the case the grouping exists for. */
  const TABLES: Record<string, RestaurantTableView[]> = {
    area_g: [table({ id: 'tbl_g3', code: '3', label: 'T3' }), table({})],
    area_t: [table({ id: 'tbl_t1', areaId: 'area_t' })],
    area_bar: [],
  };

  function givePanelItsLists() {
    stationsFn.mockResolvedValue(STATIONS);
    areasFn.mockResolvedValue(AREAS);
    tablesFn.mockImplementation((_s: unknown, areaId: string) =>
      Promise.resolve(TABLES[areaId] ?? []),
    );
  }

  const filtersButton = () => screen.getByRole('button', { name: /^Filters/ });
  const stationGroup = () => screen.getByRole('group', { name: 'Filter by station' });
  const areaGroup = (name: string) =>
    within(screen.getByRole('group', { name: 'Filter by table' })).getByRole('group', { name });
  const chip = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name });
  const pressed = (el: HTMLElement) => el.getAttribute('aria-pressed');

  /** Mount, wait for the first read, and open the panel with its lists in. */
  async function renderOpen(over: Record<string, unknown> = {}) {
    givePanelItsLists();
    history.mockResolvedValue(page([ticket()], over));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
    fireEvent.click(filtersButton());
    await waitFor(() => expect(chip(stationGroup(), 'Grill')).toBeTruthy());
    await waitFor(() => expect(chip(areaGroup('Garden'), 'T3')).toBeTruthy());
  }

  it('never offers the synthetic takeaway and delivery areas as table chips', async () => {
    /*
     * The server parks takeaway and delivery sessions on areas it creates
     * lazily — "Walk In" at position 999, the delivery hub at 998 — so that
     * every session hangs off a table row. `diningAreas.list` returns them
     * like any other area, and a chip for one would ADMIT takeaway tickets
     * to a filter whose whole meaning is "this table". D175's rule is that a
     * takeaway matches only when no table is chosen.
     *
     * The fixture holds both synthetic areas WITH tables, so the negative is
     * about a real choice: those tables are fetched-and-dropped, not absent.
     */
    givePanelItsLists();
    areasFn.mockResolvedValue([
      ...AREAS,
      area({ id: 'area_walkin', name: 'Walk In', position: 999 }),
      area({ id: 'area_delivery', name: 'Delivery hub', position: 998 }),
    ]);
    tablesFn.mockImplementation((_s: unknown, areaId: string) =>
      Promise.resolve(
        areaId === 'area_walkin'
          ? [table({ id: 'tbl_walkin', areaId: 'area_walkin', code: 'WALK-IN', label: null })]
          : areaId === 'area_delivery'
            ? [table({ id: 'tbl_hub', areaId: 'area_delivery', code: 'HUB', label: null })]
            : (TABLES[areaId] ?? []),
      ),
    );
    history.mockResolvedValue(page([ticket()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
    fireEvent.click(filtersButton());
    await waitFor(() => expect(chip(areaGroup('Garden'), 'T3')).toBeTruthy());

    // NEGATIVE — neither synthetic area is a group, and neither table a chip.
    const tables = screen.getByRole('group', { name: 'Filter by table' });
    expect(within(tables).queryByRole('group', { name: 'Walk In' })).toBeNull();
    expect(within(tables).queryByRole('group', { name: 'Delivery hub' })).toBeNull();
    expect(within(tables).queryByRole('button', { name: /walk-in/i })).toBeNull();
    expect(within(tables).queryByRole('button', { name: /hub/i })).toBeNull();
    // POSITIVE CONTROL — the real areas beside them are all there, so the
    // absence above is the position rule and not an empty panel.
    expect(chip(areaGroup('Garden'), 'T3')).toBeTruthy();
    expect(chip(areaGroup('Terrace'), 'Table 1')).toBeTruthy();
    // …and the synthetic areas were never even asked for their tables.
    expect(tablesFn).not.toHaveBeenCalledWith(SESSION, 'area_walkin');
    expect(tablesFn).not.toHaveBeenCalledWith(SESSION, 'area_delivery');
  });

  it('is closed until the button is pressed, and then shows both groups built from the endpoints', async () => {
    givePanelItsLists();
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalled());

    /*
     * The lists are fetched on MOUNT, not on opening: a chip that appeared a
     * beat after the button was pressed would be pressed again. All three
     * endpoints, for this branch and each of its areas — asserted before the
     * button is touched so the timing is the claim.
     */
    await waitFor(() => expect(tablesFn).toHaveBeenCalledTimes(3));
    expect(stationsFn).toHaveBeenCalledWith(SESSION, 'brn_1');
    expect(areasFn).toHaveBeenCalledWith(SESSION, 'brn_1');
    for (const id of ['area_g', 'area_t', 'area_bar']) {
      expect(tablesFn).toHaveBeenCalledWith(SESSION, id);
    }
    // NEGATIVE — nothing of the panel is on screen yet.
    expect(filtersButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Filter by station' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter by table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();

    fireEvent.click(filtersButton());

    expect(filtersButton().getAttribute('aria-expanded')).toBe('true');
    // Station: the two ACTIVE stations, as unpressed toggles.
    const stations = stationGroup();
    expect(pressed(chip(stations, 'Hot line'))).toBe('false');
    expect(pressed(chip(stations, 'Grill'))).toBe('false');
    // NEGATIVE — an archived station cooks nothing now; no chip for it.
    expect(within(stations).queryByRole('button', { name: 'Old fryer' })).toBeNull();
    expect(within(stations).getAllByRole('button')).toHaveLength(2);
    /*
     * Table: grouped under the area, labelled `label ?? Table <code>`, in floor
     * order. "Table 1" is in BOTH groups and is the same string in each, so
     * only the grouping keeps the Garden's apart from the Terrace's.
     */
    expect(pressed(chip(areaGroup('Garden'), 'Table 1'))).toBe('false');
    expect(pressed(chip(areaGroup('Garden'), 'T3'))).toBe('false');
    expect(pressed(chip(areaGroup('Terrace'), 'Table 1'))).toBe('false');
    expect(within(areaGroup('Garden')).getAllByRole('button')).toHaveLength(2);
    expect(within(areaGroup('Terrace')).getAllByRole('button')).toHaveLength(1);
    const areaNames = within(screen.getByRole('group', { name: 'Filter by table' }))
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-labelledby'))
      .map((id) => document.getElementById(id!)?.textContent);
    expect(areaNames).toEqual(['Garden', 'Terrace']);
    // NEGATIVE — the empty Bar is not a heading over nothing, and the code is
    // not printed bare where a label exists.
    expect(screen.queryByRole('group', { name: 'Bar' })).toBeNull();
    expect(within(areaGroup('Garden')).queryByRole('button', { name: 'Table 3' })).toBeNull();

    // …and the same button closes it again.
    fireEvent.click(filtersButton());
    expect(screen.queryByRole('group', { name: 'Filter by station' })).toBeNull();
    expect(filtersButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('sends a pressed station to the read, at once and back on page 1', async () => {
    await renderOpen({ total: 200 });
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(lastQuery().page).toBe(3));
    // NEGATIVE first — nothing is filtered until a chip is pressed.
    expect(lastQuery().stationIds).toBeUndefined();
    expect(lastQuery().tableIds).toBeUndefined();

    fireEvent.click(chip(stationGroup(), 'Grill'));

    /*
     * No `waitFor` and no timer advance: a chip is one deliberate tap, so the
     * request goes out in the same act as the click, where the search box
     * needs its 250 ms (see `type`). The page is 1 again for the reason the
     * search resets it — page 3 of a set that now has one page is an empty
     * table reading "no matches".
     */
    expect(lastQuery()).toEqual({ page: 1, pageSize: 20, stationIds: ['stn_grill'] });
    // Not `[]` and not the other axis: an empty set travels as no parameter.
    expect(lastQuery().tableIds).toBeUndefined();
    expect(pressed(chip(stationGroup(), 'Grill'))).toBe('true');
    expect(pressed(chip(stationGroup(), 'Hot line'))).toBe('false');
  });

  it('is a multi-select on each axis — a second station joins the set, and pressing it again removes it', async () => {
    await renderOpen();

    fireEvent.click(chip(stationGroup(), 'Grill'));
    fireEvent.click(chip(stationGroup(), 'Hot line'));
    expect(lastQuery().stationIds).toEqual(['stn_grill', 'stn_hot']);
    expect(pressed(chip(stationGroup(), 'Grill'))).toBe('true');
    expect(pressed(chip(stationGroup(), 'Hot line'))).toBe('true');

    fireEvent.click(chip(stationGroup(), 'Grill'));
    expect(lastQuery().stationIds).toEqual(['stn_hot']);
    expect(pressed(chip(stationGroup(), 'Grill'))).toBe('false');

    fireEvent.click(chip(stationGroup(), 'Hot line'));
    // Back to no filter at all — absent, not an empty array.
    expect(lastQuery().stationIds).toBeUndefined();
    expect(pressed(chip(stationGroup(), 'Hot line'))).toBe('false');
  });

  it('sends the Garden’s Table 1 and not the Terrace’s — the id, not the label', async () => {
    await renderOpen();

    fireEvent.click(chip(areaGroup('Garden'), 'Table 1'));

    expect(lastQuery().tableIds).toEqual(['tbl_g1']);
    // NEGATIVE — the chip with the same text in the other area is untouched.
    expect(lastQuery().tableIds).not.toContain('tbl_t1');
    expect(pressed(chip(areaGroup('Terrace'), 'Table 1'))).toBe('false');
    expect(lastQuery().stationIds).toBeUndefined();

    fireEvent.click(chip(areaGroup('Terrace'), 'Table 1'));
    expect(lastQuery().tableIds).toEqual(['tbl_g1', 'tbl_t1']);

    /*
     * …and pressing the Garden's again removes ONLY the Garden's. Asserted on
     * this axis as well as the station one: the two toggles are separate
     * functions, and a table toggle that only ever added survived every test
     * above until this was written (M18 in the record at the foot of the file).
     */
    fireEvent.click(chip(areaGroup('Garden'), 'Table 1'));
    expect(lastQuery().tableIds).toEqual(['tbl_t1']);
    expect(pressed(chip(areaGroup('Garden'), 'Table 1'))).toBe('false');
    expect(pressed(chip(areaGroup('Terrace'), 'Table 1'))).toBe('true');
  });

  it('sends both axes together, with the term, and returns to page 1 for a table as for a station', async () => {
    await renderOpen({ total: 200 });
    await type('kottu');
    await waitFor(() => expect(lastQuery().search).toBe('kottu'));
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(lastQuery().page).toBe(2));

    fireEvent.click(chip(areaGroup('Garden'), 'T3'));
    expect(lastQuery()).toEqual({ page: 1, pageSize: 20, search: 'kottu', tableIds: ['tbl_g3'] });

    fireEvent.click(chip(stationGroup(), 'Hot line'));
    expect(lastQuery()).toEqual({
      page: 1,
      pageSize: 20,
      search: 'kottu',
      stationIds: ['stn_hot'],
      tableIds: ['tbl_g3'],
    });
  });

  it('counts the set filters on the button, across both axes, and Clear empties both', async () => {
    await renderOpen();
    // NEGATIVE first — no number while nothing is set, and nothing to clear.
    expect(filtersButton().textContent?.trim()).toBe('Filters');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();

    fireEvent.click(chip(stationGroup(), 'Grill'));
    expect(filtersButton().textContent?.trim()).toBe('Filters · 1');
    fireEvent.click(chip(areaGroup('Terrace'), 'Table 1'));
    // One from each axis: the count is of chips, not of axes with something in.
    expect(filtersButton().textContent?.trim()).toBe('Filters · 2');
    expect(lastQuery().stationIds).toEqual(['stn_grill']);
    expect(lastQuery().tableIds).toEqual(['tbl_t1']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(lastQuery().stationIds).toBeUndefined();
    expect(lastQuery().tableIds).toBeUndefined();
    expect(lastQuery().page).toBe(1);
    expect(filtersButton().textContent?.trim()).toBe('Filters');
    expect(pressed(chip(stationGroup(), 'Grill'))).toBe('false');
    expect(pressed(chip(areaGroup('Terrace'), 'Table 1'))).toBe('false');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    // The panel itself stays open — clearing is not closing.
    expect(stationGroup()).toBeTruthy();
  });

  it('keeps the count on a CLOSED panel, so a narrowed list still says why', async () => {
    await renderOpen();
    fireEvent.click(chip(stationGroup(), 'Grill'));

    fireEvent.click(filtersButton());

    expect(screen.queryByRole('group', { name: 'Filter by station' })).toBeNull();
    expect(filtersButton().textContent?.trim()).toBe('Filters · 1');
    expect(lastQuery().stationIds).toEqual(['stn_grill']);
  });

  it('says the stations are unavailable when their fetch fails — and still offers the tables', async () => {
    givePanelItsLists();
    stationsFn.mockRejectedValue(new Error('offline'));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalled());
    fireEvent.click(filtersButton());

    await waitFor(() => expect(screen.getByText('Stations unavailable.')).toBeTruthy());
    /*
     * NEGATIVE — not the empty-list wording, and not an empty row. A station
     * group with no chips is exactly what a failed fetch looks like, and "no
     * active stations" is false on every branch (D152 gives each one a Main).
     */
    expect(screen.queryByText('No active stations.')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter by station' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grill' })).toBeNull();
    // …and the OTHER axis, whose own request succeeded, is intact.
    await waitFor(() => expect(chip(areaGroup('Garden'), 'T3')).toBeTruthy());
    expect(chip(areaGroup('Terrace'), 'Table 1')).toBeTruthy();
    expect(screen.queryByText('Tables unavailable.')).toBeNull();
  });

  it('says the tables are unavailable when any part of their fetch fails — and still offers the stations', async () => {
    givePanelItsLists();
    // The areas arrive; ONE area's tables do not. A silently missing area is a
    // table nobody can select and no sign that it exists, so the whole group
    // says so rather than showing the rest as if it were everything.
    tablesFn.mockImplementation((_s: unknown, areaId: string) =>
      areaId === 'area_t'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(TABLES[areaId] ?? []),
    );
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(history).toHaveBeenCalled());
    fireEvent.click(filtersButton());

    await waitFor(() => expect(screen.getByText('Tables unavailable.')).toBeTruthy());
    expect(screen.queryByRole('group', { name: 'Filter by table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'T3' })).toBeNull();
    expect(screen.queryByText('No tables.')).toBeNull();
    // The station axis stands.
    expect(chip(stationGroup(), 'Grill')).toBeTruthy();
    expect(screen.queryByText('Stations unavailable.')).toBeNull();
  });

  it('says "no tickets match these filters", not "nothing has reached this kitchen", over an empty filtered page', async () => {
    await renderOpen();
    history.mockResolvedValue(page([]));

    fireEvent.click(chip(stationGroup(), 'Grill'));

    await waitFor(() => expect(screen.getByText('No tickets match these filters.')).toBeTruthy());
    // NEGATIVE — the empty-kitchen wording would tell a branch with a full
    // history that it had none.
    expect(screen.queryByText(/have reached this kitchen yet/)).toBeNull();

    // With a term as well, the message names both — a cook who cleared only
    // the term would otherwise wonder why "nothing matches" nothing.
    await type('lamprais');
    await waitFor(() =>
      expect(screen.getByText('No tickets match “lamprais” under these filters.')).toBeTruthy(),
    );
    expect(screen.queryByText('No tickets match these filters.')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs (D30)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * D152's station claims are one positive and one ABSENCE — the em dash on a
 * ticket that reached no station — and the absence is the easy one to leave
 * vacuous. Four things are shown inline:
 *
 * 1. `stationOn` refuses to inspect a table that has lost the Station column,
 *    rather than reporting an empty string that would satisfy nothing and
 *    silently weaken the dash (D30's "fail when the analyser inspects nothing").
 * 2. The dash assertion genuinely fails on a row that DOES name a station, so
 *    it is not green merely because the column prints nothing anywhere.
 * 3. The fixtures really do carry both kinds — a routed ticket and an unrouted
 *    one — so neither direction is asserted against a table that could not
 *    break it.
 * 4. The column set is an equality anchored to a POSITION, so a Station column
 *    restored under the wrong name, or in the wrong place, fails it.
 *
 * Beyond these, the real component was mutated outside the repo and this spec
 * re-run against each mutant:
 *
 *  1. The Station <th>/<td> pair removed and colSpan dropped back to 6 — the
 *     whole D147 shape — KILLED (9 tests).
 *  2. The cell falling back to "no station", D147's warning wording — KILLED.
 *  3. The cell falling back to `t.placeLabel`, the plausible-looking wrong
 *     fallback, both cells naming a place — KILLED (including the Where/Station
 *     confusion test written for exactly this).
 *  4. colSpan left at 6 with the column added — the stale-span damage — KILLED.
 *  5. The column moved to the END, after By, so the set is present but the
 *     position is wrong — KILLED.
 *  6. The search hint left at D147's "Search ticket, order, table, or dish…" —
 *     KILLED. (D175 has since moved the station and the table out of the term;
 *     the hint's claim, and the mutant that proves it, are in the D175 record
 *     below.)
 *  7. The cell hard-coded to "Hot line" rather than reading the row — KILLED.
 *  8. The header renamed "Kitchen" with the cell left in place — KILLED.
 *  9. The <td> removed but the <th> left, so every cell after Items shifts one
 *     column left — KILLED, and by the D150 dashes as well as by these.
 *
 * The repo was restored from the untouched copy afterwards, verified by hash.
 */
describe('the D152 station claims can actually fail', () => {
  /** A table shaped like the real one, whose single row NAMES a station. */
  function routedRow(): HTMLElement {
    const { container } = render(
      <table>
        <thead>
          <tr>
            {['Ticket', 'Where', 'Items', 'Station', 'Started', 'Finished', 'By'].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>K-000302</td>
            <td>T3 · Garden</td>
            <td>2 × Chicken Kottu</td>
            <td>Hot line</td>
            <td>1:40 PM</td>
            <td>—</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>,
    );
    return container.querySelector('tbody tr')! as HTMLElement;
  }

  it('catches a station named where the em dash belongs', () => {
    const row = routedRow();

    expect(stationOn(row)).toBe('Hot line');
    // The dash assertion, run against a row that breaks it.
    expect(() => expect(stationOn(row)).toBe('—')).toThrow();
  });

  it('refuses to inspect a table that has lost the Station column', () => {
    const { container } = render(
      <table>
        <thead>
          <tr>
            {['Ticket', 'Where', 'Items', 'Started', 'Finished', 'By'].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>K-000302</td>
            <td>T3 · Garden</td>
            <td>2 × Chicken Kottu</td>
            <td>1:40 PM</td>
            <td>—</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>,
    );
    const row = container.querySelector('tbody tr')! as HTMLElement;

    /*
     * The D147 shape. Note what would happen WITHOUT the throw: the Finished
     * cell now sits at the index Station used to hold and already reads "—", so
     * a positional helper would report the dash and the whole "prints the em
     * dash" test would pass on a table with no Station column at all. That is
     * the exact vacuity D30 forbids, and it is one index away at all times.
     */
    expect(() => stationOn(row)).toThrow(/would inspect nothing/);
  });

  it('catches a Station column restored under the wrong name or in the wrong place', () => {
    const expected = ['Ticket', 'Where', 'Items', 'Station', 'Started', 'Finished', 'By'];
    const renamed = ['Ticket', 'Where', 'Items', 'Kitchen', 'Started', 'Finished', 'By'];
    const atTheEnd = ['Ticket', 'Where', 'Items', 'Started', 'Finished', 'By', 'Station'];
    const stillD147 = ['Ticket', 'Where', 'Items', 'Started', 'Finished', 'By'];

    expect(() => expect(renamed).toEqual(expected)).toThrow();
    expect(() => expect(atTheEnd).toEqual(expected)).toThrow();
    expect(() => expect(stillD147).toEqual(expected)).toThrow();
    // …and the neighbour assertions catch the misplacement on their own, so the
    // position is pinned twice over rather than only by the set's ordering.
    expect(() => expect(atTheEnd.indexOf('Station')).toBe(atTheEnd.indexOf('Items') + 1)).toThrow();
  });

  it('hands the screen both a routed ticket and an unrouted one, so neither direction is vacuous', () => {
    const now = ticket();
    expect(now.stationName).toBe('Hot line');
    expect(now.stationId).toBe('stn_hot');

    const old = fromTheD147Window(ticket());
    expect(old.stationName).toBeNull();
    expect(old.stationId).toBeNull();
    // The rest of the ticket is untouched, so a row that fails the dash test
    // fails it over the station and nothing else.
    expect(old.ticketNumber).toBe(now.ticketNumber);
    expect(old.status).toBe(now.status);
  });
});

/*
 * D150's dashes are absence claims too, and the failure mode to rule out is the
 * dash that is green because the assertion read the wrong cell — or no cell.
 *
 * Two things are shown inline: `expectNoFinish` genuinely fails on a row that
 * DOES carry a finish, and `cellUnder` refuses to inspect a table that has lost
 * the column it was asked about (D30's "fail when the analyser inspects
 * nothing") rather than quietly asserting about `undefined`.
 *
 * Beyond these, the real component was mutated in a scratch copy outside the
 * repo and this spec re-run:
 *
 *  1. Finished always printing a stamp (`formatFinishedStamp(t.completedAt ??
 *     t.createdAt)`) — KILLED, both pending rows failed.
 *  2. By falling back to the waiter (`t.completedByName ?? t.waiterName`) —
 *     KILLED, both pending rows failed.
 *  3. The badge hard-coded to `KITCHEN_TICKET_STATUS_LABELS.COMPLETED`, which
 *     is what a Done-only list could have got away with — KILLED.
 *  4. The turnaround line rendered unconditionally — KILLED.
 *  5. The empty state reverted to "No tickets have been finished in this branch
 *     yet." — KILLED.
 *  6. The Finished column removed outright, header and cell — KILLED by
 *     `cellUnder`, which threw rather than passing the dash by default.
 *
 * The repo was restored from the scratch copy afterwards.
 */
describe('the D150 dashes can actually fail', () => {
  /**
   * A table shaped like the real one, whose single row is FINISHED.
   *
   * Kept in step with the real header — D152 put Station back between Items and
   * Started — because `cellUnder` reads by index off the header it is given: a
   * fixture one column out of date would hand these proofs the wrong cell and
   * make them pass or fail for a reason that has nothing to do with D150.
   */
  function finishedRow(): HTMLElement {
    const { container } = render(
      <table>
        <thead>
          <tr>
            {['Ticket', 'Where', 'Items', 'Station', 'Started', 'Finished', 'By'].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>K-000201</td>
            <td>T3 · Garden</td>
            <td>2 × Chicken Kottu</td>
            <td>Hot line</td>
            <td>1:40 PM</td>
            <td>
              2:05 PM<div>25 min on the pass</div>
            </td>
            <td>Chef Perera</td>
          </tr>
        </tbody>
      </table>,
    );
    return container.querySelector('tbody tr')! as HTMLElement;
  }

  it('catches a finish stamp on a row that is supposed to be on the pass', () => {
    expect(() => expectNoFinish(finishedRow())).toThrow();
  });

  it('refuses to inspect a table that has lost the column it was asked about', () => {
    const { container } = render(
      <table>
        <thead>
          <tr>
            <th scope="col">Ticket</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>K-000201</td>
          </tr>
        </tbody>
      </table>,
    );
    const row = container.querySelector('tbody tr')! as HTMLElement;

    // Not "the Finished cell is empty, so the dash holds" — there is no such
    // cell, and a test that carried on would be asserting about nothing.
    expect(() => cellUnder(row, 'Finished')).toThrow(/would inspect nothing/);
    expect(() => cellUnder(row, 'By')).toThrow(/would inspect nothing/);
    // The column D152 restored is held to the same rule.
    expect(() => cellUnder(row, 'Station')).toThrow(/would inspect nothing/);
  });
});

/*
 * D175's filter claims are about what the screen SENDS, and the ways they go
 * vacuous are all quiet ones: a chip that renders and is wired to nothing, a
 * set that never empties, a count that reads one axis, a failed fetch that
 * looks like an empty list. Two things are shown inline in the block itself —
 * every request assertion goes through `lastQuery`, which throws rather than
 * returning `{}` when no request was made, and the fixtures carry an inactive
 * station, a duplicate "Table 1" and an empty area so that "active only",
 * "grouped by area" and "no empty heading" each have something to break them.
 *
 * Beyond these, the real component was mutated in a scratch copy outside the
 * repo and this spec re-run against each mutant:
 *
 *  1. `stationIds`/`tableIds` dropped from the page-reset effect's deps —
 *     KILLED (2 tests: both page-1 claims).
 *  2. `stationIds` never sent to the read — KILLED (5).
 *  3. The two axes SWAPPED on the wire (tables under `stationIds`) — KILLED (6).
 *  4. The station toggle only ever adding, never removing — KILLED.
 *  5. Clear emptying the stations only — KILLED.
 *  6. The badge counting stations only — KILLED (one from each axis reads 1).
 *  7. Archived stations offered as chips — KILLED ("Old fryer" appeared).
 *  8. A failed station fetch stored as `{ ready, rows: [] }`, the silent-empty
 *     shape — KILLED ("Stations unavailable." missing, empty group present).
 *  9. The panel open by default — KILLED (10; the "closed until pressed"
 *     negative and every `renderOpen`, whose click then CLOSED it).
 * 10. Tables flattened into one row with no area group — KILLED (9).
 * 11. The search hint left at D152's five-leg wording — KILLED.
 * 12. The empty state ignoring the filters, "nothing has reached this kitchen"
 *     over a set Grill chip — KILLED.
 * 13. The lists fetched on opening the panel rather than on mount — KILLED
 *     (the endpoints are asserted BEFORE the button is pressed).
 * 14. An empty set sent as `[]` rather than left off — KILLED (6, including
 *     D142's own "returns to page 1 when the term narrows", whose exact-shape
 *     `toEqual` is what makes "absent, not empty" a claim across the file).
 * 15. The table chip printing the bare code (`t.code`) instead of
 *     `label ?? Table <code>` — KILLED (9).
 * 16. One area's failed table fetch swallowed as `[]`, the floor's habit —
 *     KILLED.
 * 17. An area with no tables still given a heading — KILLED ("Bar" appeared).
 * 18. The TABLE toggle only ever adding — SURVIVED on the first run: no test
 *     pressed a table chip twice, so a second toggle function had no witness.
 *     The Garden/Terrace test now un-presses the Garden's Table 1 and asserts
 *     the Terrace's stays — re-run: KILLED.
 * 19. Table chips wired to the STATION set — KILLED (3).
 * 20. Areas rendered in list order rather than by floor position — KILLED
 *     (the fixture lists Terrace before Garden on purpose).
 *
 * Not mutated: "no debounce on a chip" has no natural one-line mutant, and is
 * pinned instead by the shape of the assertion — `lastQuery()` read in the
 * same act as the click, with no timer advance, where `type` needs 300 ms.
 *
 * The repo was restored from the untouched copy after every run, verified by
 * hash.
 */
