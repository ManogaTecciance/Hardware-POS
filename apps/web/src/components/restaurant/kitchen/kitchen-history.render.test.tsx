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
import type { KitchenTicketView } from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

const history = vi.fn();
const orderFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    history: (...args: unknown[]) => history(...args),
    // D142a — a row opens the whole order behind its ticket, through the same
    // dialog the board uses.
    order: (...args: unknown[]) => orderFn(...args),
  },
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

/** The query object of the last request the screen made. */
function lastQuery(): { page?: number; pageSize?: number; search?: string } {
  const call = history.mock.calls.at(-1);
  if (!call)
    throw new Error('the screen issued no request — every assertion below would be vacuous');
  return call[2] as { page?: number; pageSize?: number; search?: string };
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
  orderFn.mockImplementation(() => new Promise(() => undefined));
  history.mockResolvedValue(page([]));
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
    expect(within(row).getByText(/O-000045 · Round 2/)).toBeTruthy();
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
    expect(within(dialog).getByText('Round 1')).toBeTruthy();
    expect(within(dialog).getByText('Round 2')).toBeTruthy();
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

  it('searches by ticket, order, table, station and dish — the station leg is back', async () => {
    history.mockResolvedValue(page([ticket()]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    /*
     * D152 rewrote this claim. The hint read "Search ticket, order, table, or
     * dish…" while the term had no station leg; the leg is back on the server,
     * so a hint that still listed four things would send a cook who remembers
     * only "the grill" away from a search that would have answered them.
     *
     * The equality is what makes this a claim: `toContain('station')` would pass
     * on a hint that merely mentioned the word. The server's own legs are pinned
     * in the API's suite; what this screen owns is the promise it makes.
     */
    const box = searchBox() as HTMLInputElement;
    expect(box.placeholder).toBe('Search ticket, order, table, station, or dish…');
    // NEGATIVE — the D147 wording, four legs and no station, is not what the
    // box says any more.
    expect(box.placeholder).not.toBe('Search ticket, order, table, or dish…');
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
 *     KILLED.
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
