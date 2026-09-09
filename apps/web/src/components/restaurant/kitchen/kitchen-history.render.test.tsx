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
    // D138a — a row opens the whole order behind its ticket, through the same
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
    // D143 — a ticket is the whole round and is routed to no station, so
    // every ticket cut since that decision carries none.
    stationId: null,
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
 * D143 — a row that still CARRIES a station, exactly as an older server sent
 * it (and as every ticket cut before the decision still stores).
 *
 * The negatives below say the table names no station. Against a fixture with
 * no station in it they would be VACUOUS — green on a table that had simply
 * been handed nothing to print, which is the shape D30 forbids. So the wire
 * keeps the field the view type no longer declares: if the Station column, or
 * the dialog's chip, ever comes back, "Hot line" is on screen and these tests
 * go red. Proven by mutation at the foot of this file.
 */
function withStationOnTheWire(
  t: KitchenTicketView,
  stationName = 'Hot line',
): KitchenTicketView {
  return { ...t, stationId: 'stn_hot', stationName } as KitchenTicketView;
}

/**
 * Nowhere in `root` does the station appear — neither the NAME the wire
 * carried nor the word itself (the dialog's other chip state read "no
 * station", and a name-only check would let that back in).
 *
 * Shared so the mutation proof at the foot of this file can run it against the
 * markup this slice removed and show it fail: an assertion no fixture can
 * break is not an assertion.
 */
function expectNoStationAnywhere(root: HTMLElement, name = 'Hot line') {
  expect(root.textContent ?? '').not.toContain(name);
  expect(root.textContent ?? '').not.toMatch(/station/i);
}

function page(items: KitchenTicketView[], over: Record<string, unknown> = {}) {
  return { items, total: items.length, page: 1, pageSize: 20, ...over };
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
    // The row is handed a station it must not print (D143).
    history.mockResolvedValue(page([withStationOnTheWire(ticket())]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());
    const row = screen.getByText('K-000123').closest('tr')! as HTMLElement;
    expect(within(row).getByText('T3 · Garden')).toBeTruthy();
    expect(within(row).getByText(/O-000045 · Round 2/)).toBeTruthy();
    expect(within(row).getByText('2 × Chicken Kottu')).toBeTruthy();
    expect(within(row).getByText('Chef Perera')).toBeTruthy();
    // NEGATIVE — a ticket is the whole round, so the row has no station to
    // name; the fixture is still carrying one, so this can genuinely fail.
    expectNoStationAnywhere(row);
  });

  it('says nothing is here yet when the branch has finished nothing', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    await waitFor(() =>
      expect(screen.getByText(/No tickets have been finished in this branch yet/)).toBeTruthy(),
    );
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
    expect(screen.queryByText(/have been finished in this branch yet/)).toBeNull();
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

describe('opening a record', () => {
  /*
   * D143 rewrote what this test claims. A ticket used to be one STATION's
   * share of a round, so the dialog's job was to show the stations either
   * side of it; a ticket is now the whole round, so its job is to show the
   * ROUNDS either side of it — the two courses this table has already eaten,
   * which the row still cannot show. The station chips it used to assert are
   * asserted absent instead: the wire below still carries them.
   */
  it('shows the WHOLE order behind the ticket — every round of it, not just this ticket’s', async () => {
    history.mockResolvedValue(page([withStationOnTheWire(ticket())]));
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
          // The chip's OTHER state: an unlinked dish used to be labelled "no
          // station" in warning colours, which described the setup and read
          // as a fault on the plate. `expectNoStationAnywhere` refuses the
          // word as well as the name, so that half cannot creep back either.
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
    // NEGATIVE (D143) — the per-item station chip is gone, both of its
    // states. The items above still arrive with a station on them, so a chip
    // that came back would put "Hot line" inside this dialog.
    expectNoStationAnywhere(dialog);
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

    // The dishes cell: a plain, non-interactive cell, which is what the row
    // shortcut is for. It used to be the Station cell, which D143 removed.
    fireEvent.click(screen.getByText('2 × Chicken Kottu'));
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
    expect(screen.queryByText(/have been finished in this branch yet/)).toBeNull();
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
 * D143 — the table's columns, as an exact SET.
 *
 * A ticket is the whole round now and is routed to no station, so the Station
 * column has nothing to put in it. The set is asserted whole rather than by
 * absence: "there is no Station column" alone would still pass on a table that
 * had lost the Items column too, or on one that had renamed Station to
 * "Kitchen". And the two full-width rows are checked against the header count
 * rather than against the literal 6, because a stale `colSpan` is exactly the
 * damage removing a column does — the empty state would sit under a phantom
 * seventh column and pull the row wider than the table.
 */
describe('the columns (D143)', () => {
  const headerNames = () =>
    screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim());

  it('offers exactly Ticket, Where, Items, Started, Finished and By', async () => {
    history.mockResolvedValue(page([withStationOnTheWire(ticket())]));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    expect(headerNames()).toEqual(['Ticket', 'Where', 'Items', 'Started', 'Finished', 'By']);
    // NEGATIVE, spelled out as well as implied by the set above, because this
    // is the column the decision removed.
    expect(screen.queryByRole('columnheader', { name: 'Station' })).toBeNull();
  });

  it('spans the empty state across every column the header actually has', async () => {
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    const cell = await screen.findByText(/No tickets have been finished in this branch yet/);
    const td = cell.closest('td')!;
    expect(Number(td.getAttribute('colspan'))).toBe(headerNames().length);
  });

  it('spans the loading row across them too', async () => {
    // Never settles: the first paint is the state under test.
    history.mockReturnValue(new Promise(() => undefined));
    render(<KitchenHistory session={SESSION} branchId="brn_1" />);

    const td = (await screen.findByText(/Loading history…/)).closest('td')!;
    expect(Number(td.getAttribute('colspan'))).toBe(headerNames().length);
  });

  it('searches by ticket, order, place and dish — and no longer by station', async () => {
    // A row that IS carrying a station, so the screen-wide negative below has
    // something to catch rather than passing on an empty table.
    history.mockResolvedValue(page([withStationOnTheWire(ticket())]));
    const { container } = render(<KitchenHistory session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('K-000123')).toBeTruthy());

    // POSITIVE — the four legs the term still has, named where the operator
    // reads them. The server's other legs are pinned in the API's own suite;
    // what this screen owns is the promise it makes about them.
    const box = searchBox() as HTMLInputElement;
    expect(box.placeholder).toBe('Search ticket, order, table, or dish…');
    // NEGATIVE — nothing anywhere on the screen offers a station to search by,
    // or names one on the row it just rendered.
    expectNoStationAnywhere(container);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs (D30)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The D143 assertions above are absence claims, which are the easiest kind to
 * leave vacuous. Three things are shown here:
 *
 * 1. `expectNoStationAnywhere` genuinely fails on the markup this slice
 *    removed — the Station cell and both states of the dialog's chip.
 * 2. `withStationOnTheWire` really does hand the screen a station, so the
 *    assertions are looking at a fixture that COULD break them.
 * 3. The column set is an equality, so a column quietly added back — under
 *    any name — fails it.
 *
 * Beyond these, the real component was mutated outside the repo and the suite
 * re-run: restoring the Station <th>/<td> pair to kitchen-history.tsx turned
 * this file red, and restoring it with the old colSpan={7} turned the two span
 * assertions red as well (both killed); the repo was restored from the scratch
 * copy afterwards.
 */
describe('the D143 negatives can actually fail', () => {
  it('catches the Station cell this slice removed', () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <td className="whitespace-nowrap px-4 py-3">Hot line</td>
          </tr>
        </tbody>
      </table>,
    );
    expect(() => expectNoStationAnywhere(container)).toThrow();
  });

  it('catches both states of the dialog chip this slice removed', () => {
    const named = render(<span>Hot line</span>);
    expect(() => expectNoStationAnywhere(named.container)).toThrow();
    cleanup();

    const unnamed = render(<span>no station</span>);
    expect(() => expectNoStationAnywhere(unnamed.container)).toThrow();
  });

  it('catches a Station column added back to the set, under any name', () => {
    const withStation = ['Ticket', 'Where', 'Items', 'Station', 'Started', 'Finished', 'By'];
    const renamed = ['Ticket', 'Where', 'Items', 'Kitchen', 'Started', 'Finished', 'By'];
    const expected = ['Ticket', 'Where', 'Items', 'Started', 'Finished', 'By'];
    expect(() => expect(withStation).toEqual(expected)).toThrow();
    expect(() => expect(renamed).toEqual(expected)).toThrow();
  });

  it('hands the screen a station to print, so the negatives are not vacuous', () => {
    const row = withStationOnTheWire(ticket()) as KitchenTicketView & { stationName?: string };
    expect(row.stationName).toBe('Hot line');
    expect(row.stationId).toBe('stn_hot');
  });
});

