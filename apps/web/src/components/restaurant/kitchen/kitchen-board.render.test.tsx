/**
 * The kitchen board after D100 — age escalation, a kitchen-sized bump, and
 * recall — and after D152, which puts the station back on it.
 *
 * Everything is pinned in pairs, because each half alone is also what a
 * broken board produces:
 *
 * - Escalation: a late ticket turns red AND a fresh board carries no
 *   warning colour at all — asserting only the red half would pass on a
 *   board that painted everything red.
 * - The write gate mirrors WS-408's contrast: without KITCHEN_STATUS_UPDATE
 *   there is no Mark done and no Recall, while Details still counts the
 *   tickets (the positive control that proves the board rendered).
 * - Both verbs drop the card optimistically — the reload must not resurrect
 *   it, so the api mocks empty their rows when the verb lands.
 * - Layout: `h-full` and `mt-auto` are asserted together, because either one
 *   alone still describes a row of cards whose buttons fail to line up; the
 *   provenance row is pinned by what its row does NOT contain (the timer),
 *   which is the whole of what moving it changed.
 * - D152's ribbon is pinned by where it sits as well as by what it says:
 *   "the station is on the card" passes on the pre-D68 board too, where the
 *   station was the first grey item of a truncated subtitle, so every ribbon
 *   assertion is paired with the subtitle no longer carrying it.
 * - The station FILTER's every half has a passing twin that describes a broken
 *   board: a strip that is always shown, a filter that hides everything, and a
 *   memory that never forgets.
 * - D154's poll is asserted against the API mocks' CALL COUNTS, because a poll
 *   that never pauses and one that never resumes render the same board — and
 *   "one request per tick" is invisible on screen by definition. Both halves
 *   again: hidden must stop the interval, and coming back must refetch at once
 *   rather than waiting out the remainder of one.
 * - D174's station-scoped lane counts are pinned by a fixture in which the
 *   branch's number, each station's number and the poison the abandoned path
 *   answers ALL DIFFER, so "the chip carries a number" cannot pass on the wrong
 *   one; and the list read is asserted to stay UNSCOPED, because the station
 *   strip is counted from it and a server-cut list would read zero on every
 *   station but the one selected.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/auth';
import type {
  KitchenLaneCounts,
  KitchenStationView,
  KitchenTicketView,
} from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

let canUpdate = true;

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => canUpdate }),
}));

// D142 — the Done lane links to the history screen; the real `next/link` wants
// a router context this suite has no reason to build.
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const listFn = vi.fn();
const laneCountsFn = vi.fn();
const startFn = vi.fn();
const completeFn = vi.fn();
const reopenFn = vi.fn();
const orderFn = vi.fn();
const stationsFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    listTickets: (...args: unknown[]) => listFn(...args),
    start: (...args: unknown[]) => startFn(...args),
    complete: (...args: unknown[]) => completeFn(...args),
    reopen: (...args: unknown[]) => reopenFn(...args),
    order: (...args: unknown[]) => orderFn(...args),
    /*
     * D154 — the board stopped calling this on an unfiltered board, and the
     * standalone endpoint STAYED (other callers want the numbers without the
     * tickets). It is kept on the mock deliberately: a suite that simply
     * dropped it would make "an unfiltered board never calls laneCounts"
     * untestable — the board would throw on the missing function and fail for
     * the wrong reason — so the spy is present, answers a value nothing on
     * screen could be mistaken for, and is asserted silent there. Its ability
     * to record is proven at the foot of this file.
     *
     * D174 — under a station cut the board IS a caller again, with the
     * station: the list stays unscoped for the strip's sake, so the station's
     * three numbers come from here. The spy then answers the per-station
     * fixture below, and the poison only when asked without a station.
     */
    laneCounts: (...args: unknown[]) => laneCountsFn(...args),
  },
  // D152 — the strip's list comes from the stations endpoint, never from the
  // tickets on screen, so it is a boundary of its own.
  kitchenStations: {
    list: (...args: unknown[]) => stationsFn(...args),
  },
}));

// Sound is asserted against the chime module, same as the orders queue's
// polling suite — jsdom has no AudioContext to listen to.
const chime = vi.fn();
const printKitchenTicketFn = vi.fn();
vi.mock('@/lib/restaurant/kot-print', () => ({
  printKitchenTicket: (...a: unknown[]) => printKitchenTicketFn(...a),
}));

vi.mock('@/lib/restaurant/new-order-chime', () => ({
  playNewOrderChime: () => chime(),
}));

const { KitchenBoard } = await import('./kitchen-board');

const SESSION = { token: 'tok' } as unknown as Session;

// ── fixtures ─────────────────────────────────────────────────────────────────

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

function ticket(overrides: Partial<KitchenTicketView> & { id: string }): KitchenTicketView {
  return {
    ticketNumber: 'KOT-000001',
    branchId: 'brn_1',
    roundId: 'rnd_1',
    // D152 — a ticket is one station's share of a round again, so every ticket
    // cut since that decision names the station that cooks it. `stn_1`/'Grill'
    // matches the single station the stations endpoint is stubbed with below.
    stationId: 'stn_1',
    stationName: 'Grill',
    status: 'QUEUED',
    orderNumber: 'RO-000010',
    placeLabel: 'T1 · Main',
    roundNumber: 1,
    waiterName: 'Nimal',
    items: [
      {
        id: `it_${overrides.id}`,
        menuItemName: 'Kottu',
        variantName: null,
        quantity: '1.000',
        modifierNames: [],
        specialInstructions: null,
      },
    ],
    completedAt: null,
    completedByName: null,
    createdAt: minutesAgo(2),
    ...overrides,
  };
}

/**
 * A ticket cut during the D147 window: ONE whole round, routed to no station at
 * all, and the column was never made required so it is still on the wire.
 *
 * D152 restores the split without a migration or a backfill, which is exactly
 * why these have to be renderable: the board and the history both still carry
 * them, and a screen that assumed the station away would blow up on the oldest
 * rows in the table.
 */
function d147WindowTicket(
  overrides: Partial<KitchenTicketView> & { id: string },
): KitchenTicketView {
  return ticket({ stationId: null, stationName: null, ...overrides });
}

function station(id: string, name: string): KitchenStationView {
  return {
    id,
    branchId: 'brn_1',
    code: name.toUpperCase().replace(/\s+/g, '_'),
    name,
    category: 'FOOD',
    isActive: true,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  };
}

/**
 * Nowhere in `root` does the pre-D147 "no station" warning appear.
 *
 * D152 brings the station chip back but NOT that half of it: an item nobody
 * linked to a station cooks at Main now, so a warning on the dish would
 * describe the setup and read as a fault on the plate. This is an ABSENCE
 * claim, so it is shared with the mutation proof at the foot of this file,
 * where it is shown to fail against the markup it forbids — an assertion no
 * fixture can break is not an assertion (D30).
 */
function expectNoUnroutedWarning(root: HTMLElement) {
  expect(root.textContent ?? '').not.toMatch(/no station/i);
}

/** The text of one filter chip, whitespace-normalised, count included. */
const chipText = (name: RegExp) =>
  screen.getByRole('button', { name }).textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Mutable rows, so a verb can empty them and the reload stays honest. */
let outstandingRows: KitchenTicketView[] = [];
let doneRows: KitchenTicketView[] = [];
/*
 * D142b's other-lane numbers, which D154 moved into the ticket read's own
 * envelope. Mutable for the same reason the rows are: a later poll must be
 * able to bring different numbers, or "the counts ride along on every tick"
 * would be asserted against a constant.
 */
let serverCounts: KitchenLaneCounts = { toMake: 0, preparing: 0, doneToday: 0 };
/*
 * D174 — the same three numbers per STATION, which both routes answer when
 * asked with `stationId`. Keyed by station id so a test can make the branch's
 * number and each station's differ — the only way an assertion can tell "the
 * station's count" from "the branch's" or from the poison.
 */
let stationCounts: Record<string, KitchenLaneCounts> = {};

/**
 * D174 — what the server does with `stationId`: scopes the rows AND the three
 * numbers by the same clause. A D147-window ticket (`stationId: null`) is in no
 * station's read. Shared by both route mocks so the fixture cannot pin them to
 * different definitions.
 */
function scopeToStation(rows: KitchenTicketView[], stationId: unknown) {
  return {
    items: stationId ? rows.filter((t) => t.stationId === stationId) : rows,
    counts:
      stationId && typeof stationId === 'string'
        ? (stationCounts[stationId] ?? { toMake: 911, preparing: 911, doneToday: 911 })
        : serverCounts,
  };
}

/**
 * jsdom pins `visibilityState` to 'visible'; D154's poll gate needs it
 * movable. Defined once for the file, and reset to 'visible' before every
 * test so only the tests that hide the tab ever see it hidden.
 */
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility,
});

beforeEach(() => {
  canUpdate = true;
  outstandingRows = [];
  doneRows = [];
  serverCounts = { toMake: 0, preparing: 0, doneToday: 0 };
  stationCounts = {};
  visibility = 'visible';
  listFn.mockReset();
  laneCountsFn.mockReset();
  /*
   * D154 — an UNFILTERED board must not read this. Asked without a station it
   * answers numbers no chip could legitimately show, so a board that quietly
   * went back to the second request would not merely be "still green": the
   * counts on screen would change.
   *
   * D174 — asked WITH a station it answers that station's fixture, the same
   * numbers the list route would carry for that station; a station the test
   * never described gets the poison too, so a cut read against a forgotten
   * fixture fails loudly rather than on a zero that looks like a count.
   */
  laneCountsFn.mockImplementation((_s: unknown, _b: unknown, stationId?: unknown) =>
    Promise.resolve(scopeToStation([], stationId).counts),
  );
  startFn.mockReset();
  completeFn.mockReset();
  reopenFn.mockReset();
  orderFn.mockReset();
  stationsFn.mockReset();
  chime.mockReset();
  /*
   * D152 — ONE station by default, so the station strip stays hidden and every
   * test written before the filter existed still describes the board it meant
   * to. The filter's own tests opt into more.
   */
  stationsFn.mockImplementation(() => Promise.resolve([station('stn_1', 'Grill')]));
  window.localStorage.clear();
  orderFn.mockImplementation(() => new Promise(() => undefined));
  /*
   * D142 — the Done lane asks for `COMPLETED_TODAY`, not `COMPLETED`. Keyed on
   * the exact token the board sends so a lane that silently reverted to the
   * unbounded fetch would serve OUTSTANDING rows here and fail loudly, rather
   * than passing on a fixture that answered both.
   */
  /*
   * D154 — one read, one envelope: the lane the board asked for, and the
   * BRANCH's three lane counts beside it. The counts deliberately do not vary
   * with `filter` here, because they do not vary with it on the server either
   * (D142b — every chip carries its number whichever lane is open).
   */
  /*
   * D174 — and `stationId` scopes both halves of the envelope. The BOARD never
   * sends it (the strip needs the whole lane), and that is asserted; the mock
   * honours it anyway so a board that started scoping its list would lose the
   * strip's other stations HERE, in the fixture, the way it would in production
   * — not merely trip a call-shape assertion.
   */
  listFn.mockImplementation((_s: unknown, _b: unknown, filter: unknown, stationId?: unknown) =>
    Promise.resolve(
      scopeToStation(filter === 'COMPLETED_TODAY' ? doneRows : outstandingRows, stationId),
    ),
  );
  completeFn.mockImplementation((_s: unknown, _b: unknown, id: unknown) => {
    outstandingRows = outstandingRows.filter((t) => t.id !== id);
    return Promise.resolve(undefined);
  });
  reopenFn.mockImplementation((_s: unknown, _b: unknown, id: unknown) => {
    doneRows = doneRows.filter((t) => t.id !== id);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('age escalation (D100)', () => {
  it('turns a waiting ticket amber at 10 minutes and red at 15', async () => {
    outstandingRows = [
      ticket({ id: 'tk_fresh', placeLabel: 'T1', createdAt: minutesAgo(2) }),
      ticket({ id: 'tk_warn', placeLabel: 'T2', createdAt: minutesAgo(12) }),
      ticket({ id: 'tk_late', placeLabel: 'T3', createdAt: minutesAgo(20) }),
    ];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T3')).toBeTruthy());
    // The big timer carries the colour…
    expect(screen.getByText('2 min').className).toContain('text-muted-foreground');
    expect(screen.getByText('12 min').className).toContain('text-warning');
    expect(screen.getByText('20 min').className).toContain('text-danger');
    // …and the card's border escalates with it, one card per tier.
    expect(container.querySelectorAll('.border-warning')).toHaveLength(1);
    expect(container.querySelectorAll('.border-danger')).toHaveLength(1);
  });

  it('paints nothing on a fresh board', async () => {
    outstandingRows = [ticket({ id: 'tk_fresh', createdAt: minutesAgo(1) })];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('1 min')).toBeTruthy());
    expect(container.querySelectorAll('.border-warning')).toHaveLength(0);
    expect(container.querySelectorAll('.border-danger')).toHaveLength(0);
  });
});

describe('the write gate (WS-408 mirrored)', () => {
  it('shows a full-width verb to the kitchen — Start on the To make lane, Mark done on Preparing', async () => {
    outstandingRows = [
      ticket({ id: 'tk_1' }),
      ticket({ id: 'tk_2', placeLabel: 'T2', status: 'IN_PROGRESS' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // D113/D115 — one verb per state, one lane per ticket.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /start preparing/i })).toHaveLength(1),
    );
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull();
    expect(screen.getByRole('button', { name: /start preparing/i }).className).toContain('w-full');

    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /mark done/i })).toHaveLength(1),
    );
    expect(screen.queryByRole('button', { name: /start preparing/i })).toBeNull();
    expect(screen.getByRole('button', { name: /mark done/i }).className).toContain('w-full');
  });

  it('shows the till no verbs on either lane, while Details still counts the tickets', async () => {
    canUpdate = false;
    outstandingRows = [
      ticket({ id: 'tk_1' }),
      ticket({ id: 'tk_2', placeLabel: 'T2', status: 'IN_PROGRESS' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1),
    );
    expect(screen.queryByRole('button', { name: /start preparing/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() => expect(screen.getByText('T2')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /recall/i })).toBeNull();
  });

  it('an empty Preparing lane does not tell the till to press Start (D94 / D119)', async () => {
    canUpdate = false;
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() => expect(screen.getByText('Nothing on the stove.')).toBeTruthy());
    // NEGATIVE — the instruction is for a verb the till does not hold.
    expect(screen.queryByText(/start a ticket from to make/i)).toBeNull();
  });

  it('…while the kitchen, holding the verb, is told where to start (positive control)', async () => {
    canUpdate = true;
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() =>
      expect(screen.getByText('Nothing on the stove. Start a ticket from To make.')).toBeTruthy(),
    );
  });
});

describe('the bump', () => {
  it('sends the completion and drops the card without waiting for the poll', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T7', status: 'IN_PROGRESS' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /mark done/i }));

    await waitFor(() => expect(completeFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'tk_1'));
    await waitFor(() => expect(screen.queryByText('T7')).toBeNull());
  });
});

/*
 * D113/D115 — Start preparing moves the card one lane along: it leaves
 * To make the moment it is tapped and turns up under Preparing with the
 * badge and the next verb — the bump-bar lane flow, pinned from both lanes
 * so a card that vanished entirely would fail the second half.
 */
describe('start preparing (D113)', () => {
  it('starting moves the card from To make to the Preparing lane', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T7' })];
    startFn.mockImplementation(() => {
      const started = ticket({ id: 'tk_1', placeLabel: 'T7', status: 'IN_PROGRESS' });
      outstandingRows = [started];
      return Promise.resolve(started);
    });
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    expect(screen.queryByText('Preparing', { selector: 'span' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /start preparing/i }));

    await waitFor(() => expect(startFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'tk_1'));
    // Gone from To make…
    await waitFor(() => expect(screen.queryByText('T7')).toBeNull());
    // …and waiting under Preparing, verb advanced, badge on.
    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    expect(screen.getByRole('button', { name: /mark done/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /start preparing/i })).toBeNull();
  });
});

/*
 * D116 — the board has NO Cancelled lane: cancellation is the Orders
 * queue's business, and cancelled work simply never reaches this screen
 * (the server read excludes it — pinned in the integration suite). The tab
 * strip is asserted as the exact set, because a lane quietly added back
 * would pass any absence-only check the moment it was renamed.
 */
describe('the lane strip (D116)', () => {
  it('offers exactly To make, Preparing and Done', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T1 · Main')).toBeTruthy());

    const strip = screen.getByRole('group', { name: /filter kitchen tickets/i });
    const labels = Array.from(strip.querySelectorAll('button')).map((b) =>
      (b.textContent ?? '').replace(/\d+$/, '').trim(),
    );
    expect(labels).toEqual(['To make', 'Preparing', 'Done']);
  });
});

describe('the Details dialog', () => {
  it('holds its floor while loading, and the content lands on the same floor', async () => {
    // The dialog used to open at spinner height and jump open when the order
    // arrived — the reported "glitch". Both halves are pinned: the skeleton
    // AND the loaded content sit inside the same min-height wrapper, so the
    // common one-round order never resizes the dialog at all.
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T7' })];
    let resolveOrder!: (o: unknown) => void;
    orderFn.mockImplementation(() => new Promise((r) => (resolveOrder = r)));
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /details/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.min-h-44')).toBeTruthy();
    expect(dialog.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);

    resolveOrder({
      ticketId: 'tk_1',
      ticketNumber: 'KOT-000001',
      orderNumber: 'RO-000010',
      placeLabel: 'T7',
      waiterName: 'Nimal',
      placedAt: minutesAgo(5),
      items: [
        {
          id: 'oi_1',
          name: 'Kottu',
          variantName: null,
          quantity: '1.000',
          modifierNames: [],
          specialInstructions: null,
          roundNumber: 1,
          // D152 — read again, and pinned by the dialog's own suite below.
          stationName: 'Grill',
        },
      ],
    });

    await waitFor(() => expect(screen.getByText('Round 1')).toBeTruthy());
    // The skeleton is gone, the floor is not.
    expect(dialog.querySelectorAll('.animate-pulse')).toHaveLength(0);
    expect(dialog.querySelector('.min-h-44')).toBeTruthy();
  });
});

describe('recall (D100)', () => {
  const doneTicket = () =>
    ticket({
      id: 'tk_done',
      placeLabel: 'T9',
      status: 'COMPLETED',
      completedAt: minutesAgo(3),
      completedByName: 'Chef',
      createdAt: minutesAgo(25),
    });

  it('offers Recall — not Mark done, not a timer — on a completed ticket', async () => {
    doneRows = [doneTicket()];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    await waitFor(() => expect(screen.getByText('T9')).toBeTruthy());
    expect(screen.getByRole('button', { name: /recall/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull();
    // A done dish stopped ageing: who finished it replaces the timer.
    expect(screen.queryByText('25 min')).toBeNull();
    expect(screen.getByText(/Chef/)).toBeTruthy();
  });

  it('reopens the ticket and drops the card from the Done tab', async () => {
    doneRows = [doneTicket()];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(screen.getByText('T9')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /recall/i }));

    await waitFor(() => expect(reopenFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'tk_done'));
    await waitFor(() => expect(screen.queryByText('T9')).toBeNull());
  });

  it('never offers Recall to a reader', async () => {
    canUpdate = false;
    doneRows = [doneTicket()];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    await waitFor(() => expect(screen.getByText('T9')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /recall/i })).toBeNull();
  });
});

/*
 * The new-ticket chime, pinned in pairs like the orders queue's: every ring
 * case has a silent twin (first load, an unchanged poll, a filter switch),
 * because a chime wired to "any response" would pass the ring half alone.
 */
describe('the new-ticket chime', () => {
  beforeEach(() => {
    // Scoped to this suite: the rest of the file runs on real timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let one full 5 s poll interval elapse (and its fetch settle). */
  async function tickPoll() {
    await vi.advanceTimersByTimeAsync(5000);
  }

  it('stays silent on the first load, whatever it brings', async () => {
    outstandingRows = [ticket({ id: 'tk_1' }), ticket({ id: 'tk_2', placeLabel: 'T2' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // Positive control: the board rendered the tickets it will not ring for.
    await waitFor(() => expect(screen.getByText('T2')).toBeTruthy());
    expect(chime).not.toHaveBeenCalled();
  });

  it('rings when a poll brings a ticket the board has not seen', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(1));

    outstandingRows = [...outstandingRows, ticket({ id: 'tk_2', placeLabel: 'T2' })];
    await tickPoll();

    await waitFor(() => expect(chime).toHaveBeenCalledTimes(1));
  });

  it('stays silent when the poll returns the same tickets', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(1));

    await tickPoll();

    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2));
    expect(chime).not.toHaveBeenCalled();
  });

  it('rings for an arrival even when a bump lands in the same poll', async () => {
    // One out, one in: the COUNT is unchanged, which is exactly why the
    // baseline compares ids — a total-based chime (the orders queue's rule,
    // forced on it by paging) would sleep through this arrival.
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(1));

    outstandingRows = [ticket({ id: 'tk_2', placeLabel: 'T2' })];
    await tickPoll();

    await waitFor(() => expect(chime).toHaveBeenCalledTimes(1));
  });

  it('stays silent across a filter switch and on Done-tab arrivals', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    doneRows = [
      ticket({
        id: 'tk_9',
        status: 'COMPLETED',
        placeLabel: 'T9',
        completedAt: minutesAgo(1),
        completedByName: 'Chef',
      }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(1));

    // Done shows a ticket this board never listed — visibility, not arrival.
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(screen.getByText('T9')).toBeTruthy());
    expect(chime).not.toHaveBeenCalled();

    // A new id on the Done tab is someone bumping, not work arriving.
    doneRows = [
      ...doneRows,
      ticket({
        id: 'tk_10',
        status: 'COMPLETED',
        placeLabel: 'T10',
        completedAt: minutesAgo(0),
        completedByName: 'Chef',
      }),
    ];
    await tickPoll();

    await waitFor(() => expect(screen.getByText('T10')).toBeTruthy());
    expect(chime).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('card layout', () => {
  it('pins the actions to the bottom so a row of cards shares one button line', async () => {
    outstandingRows = [ticket({ id: 'tk_lay', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    /*
     * Both halves, or neither is worth asserting. The board is a grid, so
     * every card is stretched to the tallest in its row. Without h-full the
     * card declines that height and mt-auto has nothing to push against;
     * without mt-auto the verb floats wherever the dish list happened to end.
     * Either assertion alone passes on a board whose buttons still fail to
     * line up, which is the bug this replaced.
     */
    const card = screen.getByText('T1').closest('.rounded-2xl') as HTMLElement;
    // The anchor itself is asserted: a `closest` that found nothing would make
    // every className check below vacuous.
    expect(card).toBeTruthy();
    expect(card.className).toContain('h-full');
    expect(card.className).toContain('flex-col');

    const actions = screen.getByRole('button', { name: /Start preparing/ }).parentElement;
    expect(actions?.className).toContain('mt-auto');
    // …and it is THIS card's own bottom that was pinned.
    expect(card.contains(actions)).toBe(true);
  });

  it('gives the provenance line a row of its own, clear of the timer', async () => {
    // It used to share the header row with the timer, which left it about half
    // a card: every ordinary ticket truncated to "RO-000010 · Restauran…".
    outstandingRows = [ticket({ id: 'tk_prov', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    const title = screen.getByText('T1');
    const timer = screen.getByText('2 min');
    // D152 — the order and the waiter. The station and the round are on the
    // ribbon above, which the station-ribbon suite pins.
    const provenance = screen.getByText('RO-000010 · Nimal');
    const headerRow = title.parentElement as HTMLElement;

    // Positive: the place shares its row with the timer, which is the pair
    // that row exists for…
    expect(headerRow.contains(timer)).toBe(true);
    // …and NEGATIVE: the provenance line is not in it. Both halves, because
    // "the line exists" passes on the old header too.
    expect(headerRow.contains(provenance)).toBe(false);
    // It sits under the header inside the same block, at the card's full width.
    expect(provenance.parentElement).toBe(headerRow.parentElement);
    expect(
      title.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(provenance.className).toContain('truncate');
  });

  it('keeps the ticket number and Details on one line', async () => {
    // A long completed-by name used to wrap and drag Details out of the row.
    doneRows = [
      ticket({
        id: 'tk_wrap',
        status: 'COMPLETED',
        placeLabel: 'T1',
        completedAt: minutesAgo(3),
        completedByName: 'A Very Long Kitchen Hand Name',
      }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    // Positive: the name is the part that gives.
    const name = screen.getByText('A Very Long Kitchen Hand Name');
    expect(name.className).toContain('truncate');
    // Negative: the time beside it does NOT, so it survives a long name.
    const time = screen.getByText(/^· /);
    expect(time.className).toContain('shrink-0');
  });
});

/*
 * D142b — every chip carries a number, whichever lane is open.
 *
 * The board reads one lane at a time, so it could only count the lane it was
 * on: standing on To make, "Done" carried nothing; standing on Done, the other
 * two went blank. Asserted from BOTH sides, because a fix that filled Done
 * while leaving To make empty from Done is the same bug facing the other way.
 */
describe('the lane chips (D142b)', () => {
  it('shows all three counts from the outstanding lanes', async () => {
    outstandingRows = [
      ticket({ id: 'tk_1' }),
      ticket({ id: 'tk_2', status: 'IN_PROGRESS' }),
      ticket({ id: 'tk_3', status: 'IN_PROGRESS' }),
    ];
    serverCounts = { toMake: 1, preparing: 2, doneToday: 7 };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // The two lanes sharing this fetch are counted from the list in hand…
    await waitFor(() => expect(chipText(/^To make/)).toContain('1'));
    expect(chipText(/^Preparing/)).toContain('2');
    // …and Done, which this board is NOT fetching, from the server.
    await waitFor(() => expect(chipText(/^Done/)).toContain('7'));
  });

  it('shows all three from the Done lane too — the same bug facing the other way', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    doneRows = [
      ticket({ id: 'd1', status: 'COMPLETED', completedAt: minutesAgo(5) }),
      ticket({ id: 'd2', status: 'COMPLETED', completedAt: minutesAgo(9) }),
    ];
    serverCounts = { toMake: 4, preparing: 3, doneToday: 2 };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    await waitFor(() => expect(chipText(/^Done/)).toContain('2'));
    expect(chipText(/^To make/)).toContain('4');
    expect(chipText(/^Preparing/)).toContain('3');
  });

  it('moves the active lane’s chip on a bump, without waiting for the poll', async () => {
    outstandingRows = [ticket({ id: 'tk_1' }), ticket({ id: 'tk_2' })];
    startFn.mockImplementation(() => {
      const started = ticket({ id: 'tk_1', status: 'IN_PROGRESS' });
      outstandingRows = [started, ticket({ id: 'tk_2' })];
      return Promise.resolve(started);
    });
    // The server count is deliberately STALE — the active lanes must not read
    // it, or an optimistic bump would sit on the old number for five seconds.
    serverCounts = { toMake: 99, preparing: 99, doneToday: 0 };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(chipText(/^To make/)).toContain('2'));

    fireEvent.click(screen.getAllByRole('button', { name: /start preparing/i })[0]!);

    // The card moves lane immediately, and BOTH chips follow it without a poll.
    await waitFor(() => expect(chipText(/^Preparing/)).toContain('1'));
    expect(chipText(/^To make/)).toContain('1');
    // NEGATIVE — the stale server number never reaches a lane the board is
    // fetching for itself.
    expect(chipText(/^To make/)).not.toContain('99');
    expect(chipText(/^Preparing/)).not.toContain('99');
  });

  /*
   * D154 rewrote "keeps the last numbers when a COUNTS poll fails": there is
   * no separate counts poll to fail any more, so the assertion as written
   * described a request the board no longer makes. The property it protected —
   * one bad poll must not blank what the last good one put on screen — is now
   * the whole read's to keep, and is asserted over the cards AND the numbers
   * together in "one tick, one request (D154)" below.
   */
});

// ─────────────────────────────────────────────────────────────────────────────

/*
 * D154 — one tick, one request; and no tick at all while nobody is looking.
 *
 * The board polled every 5 s and spent TWO requests on it (the lane, then the
 * lane counts), and it never stopped: left open overnight it asked ~1,440
 * times an hour whether anything had changed, for an empty room. Neither half
 * of that is visible on screen, which is why every assertion here is about
 * CALLS — a board fetching twice and a board fetching once render the same
 * cards, and so do a poll that never pauses and a poll that never resumes.
 *
 * Paired throughout, on the same rule as the rest of this file: "it stopped
 * polling" is also what a dead interval looks like, so every silence is
 * followed by the fetch that proves the timer was alive; and "the counts are
 * right" is also true of a board still paying for them separately, so the
 * abandoned endpoint answers a number nothing on screen could show.
 */
describe('one tick, one request (D154)', () => {
  beforeEach(() => {
    // Scoped to this suite: the rest of the file runs on real timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let one full 5 s poll interval elapse (and its fetch settle). */
  async function tickPoll() {
    await vi.advanceTimersByTimeAsync(5000);
  }

  /** Wait until the ticket read has been hit exactly `calls` times. */
  async function settle(calls: number) {
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(calls));
  }

  it('spends ONE request per tick, and never the second one', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await settle(1);
    // Positive control: the counted fetch is a real one — the board drew it.
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    await tickPoll();
    await settle(2);
    await tickPoll();
    await settle(3);

    // NEGATIVE — the standalone counts endpoint is no part of an UNFILTERED
    // tick (D174 adds it under a station cut, which this single-station board
    // can never be under)…
    expect(laneCountsFn).not.toHaveBeenCalled();
    // …and neither is anything else. The stations read fires ONCE, at mount,
    // which is what makes this a claim about the tick's whole cost rather
    // than about `listTickets` alone.
    expect(stationsFn).toHaveBeenCalledTimes(1);
    // An exact SET of calls rather than a total: a board that had started
    // fetching a second lane per tick would keep any count-based assertion
    // green by simply being wrong twice as fast.
    expect(listFn.mock.calls.map((c) => c[2])).toEqual([
      'OUTSTANDING',
      'OUTSTANDING',
      'OUTSTANDING',
    ]);
  });

  it('takes the other lane’s number from the ticket read, not from a second call', async () => {
    // Unfiltered (one station, so no strip and no cut): the envelope is the
    // only source. The cut's own source is pinned under "the station filter".
    outstandingRows = [ticket({ id: 'tk_1' })];
    serverCounts = { toMake: 1, preparing: 0, doneToday: 7 };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // POSITIVE — the envelope's count is what the lane the board is NOT
    // fetching reads. Matched on the whole accessible name, so a chip that
    // merely lost its number cannot satisfy it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 7' })).toBeTruthy());
    // NEGATIVE — and the number the abandoned endpoint would have supplied is
    // nowhere on the strip. 911 is reachable only through `kitchen.laneCounts`.
    expect(screen.queryByRole('button', { name: /911/ })).toBeNull();
    expect(laneCountsFn).not.toHaveBeenCalled();

    // The counts ride along on EVERY tick, not only the first: a board that
    // read them once at mount would look identical until the kitchen moved.
    serverCounts = { toMake: 1, preparing: 0, doneToday: 8 };
    await tickPoll();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 8' })).toBeTruthy());
  });

  it('does not poll a hidden tab', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await settle(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await tickPoll();
    await tickPoll();

    // Two full intervals, zero fetches.
    expect(listFn).toHaveBeenCalledTimes(1);

    // POSITIVE CONTROL — the interval is still ALIVE. Unhiding without
    // dispatching anything means the next tick is the interval's own, so the
    // silence above was the gate and not a timer this test had torn down.
    visibility = 'visible';
    await tickPoll();
    await settle(2);
  });

  it('refetches the moment the board is looked at again, not when the interval next comes round', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await settle(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await tickPoll();
    expect(listFn).toHaveBeenCalledTimes(1);

    // A ticket lands while nobody is looking.
    outstandingRows = [...outstandingRows, ticket({ id: 'tk_2', placeLabel: 'T2' })];
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));

    // No 5 s wait: the catch-up fetch fires on the event itself. On a pass,
    // where this poll IS the delivery, the remainder of an interval is
    // exactly the wrong four seconds to spend.
    await settle(2);
    await waitFor(() => expect(screen.getByText('T2')).toBeTruthy());
  });

  it('comes back on window focus too, and still only when the tab is visible', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await settle(1);

    // POSITIVE — focus alone refetches: a board can be uncovered without the
    // document ever changing visibility (another window moved off it).
    window.dispatchEvent(new Event('focus'));
    await settle(2);

    // NEGATIVE — and it is the GATE that answers, not the event. A focus
    // event while the tab is hidden fetches nothing, or the listener would be
    // a second, ungated poll wearing a different name.
    visibility = 'hidden';
    window.dispatchEvent(new Event('focus'));
    await tickPoll();
    expect(listFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT keep them when the failed read was for a different lane', async () => {
    /*
     * The limit of "keep the last good cards", and a regression this very
     * change introduced before a verifier caught it.
     *
     * Keeping the rows is right while the board is still asking the same
     * question. After a lane switch it is not: the rows in state answer the
     * tab the cook just left, and the lane split would relabel them as the one
     * they chose — a QUEUED card sitting on Done, offering "Start preparing",
     * and counted by the Done chip. Showing the wrong lane's work is worse
     * than showing none.
     */
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    // Switch to Done, and let THAT read fail.
    listFn.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await settle(2);

    // The queued card is gone rather than relabelled, and its verb with it.
    expect(screen.queryByText('T1')).toBeNull();
    expect(screen.queryByRole('button', { name: /start preparing/i })).toBeNull();
    /*
     * TWO copies of the message, where the keep-the-cards test above asserts
     * exactly one. That difference IS the behaviour: one copy is the banner
     * over a board still showing work, two is the banner plus the error card
     * that replaced the lane. The contrast is what makes both tests mean
     * something.
     */
    expect(screen.getAllByText('offline')).toHaveLength(2);
  });

  it('clears the banner once a later poll succeeds', async () => {
    /*
     * The banner is about the LAST poll. Before D154 a failed poll blanked the
     * board, so a stale banner was moot; now the board stays up, and an error
     * that never cleared would stand over a working pass for the rest of the
     * shift.
     */
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    listFn.mockRejectedValue(new Error('offline'));
    await tickPoll();
    await settle(2);
    expect(screen.getAllByText('offline').length).toBeGreaterThan(0);

    // …the network comes back.
    listFn.mockResolvedValue({ items: outstandingRows, counts: serverCounts });
    await tickPoll();
    await settle(3);

    expect(screen.queryByText('offline')).toBeNull();
    expect(screen.getByText('T1')).toBeTruthy();
  });

  it('stops listening on unmount, so a screen mounted all shift leaks nothing', async () => {
    /*
     * Named on purpose. The cleanup IS killed today by a mutation, but only
     * through cross-test pollution — forty boards from earlier tests still
     * listening — so an `it.only` or a reorder would silently un-cover it.
     * This asserts the claim directly, and kills all three cleanup mutants by
     * name: the interval, the focus listener and the visibilitychange one.
     */
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    const { unmount } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    const afterMount = listFn.mock.calls.length;

    unmount();

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await tickPoll();

    // Not one more read: not from the interval, not from either listener.
    expect(listFn.mock.calls.length).toBe(afterMount);
  });

  it('keeps the last cards and the last numbers when a poll fails', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    serverCounts = { toMake: 1, preparing: 0, doneToday: 5 };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 5' })).toBeTruthy());

    listFn.mockRejectedValue(new Error('offline'));
    await tickPoll();
    await settle(2);

    // The cards the last good poll brought are still on the pass…
    expect(screen.getByText('T1')).toBeTruthy();
    // …and so is every number. Two reads used to make this automatic for the
    // chips — the counts call swallowed its own error — and one read has to
    // keep it deliberately. Both lanes: the one counted from the list in hand
    // and the one that came from the envelope.
    expect(screen.getByRole('button', { name: 'To make 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done 5' })).toBeTruthy();
    // The failure is still SAID — in the banner above the cards rather than
    // instead of them. Exactly one place says it: a second copy would mean
    // the board had fallen through to the error card and blanked the lane.
    expect(screen.getAllByText('offline')).toHaveLength(1);
  });

  it('says so when the FIRST load fails, where there is nothing to keep', async () => {
    listFn.mockRejectedValue(new Error('offline'));
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // The pair to the test above, and the reason "keep what was there" is
    // guarded on ever having loaded: a board with nothing behind it must say
    // it failed, not spin on "Loading tickets…" for ever. Two copies of the
    // message here — the banner AND the error card — against one above.
    await waitFor(() => expect(screen.getAllByText('offline')).toHaveLength(2));
    expect(screen.queryByText(/Loading tickets/)).toBeNull();
  });

  it('POSITIVE CONTROL — the silent laneCounts spy can actually record a call', async () => {
    /*
     * Every `laneCounts` negative above rests on this: the spy is wired to the
     * module the board imports, so "never called" is a fact about the board
     * and not about a mock nothing could reach in the first place.
     */
    const { kitchen } = await import('@/lib/restaurant/api');
    await kitchen.laneCounts(SESSION, 'brn_1');
    expect(laneCountsFn).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/*
 * D142 — the Done lane holds today, and says where the rest went.
 *
 * The lane's own contents are the server's business (pinned in
 * kitchen-history.spec.ts and kitchen-board.spec.ts); what belongs here is that
 * the board ASKS for the day-scoped lane and offers the way out of it. Both
 * halves matter: a board that asked for the unbounded list would look identical
 * on screen, and the link is what D142 names as the mitigation for the one
 * thing the change takes away.
 */
describe('the Done lane is today’s (D142)', () => {
  it('asks the server for the day-scoped lane, not for every ticket ever bumped', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    doneRows = [ticket({ id: 'tk_done', status: 'COMPLETED', completedAt: minutesAgo(5) })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(listFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'COMPLETED_TODAY'));
    // NEGATIVE — the unbounded token is never sent by this screen.
    expect(listFn.mock.calls.map((c) => c[2])).not.toContain('COMPLETED');
  });

  it('offers the way to the older tickets, and only from the Done lane', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    doneRows = [ticket({ id: 'tk_done', status: 'COMPLETED', completedAt: minutesAgo(5) })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    // NEGATIVE first: not on the working lanes, where it would be noise.
    expect(screen.queryByRole('link', { name: /ticket history/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    const link = await screen.findByRole('link', { name: /ticket history/i });
    expect(link.getAttribute('href')).toBe('/kitchen/history');
  });

  it('an empty lane says the day is empty, not the kitchen', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    doneRows = [];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(listFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    await screen.findByText(/Nothing finished today yet/);
    // The sentence has to send them somewhere, or "today" reads as a defect.
    expect(screen.getByText(/Earlier tickets are in Ticket history/)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/*
 * D152 — the station ribbon, restored from 35e94fa.
 *
 * A station-split round puts the SAME table on two cards, and the station is
 * the only thing telling a cook which of them is theirs. D68 put it in the
 * subtitle, where it was the first grey item of a truncated run: present and
 * unreadable, which made the split look like a bug rather than the routing
 * working. It rides a ribbon across the top of the card instead, with the round
 * pinned at the far end.
 *
 * Pinned in pairs, like everything else here, because each half alone also
 * describes a broken card:
 *
 * - "Grill is on the card" passes on the D68 board too. The ribbon assertion is
 *   therefore paired with the subtitle no longer carrying it, which is what
 *   actually changed.
 * - The split-order case is the reason the ribbon exists: one table, two
 *   stations, two cards. Asserting one station name would pass on a board that
 *   rendered a single card and dropped the other.
 * - The separator pair guards the join: dropping the station from the front of
 *   the dotted run is exactly what a prefix-per-part build would turn into a
 *   leading " · ".
 */
describe('station ribbon (D152)', () => {
  it('promotes the station out of the subtitle into a ribbon atop the card', async () => {
    outstandingRows = [ticket({ id: 'tk_st', placeLabel: 'T1', stationName: 'Grill' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    // Positive: the station is its own ribbon, not loose text.
    const station = screen.getByText('Grill');
    const ribbon = station.parentElement as HTMLElement;
    expect(ribbon.className).toContain('bg-brand-50');

    // Negative: the subtitle it used to lead is still there, without it.
    const subtitle = screen.getByText('RO-000010 · Nimal');
    expect(subtitle.textContent).not.toContain('Grill');

    /*
     * Placement, pinned three ways. "The station is on the card somewhere"
     * passes with it back in the grey run it came from, so pin the ribbon to
     * the top: it is the card's FIRST child, it precedes the place, and the
     * place is not inside it. Any one of these alone still allows the old
     * position.
     */
    const title = screen.getByText('T1');
    const card = title.closest('.rounded-2xl') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.firstElementChild).toBe(ribbon);
    expect(station.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ribbon.contains(title)).toBe(false);
    // The ribbon only sits flush inside the card's rounded corners because the
    // card clips it — without this it reads as a stripe laid over the corner.
    expect(card.className).toContain('overflow-hidden');
    // ae11a7d's full-height column survives the ribbon sitting above it.
    expect(card.className).toContain('h-full');
    expect(card.className).toContain('flex-col');
  });

  it('tells two cards of one station-split order apart', async () => {
    // The same table, the same round, routed to two stations — the case that
    // made the grey subtitle insufficient, and the case D147 removed.
    outstandingRows = [
      ticket({ id: 'tk_a', placeLabel: 'T4', stationId: 'stn_2', stationName: 'Main Kitchen' }),
      ticket({ id: 'tk_b', placeLabel: 'T4', stationId: 'stn_1', stationName: 'Grill' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getAllByText('T4')).toHaveLength(2));
    expect(screen.getByText('Main Kitchen')).toBeTruthy();
    expect(screen.getByText('Grill')).toBeTruthy();
    // Each card carries ONE station's band, not both: the split is only useful
    // if a cook can take a card as entirely theirs.
    const cards = screen.getAllByText('T4').map((el) => el.closest('.rounded-2xl') as HTMLElement);
    expect(within(cards[0]!).queryByText('Grill')).toBeNull();
    expect(within(cards[1]!).queryByText('Main Kitchen')).toBeNull();
  });

  it('never leaves a dangling separator when the subtitle loses a part', async () => {
    outstandingRows = [
      ticket({ id: 'tk_full', placeLabel: 'T1' }),
      ticket({ id: 'tk_thin', placeLabel: 'T2', orderNumber: null }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T2')).toBeTruthy());

    // Positive: a full ticket still joins every survivor.
    expect(screen.getByText('RO-000010 · Nimal')).toBeTruthy();
    // Negative: a thin one starts at its first surviving part, not at " · ".
    const thin = screen.getByText('Nimal');
    expect(thin.textContent).toBe('Nimal');
  });

  it('carries the round at the far end of the ribbon, opposite the station', async () => {
    outstandingRows = [ticket({ id: 'tk_r', placeLabel: 'T1', roundNumber: 2 })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    // Positive: both ends of the ONE ribbon, station first.
    const station = screen.getByText('Grill');
    const round = screen.getByText('Round 2');
    expect(station.parentElement).toBe(round.parentElement);
    expect(station.compareDocumentPosition(round) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The station is the half that gives; a round number never needs to.
    expect(station.className).toContain('truncate');
    expect(round.className).toContain('shrink-0');

    // Negative: the round MOVED to the ribbon rather than being shown twice.
    expect(screen.getByText('RO-000010 · Nimal').textContent).not.toContain('Round');
  });

  it('leaves the round half empty rather than printing a bare "Round"', async () => {
    // A ticket predating rounds. The station half must still render, which is
    // what separates "no round" from "no ribbon".
    outstandingRows = [ticket({ id: 'tk_nr', placeLabel: 'T1', roundNumber: null })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    expect(screen.getByText('Grill')).toBeTruthy();
    expect(screen.queryByText(/Round/)).toBeNull();
  });

  it('keeps the band for a D147-window ticket, and names no station on it', async () => {
    /*
     * D152 restores the split with no migration and no backfill, so a ticket
     * cut during the D147 window is still on the board carrying no station at
     * all. The band stays for its round — inventing "Main" for a ticket that
     * actually holds every station's items would be a worse answer than an
     * empty half — and it must not print the word "null" doing it.
     */
    outstandingRows = [
      d147WindowTicket({ id: 'tk_win', placeLabel: 'T-OLD', roundNumber: 3 }),
      ticket({ id: 'tk_new', placeLabel: 'T-NEW' }),
    ];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T-OLD')).toBeTruthy());

    // Positive: the band is there and it is the round's.
    const round = screen.getByText('Round 3');
    const ribbon = round.parentElement as HTMLElement;
    expect(ribbon.className).toContain('bg-brand-50');
    // Negative: nothing else is on it — no name, and no rendered `null`.
    expect(ribbon.textContent).toBe('Round 3');
    expect(container.textContent ?? '').not.toContain('null');

    // Positive control, same board: a D152 ticket beside it DOES name its
    // station, so the empty half above is this ticket's own doing.
    expect(screen.getByText('Grill')).toBeTruthy();
  });

  it('drops the band entirely when there is neither a station nor a round', async () => {
    // The one card with nothing to put on a ribbon: a coloured empty stripe is
    // furniture, and worse, it reads as a station whose name failed to load.
    outstandingRows = [
      d147WindowTicket({ id: 'tk_bare', placeLabel: 'T-BARE', roundNumber: null }),
    ];
    const bare = render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-BARE')).toBeTruthy());
    // Positive control: the card itself rendered, dish and all.
    expect(screen.getByText(/1× Kottu/)).toBeTruthy();
    expect(bare.container.querySelector('.bg-brand-50')).toBeNull();
    cleanup();

    // …and the pair: an ordinary ticket on the same board DOES get one, so the
    // absence above is the guard and not a ribbon that never renders.
    outstandingRows = [ticket({ id: 'tk_ok', placeLabel: 'T-OK' })];
    const ok = render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-OK')).toBeTruthy());
    expect(ok.container.querySelector('.bg-brand-50')).toBeTruthy();
  });

  it('puts every dish of THIS station’s share of the round on its one card', async () => {
    /*
     * RO-000026 in the dev database: one round of fifteen lines that became
     * KOT-000027 (Main Kitchen) and KOT-000028 (Grill — Chicken Wings and
     * Grilled Seer Fish). D152 splits it that way again, and the grill's card
     * has to carry BOTH of its dishes: the split is per station, never per
     * dish, or a cook is reading two cards for one pan.
     */
    outstandingRows = [
      ticket({
        id: 'tk_grill',
        placeLabel: 'T1 · Main',
        stationId: 'stn_1',
        stationName: 'Grill',
        items: [
          {
            id: 'i1',
            menuItemName: 'Chicken Wings',
            variantName: null,
            quantity: '2.000',
            modifierNames: [],
            specialInstructions: null,
          },
          {
            id: 'i2',
            menuItemName: 'Grilled Seer Fish',
            variantName: null,
            quantity: '1.000',
            modifierNames: [],
            specialInstructions: null,
          },
        ],
      }),
      ticket({
        id: 'tk_main',
        placeLabel: 'T1 · Main',
        stationId: 'stn_2',
        stationName: 'Main Kitchen',
        items: [
          {
            id: 'i3',
            menuItemName: 'Kottu',
            variantName: null,
            quantity: '3.000',
            modifierNames: [],
            specialInstructions: null,
          },
        ],
      }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getAllByText('T1 · Main')).toHaveLength(2));
    // Two cards, one per station — the split D147 removed and D152 restores.
    expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(2);

    const grillCard = screen.getByText('Grill').closest('.rounded-2xl') as HTMLElement;
    // POSITIVE — the station's whole share, both dishes, on the one card.
    expect(within(grillCard).getByText(/2× Chicken Wings/)).toBeTruthy();
    expect(within(grillCard).getByText(/1× Grilled Seer Fish/)).toBeTruthy();
    // NEGATIVE — and not the other station's, which is the point of splitting.
    expect(within(grillCard).queryByText(/3× Kottu/)).toBeNull();

    const mainCard = screen.getByText('Main Kitchen').closest('.rounded-2xl') as HTMLElement;
    expect(within(mainCard).getByText(/3× Kottu/)).toBeTruthy();
    expect(within(mainCard).queryByText(/2× Chicken Wings/)).toBeNull();
  });

  it('the Details dialog names the station on each item line, and flags none as unrouted', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T7' })];
    orderFn.mockImplementation(() =>
      Promise.resolve({
        ticketId: 'tk_1',
        ticketNumber: 'KOT-000001',
        orderNumber: 'RO-000010',
        placeLabel: 'T7',
        waiterName: 'Nimal',
        placedAt: minutesAgo(5),
        items: [
          {
            id: 'oi_1',
            name: 'Kottu',
            variantName: null,
            quantity: '1.000',
            modifierNames: [],
            specialInstructions: null,
            roundNumber: 1,
            // The card shows only the grill's share; the dialog is where the
            // pass sees that the main kitchen has a Kottu on the same table.
            stationName: 'Main Kitchen',
          },
          {
            id: 'oi_2',
            name: 'Watalappan',
            variantName: null,
            quantity: '1.000',
            modifierNames: [],
            specialInstructions: null,
            roundNumber: 2,
            // A dish the join could not name. Under D152 it cooks at Main
            // rather than nowhere, so the line is simply left unlabelled — the
            // pre-D147 "no station" warning does NOT come back with the chip.
            stationName: null,
          },
        ],
      }),
    );
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /details/i }));

    const dialog = await screen.findByRole('dialog');
    // POSITIVE — the rounds, their dishes, and the station on the line.
    await waitFor(() => expect(within(dialog).getByText('Round 1')).toBeTruthy());
    expect(within(dialog).getByText('Round 2')).toBeTruthy();
    expect(within(dialog).getByText(/1× Kottu/)).toBeTruthy();
    expect(within(dialog).getByText(/1× Watalappan/)).toBeTruthy();
    expect(within(dialog).getByText('Main Kitchen')).toBeTruthy();
    // NEGATIVE — the warning half of the old chip stays gone.
    expectNoUnroutedWarning(dialog);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/*
 * D152 — the station filter, restored from 6cbb36a.
 *
 * A station-split order already puts one table on several cards. On a wall
 * screen mounted at the grill, most of the board is somebody else's work.
 *
 * Pinned in pairs throughout, because every half here has a passing twin that
 * describes a broken board: a strip that is always shown, a filter that hides
 * everything, and a memory that never forgets.
 */
describe('printing a ticket (D153)', () => {
  it('offers a Print button on every card and hands it THAT ticket', async () => {
    outstandingRows = [
      ticket({ id: 'tk_1', placeLabel: 'T1' }),
      ticket({ id: 'tk_2', placeLabel: 'T2', ticketNumber: 'KOT-000099' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T2')).toBeTruthy());

    // Every card, not just the first: a pass that prints does it for each
    // ticket as it lands.
    expect(screen.getAllByRole('button', { name: /^Print KOT-/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Print KOT-000099' }));

    /*
     * The ticket ITSELF goes to the printer, not a lookup by id and not the
     * first row on the board. A button wired to the wrong card is the one
     * defect here that looks completely correct on screen — the paper is
     * simply for another table.
     */
    expect(printKitchenTicketFn).toHaveBeenCalledTimes(1);
    expect(printKitchenTicketFn.mock.calls[0]![0]).toMatchObject({
      ticketNumber: 'KOT-000099',
      placeLabel: 'T2',
    });
  });

  it('NEGATIVE — printing does not bump, start or open anything', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Print KOT-/ }));

    // Paper is not a state change. The card must be exactly where it was.
    expect(startFn).not.toHaveBeenCalled();
    expect(completeFn).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('T1')).toBeTruthy();
  });
});

describe('the station filter (D152)', () => {
  const twoStations = () => [station('stn_1', 'Grill'), station('stn_2', 'Main Kitchen')];

  it('offers no strip when the branch has a single station', async () => {
    // One station is no routing decision, so the strip would be furniture.
    stationsFn.mockImplementation(() => Promise.resolve([station('stn_1', 'Grill')]));
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /All stations/ })).toBeNull();
  });

  it('offers the strip once there is a choice to make', async () => {
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: /All stations/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /Main Kitchen/ })).toBeTruthy();
  });

  it('lists the stations the endpoint gave it, not the ones the tickets happen to name', async () => {
    /*
     * Deriving the strip from the tickets on screen is less code, but a chip
     * that vanishes when its last ticket is bumped and returns when the next
     * lands is unusable on a screen nobody is holding.
     */
    stationsFn.mockImplementation(() =>
      Promise.resolve([...twoStations(), station('stn_3', 'Pastry')]),
    );
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T1', stationId: 'stn_1', stationName: 'Grill' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    // POSITIVE — an idle station keeps its chip, reading zero.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pastry 0' })).toBeTruthy());
    /*
     * NEGATIVE — and the strip is the endpoint's list, not the tickets'. Only
     * Grill has a ticket here, so a board deriving its chips from what is on
     * screen would show Grill alone; the three names below are what proves the
     * chips came from the fetch.
     *
     * This assertion used to name "Pantry", which appears nowhere in this
     * test's fixture — it passed because the thing was never there, which no
     * mutation of the component could change. That is the vacuity D30 forbids.
     * The archived case it was copied from lives in the next test, where the
     * fixture really does contain Pantry.
     */
    /*
     * The EXACT strip, as a set. Only Grill has a ticket, so a board deriving
     * its chips from what is on screen would show "All stations" and Grill and
     * stop — the two idle chips are the whole proof that the list came from
     * the endpoint. An exact set says that and also says nothing extra crept
     * in, which a bag of positives cannot.
     *
     * The negative here used to name "Pantry", which this fixture never
     * contained, so no change to the component could have failed it — the
     * vacuity D30 forbids. The archived-station case it was copied from is the
     * next test, where Pantry really is in the list.
     */
    const stationChips = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((n) => /All stations|Grill|Main Kitchen|Pastry/.test(n));
    // `textContent` runs the name and the count together; the accessible name
    // spaces them. Either is fine to assert on, as long as the set is exact.
    expect(stationChips.sort()).toEqual(['All stations1', 'Grill1', 'Main Kitchen0', 'Pastry0']);
    expect(stationsFn).toHaveBeenCalledWith(SESSION, 'brn_1');
  });

  it('leaves an archived station off the strip even while its tickets are on the board', async () => {
    // The endpoint answers with archived rows too when asked; the board asks
    // for the live ones and drops anything inactive that reaches it anyway.
    stationsFn.mockImplementation(() =>
      Promise.resolve([...twoStations(), { ...station('stn_old', 'Pantry'), isActive: false }]),
    );
    outstandingRows = [
      ticket({ id: 'tk_o', placeLabel: 'T-OLD', stationId: 'stn_old', stationName: 'Pantry' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // POSITIVE — the ticket is still cooked, so it is still on the board.
    await waitFor(() => expect(screen.getByText('T-OLD')).toBeTruthy());
    // NEGATIVE — but the retired station is not a filter anyone can pick.
    expect(screen.queryByRole('button', { name: /Pantry/ })).toBeNull();
    expect(screen.getByRole('button', { name: /All stations/ })).toBeTruthy();
  });

  it('cuts the board to one station and leaves the other tickets out', async () => {
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // Positive control: unfiltered, the board carries both.
    await waitFor(() => expect(screen.getByText('T-GRILL')).toBeTruthy());
    expect(screen.getByText('T-MAIN')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));

    // Positive: the chosen station survives. Negative: the other one goes.
    await waitFor(() => expect(screen.queryByText('T-GRILL')).toBeNull());
    expect(screen.getByText('T-MAIN')).toBeTruthy();
  });

  it('never lets a stationless ticket fall off every view', async () => {
    /*
     * D152's hard rule reaches the screen too. A D147-window ticket belongs to
     * no station, so it cannot be claimed by a station chip — but it must stay
     * visible SOMEWHERE, and that somewhere is "All stations".
     */
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      d147WindowTicket({ id: 'tk_win', placeLabel: 'T-OLD' }),
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // POSITIVE — unfiltered, it is on the board and counted with everything.
    await waitFor(() => expect(screen.getByText('T-OLD')).toBeTruthy());
    expect(chipText(/All stations/)).toContain('2');

    // NEGATIVE — and it is not silently claimed by whichever station is picked.
    fireEvent.click(screen.getByRole('button', { name: /^Grill/ }));
    await waitFor(() => expect(screen.queryByText('T-OLD')).toBeNull());
    expect(screen.getByText('T-GRILL')).toBeTruthy();

    // …and back out of the cut, it is where it was.
    fireEvent.click(screen.getByRole('button', { name: /All stations/ }));
    await waitFor(() => expect(screen.getByText('T-OLD')).toBeTruthy());
  });

  it('counts the lane per station, not the whole board', async () => {
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g1', placeLabel: 'T1', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_g2', placeLabel: 'T2', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m1', placeLabel: 'T3', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    // D174 — the cut reads Main Kitchen's lane numbers; described so the Done
    // chip carries a real one below rather than the poison going unasserted.
    stationCounts = { stn_2: { toMake: 1, preparing: 0, doneToday: 4 } };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /All stations/ })).toBeTruthy());
    // Each chip counts its own station; All counts every one of them.
    expect(screen.getByRole('button', { name: /All stations 3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Grill 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Main Kitchen 1/ })).toBeTruthy();

    // And the lane strip follows the cut, or it would advertise work the
    // board is not showing.
    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen 1/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /To make 1/ })).toBeTruthy());

    /*
     * The STATION chips do NOT follow the cut, and this is where that is
     * pinned. They answer "where is the work?", so each must keep counting its
     * own station across the whole lane — a strip that counted only the
     * selection would read "Grill 0" to a cook standing at Main Kitchen while
     * the grill holds two, which is the one thing the strip exists to prevent.
     *
     * Asserted AFTER the click on purpose: before it, scoped and unscoped
     * agree, so the same assertions above cannot tell the two apart.
     */
    expect(screen.getByRole('button', { name: /^Grill 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /All stations 3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Main Kitchen 1/ })).toBeTruthy();
    /*
     * D174 — and those three are only possible because the LIST the board
     * reads is still the whole lane: the server now cuts the list when asked
     * with a station, and a board that asked would have nothing to count for
     * Grill. The fixture honours a station argument exactly as the server
     * does, so the "Grill 2" above is the proof; this is the call shape that
     * makes it so.
     */
    for (const call of listFn.mock.calls) expect(call).toHaveLength(3);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 4' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /911/ })).toBeNull();
  });

  it('carries every lane’s number under a cut, and the number is the station’s (D174)', async () => {
    /*
     * D16 — this test used to be "withholds the branch-wide lane count the cut
     * makes untrue": D152 left the other lane's chip bare under a station cut,
     * because the only number the board had was the BRANCH's and "Done 7" over
     * a lane that would show two was a lie. D174 reverses the remedy, not the
     * diagnosis: every chip carries a number whichever lane is open (D142b),
     * under a cut too, and the number is the STATION's. The assertion below is
     * the opposite of the old one because the truth is.
     *
     * The fixture makes the branch's Done (7), Grill's (5), Main Kitchen's (2)
     * and the abandoned path's poison (911) all differ, or "the chip carries a
     * number" could not tell which one it carried.
     */
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    serverCounts = { toMake: 2, preparing: 0, doneToday: 7 };
    stationCounts = {
      stn_1: { toMake: 1, preparing: 0, doneToday: 5 },
      stn_2: { toMake: 1, preparing: 0, doneToday: 2 },
    };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // Unfiltered, D142b is untouched: Done carries the BRANCH's number.
    // Matched on the ACCESSIBLE NAME, which is the whole chip — label and
    // count — so "Done 7" cannot be satisfied by a chip that lost its number.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 7' })).toBeTruthy());
    // …and an unfiltered board never asks the counts route (D154).
    expect(laneCountsFn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));

    // POSITIVE — the lanes this board fetches count, cut to the station…
    await waitFor(() => expect(screen.getByRole('button', { name: 'To make 1' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Preparing 0' })).toBeTruthy();
    // …and the lane it is NOT fetching carries Main Kitchen's own number.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 2' })).toBeTruthy());
    // NEGATIVE — not the branch's, not bare, and not the unscoped poison.
    expect(screen.queryByRole('button', { name: 'Done 7' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('button', { name: /911/ })).toBeNull();
    // The number came from the counts route, asked for THIS station…
    expect(laneCountsFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'stn_2');
    // …and the list read stayed unscoped: no fourth argument on any call. The
    // strip is counted from that list, and would read zero for Grill if the
    // server had cut it.
    expect(listFn.mock.calls.length).toBeGreaterThan(0);
    for (const call of listFn.mock.calls) expect(call).toHaveLength(3);
    expect(screen.getByRole('button', { name: /^Grill 1/ })).toBeTruthy();

    // A different station reads a different number — the count follows the
    // selection, not merely "some station".
    fireEvent.click(screen.getByRole('button', { name: /^Grill/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 5' })).toBeTruthy());
    expect(laneCountsFn).toHaveBeenLastCalledWith(SESSION, 'brn_1', 'stn_1');

    // And back on "All stations" the branch's number returns from the
    // envelope, with no further call to the counts route.
    const callsUnderCut = laneCountsFn.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /All stations/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 7' })).toBeTruthy());
    expect(laneCountsFn).toHaveBeenCalledTimes(callsUnderCut);
  });

  it('carries the station’s number on the Done lane too, for the two lanes it is not fetching', async () => {
    // D142b's "same bug facing the other way", under a cut: standing on Done,
    // To make and Preparing are the other lanes, and both must be the station's.
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [ticket({ id: 'tk_g', stationId: 'stn_1', stationName: 'Grill' })];
    doneRows = [
      ticket({ id: 'd_g', placeLabel: 'T-G', status: 'COMPLETED', stationId: 'stn_1' }),
      ticket({ id: 'd_m', placeLabel: 'T-M', status: 'COMPLETED', stationId: 'stn_2' }),
    ];
    serverCounts = { toMake: 6, preparing: 4, doneToday: 2 };
    stationCounts = { stn_2: { toMake: 3, preparing: 1, doneToday: 1 } };
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Main Kitchen/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    // POSITIVE — the lane in hand is cut client-side, and the other two carry
    // Main Kitchen's numbers.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 1' })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'To make 3' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Preparing 1' })).toBeTruthy();
    expect(screen.getByText('T-M')).toBeTruthy();
    // NEGATIVE — the branch's numbers are nowhere on the strip.
    expect(screen.queryByRole('button', { name: 'To make 6' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preparing 4' })).toBeNull();
    expect(screen.queryByText('T-G')).toBeNull();
    expect(laneCountsFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'stn_2');
  });

  it('shows no number rather than the wrong station’s while the station’s is on its way', async () => {
    /*
     * D174's tag. The round trip after a station tap is the one moment the
     * board holds numbers for a station other than the one on screen. D154's
     * rule for the rows — never relabel the old answer as the new question's —
     * applies: the chip is bare for that round trip and fills when the poll
     * lands. Asserted with the counts read held open, because with it resolved
     * the stale number and the right one are one render apart and a test
     * cannot see between them.
     */
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    serverCounts = { toMake: 2, preparing: 0, doneToday: 7 };
    let release: (c: KitchenLaneCounts) => void = () => undefined;
    laneCountsFn.mockImplementation(
      () =>
        new Promise<KitchenLaneCounts>((resolve) => {
          release = resolve;
        }),
    );
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 7' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));

    // The cards and the lanes in hand follow the tap at once (client cut)…
    await waitFor(() => expect(screen.queryByText('T-GRILL')).toBeNull());
    expect(screen.getByRole('button', { name: 'To make 1' })).toBeTruthy();
    // …and the other lane, whose number is still the BRANCH's, goes bare
    // rather than reading "Done 7" over Main Kitchen.
    await waitFor(() => expect(laneCountsFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'stn_2'));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done 7' })).toBeNull();

    // Positive control: the moment the station's number lands, the chip fills.
    release({ toMake: 1, preparing: 0, doneToday: 2 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 2' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('does not relabel the branch’s number as the station’s when the cut’s first poll fails', async () => {
    // The failed-poll half of the tag. D154 keeps the last good numbers under a
    // banner — for the SAME question. After a station tap they answer a
    // different one, so the chip goes bare under the banner, and the cards
    // (still the unscoped list, cut client-side) stay.
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    serverCounts = { toMake: 2, preparing: 0, doneToday: 7 };
    laneCountsFn.mockImplementation(() => Promise.reject(new Error('counts 503')));
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done 7' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));

    // The tick failed and says so…
    await waitFor(() => expect(screen.getByText('counts 503')).toBeTruthy());
    // …the board is kept, cut to the station (positive control)…
    expect(screen.getByText('T-MAIN')).toBeTruthy();
    expect(screen.queryByText('T-GRILL')).toBeNull();
    expect(screen.getByRole('button', { name: 'To make 1' })).toBeTruthy();
    // …and the branch's Done is not passed off as Main Kitchen's.
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done 7' })).toBeNull();
  });

  it('says which station is empty rather than looking like an empty kitchen', async () => {
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T1', stationId: 'stn_1', stationName: 'Grill' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));

    // Positive: the station is named, so a forgotten filter is visible...
    await waitFor(() => expect(screen.getByText(/Nothing for Main Kitchen/)).toBeTruthy());
    // ...and there is a way back out of it.
    fireEvent.click(screen.getByRole('button', { name: /Show all stations/ }));
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
  });

  it('still points a filtered, empty Done lane at the history (D142)', async () => {
    // D142's mitigation for cutting the lane to today is the way out of it, and
    // the station cut must not swallow that: on a filtered board "nothing here"
    // would otherwise read as "nothing was ever cooked".
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [ticket({ id: 'tk_1' })];
    doneRows = [ticket({ id: 'tk_d', placeLabel: 'T9', status: 'COMPLETED', stationId: 'stn_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Main Kitchen/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    // POSITIVE — the station is named…
    await waitFor(() => expect(screen.getByText(/Nothing for Main Kitchen/)).toBeTruthy());
    // …and D142's pointer at everything older is still on the card.
    expect(screen.getByText(/Earlier tickets are in Ticket history/)).toBeTruthy();
  });

  it('remembers the station across a remount, per branch', async () => {
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    const first = render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-GRILL')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Main Kitchen/ }));
    await waitFor(() => expect(screen.queryByText('T-GRILL')).toBeNull());
    first.unmount();

    // Positive: the same branch comes back on the station it was left on.
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-MAIN')).toBeTruthy());
    expect(screen.queryByText('T-GRILL')).toBeNull();
    cleanup();

    // Negative: a DIFFERENT branch is not dragged along with it.
    render(<KitchenBoard session={SESSION} branchId="brn_2" />);
    await waitFor(() => expect(screen.getByText('T-GRILL')).toBeTruthy());
  });

  it('drops a remembered station that no longer exists, and keeps one that does', async () => {
    // The screen was left on a station that has since been archived. Rather
    // than filtering to nothing for ever with no clue why, the selection goes.
    window.localStorage.setItem('kitchen.stationFilter.brn_1', 'stn_gone');
    stationsFn.mockImplementation(() => Promise.resolve(twoStations()));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // POSITIVE — the board comes back whole.
    await waitFor(() => expect(screen.getByText('T-GRILL')).toBeTruthy());
    expect(screen.getByText('T-MAIN')).toBeTruthy();
    cleanup();

    // NEGATIVE — and a remembered station that IS still live is left alone, so
    // the clearing above is the archived check and not a memory that never
    // survives a mount.
    window.localStorage.setItem('kitchen.stationFilter.brn_1', 'stn_2');
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-MAIN')).toBeTruthy());
    expect(screen.queryByText('T-GRILL')).toBeNull();
  });

  it('does not clear a remembered station just because the list failed to arrive', async () => {
    /*
     * An empty list is also what a failed fetch looks like. Clearing on it
     * would throw away a deliberate choice every time the endpoint blinked, so
     * the archived check waits for a list that actually arrived.
     */
    window.localStorage.setItem('kitchen.stationFilter.brn_1', 'stn_2');
    stationsFn.mockImplementation(() => Promise.reject(new Error('503')));
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    // The cut the cook chose is still in force…
    await waitFor(() => expect(screen.getByText('T-MAIN')).toBeTruthy());
    expect(screen.queryByText('T-GRILL')).toBeNull();
    // …and there is no strip, because the board never learned what to offer.
    expect(screen.queryByRole('button', { name: /All stations/ })).toBeNull();
  });

  it('keeps the board when the station list cannot be fetched', async () => {
    // The filter is a convenience; the board is the job.
    stationsFn.mockImplementation(() => Promise.reject(new Error('403')));
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /All stations/ })).toBeNull();
    expect(screen.queryByText(/Failed to load kitchen tickets/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/*
 * The chime, once a station is chosen (D152).
 *
 * Both halves in one test on purpose. "It does not ring for another station"
 * passes on a board whose chime is simply broken, so the same filtered screen
 * must be shown ringing for its own arrival immediately afterwards.
 */
describe('the chime under a station filter (D152)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hears its own station and stays deaf to the others', async () => {
    stationsFn.mockImplementation(() =>
      Promise.resolve([station('stn_1', 'Grill'), station('stn_2', 'Main Kitchen')]),
    );
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-GRILL')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Grill/ }));
    // Let the station switch re-baseline before anything arrives.
    await vi.advanceTimersByTimeAsync(5000);
    chime.mockReset();

    // Negative: a dessert landing on another station is not this screen's work.
    outstandingRows = [
      ...outstandingRows,
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    await vi.advanceTimersByTimeAsync(5000);
    expect(chime).not.toHaveBeenCalled();

    // Positive: its own station still rings, so the silence above is a filter
    // and not a broken chime.
    outstandingRows = [
      ...outstandingRows,
      ticket({ id: 'tk_g2', placeLabel: 'T-GRILL-2', stationId: 'stn_1', stationName: 'Grill' }),
    ];
    await vi.advanceTimersByTimeAsync(5000);
    expect(chime).toHaveBeenCalled();
  });

  it('re-baselines on a station switch instead of ringing for the reveal', async () => {
    stationsFn.mockImplementation(() =>
      Promise.resolve([station('stn_1', 'Grill'), station('stn_2', 'Main Kitchen')]),
    );
    outstandingRows = [
      ticket({ id: 'tk_g', placeLabel: 'T-GRILL', stationId: 'stn_1', stationName: 'Grill' }),
      ticket({ id: 'tk_m', placeLabel: 'T-MAIN', stationId: 'stn_2', stationName: 'Main Kitchen' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText('T-GRILL')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Grill/ }));
    await waitFor(() => expect(screen.queryByText('T-MAIN')).toBeNull());
    chime.mockReset();

    // Widening the view reveals a ticket this screen has never counted. That
    // is a change of view, not an arrival, and must not ring.
    fireEvent.click(screen.getByRole('button', { name: /All stations/ }));
    await waitFor(() => expect(screen.getByText('T-MAIN')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(5000);
    expect(chime).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs (D30)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `expectNoUnroutedWarning` is the one blanket ABSENCE claim left in this file
 * after D152 put the station back on screen, and an absence claim is the
 * easiest kind of test to leave vacuous. It is shown below to fail against the
 * exact markup it forbids, rendered verbatim.
 *
 * Beyond it, the real components were mutated on a scratch copy taken outside
 * the repo and this suite re-run against each mutation; every one went red
 * where it should and green again on restore. What each killed:
 *
 * - The ribbon demoted below the title, inside CardContent — "promotes the
 *   station out of the subtitle into a ribbon atop the card" (the
 *   `firstElementChild` half).
 * - The ribbon's two ends swapped, round first — "carries the round at the far
 *   end of the ribbon".
 * - The round's null guard dropped, printing a bare "Round" — "leaves the round
 *   half empty".
 * - The station put back at the head of the provenance line, as D68 had it —
 *   "promotes the station…" (the subtitle half) and "carries the round…".
 * - `overflow-hidden` off the Card — "promotes the station…". Separately,
 *   `h-full` off the Card and `mt-auto` off the actions each fail "pins the
 *   actions to the bottom", which is why that pair is asserted together.
 * - `hasRibbon` forced true — "drops the band entirely when there is neither a
 *   station nor a round"; forced false — the six ribbon tests plus its pair.
 * - The station chip left off the dialog's item lines — "the Details dialog
 *   names the station on each item line".
 * - The dialog's null branch printing the pre-D147 "no station" warning again —
 *   the same test's negative half.
 * - The station cut never applied (`scoped` = `tickets`) — "cuts the board to
 *   one station", "counts the lane per station", "never lets a stationless
 *   ticket fall off every view", "says which station is empty" and both
 *   remembered-station tests.
 * - The strip shown for a single station (`stations.length > 0`) — "offers no
 *   strip when the branch has a single station".
 * - `isActive` no longer filtered off the station list — "leaves an archived
 *   station off the strip".
 * - The choice never persisted (`selectStation` without the localStorage
 *   write) — "remembers the station across a remount".
 * - The chime ignoring the station (`heard` = `next`) — "hears its own station
 *   and stays deaf to the others"; the station dropped from the baseline key —
 *   "re-baselines on a station switch".
 * - The archived cleanup running before the list arrives (the
 *   `stations.length === 0` guard removed) — "does not clear a remembered
 *   station just because the list failed to arrive".
 * - The archived cleanup removed entirely — "drops a remembered station that no
 *   longer exists".
 * - The server counts dropped altogether — all four D142b chip tests. (The
 *   D152-era mutant beside it, `laneCount` reading the server count under a
 *   cut, is what D174 SHIPS; its inverse is proven in the D174 block below.)
 * - `COMPLETED` in place of `COMPLETED_TODAY` — "asks the server for the
 *   day-scoped lane" and the other tests that reach the Done lane, since the
 *   fixture answers that token with the OUTSTANDING rows rather than pretending
 *   both are the same lane.
 * - The lane cut ignoring IN_PROGRESS — five lane tests, the control that says
 *   `inLane` is doing the work the counts and the board both read from.
 *
 * D154's own mutants, run the same way — pristine copies taken outside the
 * repo, the suite re-run against each mutation, the files restored
 * byte-for-byte afterwards. All twelve were killed:
 *
 * - The visibility gate removed, so the poll never pauses — "does not poll a
 *   hidden tab", and both catch-up tests, which then count a fetch nobody
 *   asked for.
 * - The `focus`/`visibilitychange` listeners removed with the gate KEPT —
 *   "refetches the moment the board is looked at again" and "comes back on
 *   window focus too". That pair is the whole difference between a poll that
 *   pauses and one that has stalled.
 * - The second request put back (`kitchen.laneCounts` after the list, on an
 *   UNFILTERED board) — "spends ONE request per tick", "takes the other lane's
 *   number from the ticket read", the failed-poll test and both D142b chip
 *   tests: the 911 the spy answers without a station reaches the strip. (D174
 *   re-runs this as M4 below, against the fixture that answers per station.)
 * - `setCounts(next.counts)` dropped — the same five bar the request-count one.
 *   The chips go bare rather than wrong, which is why the two are separate
 *   mutants and not one.
 * - `setStatus('error')` made unconditional on a failed poll — "keeps the last
 *   cards and the last numbers when a poll fails": the lane blanks and the
 *   message appears twice.
 * - The status left alone entirely on failure — "says so when the FIRST load
 *   fails", which then spins on "Loading tickets…" for ever.
 * - `setTickets([])` added to the catch, counts kept — the same failed-poll
 *   test from the other side, and the half a numbers-only assertion would miss.
 * - The chime baseline built from an empty set instead of the response rows —
 *   "stays silent when the poll returns the same tickets" and both D152 chime
 *   tests: the control that says the chime still keys off THIS response.
 * - The envelope rendered in place of `.items` — 59 of the 65 tests here, which
 *   is the shape check the rest of the file performs for nothing.
 * - In api.ts, `listTickets` typed back to `KitchenTicketView[]` — not a test
 *   failure but a tsc one, in BOTH callers (`.items`/`.counts` on an array).
 *   That is what makes the envelope's type load-bearing rather than decorative,
 *   since every test in this file mocks the client and would never see it.
 *
 * D174's mutants — station-scoped lane counts — run the same way (pristine
 * copy outside the repo, suite re-run per mutant, restored byte-for-byte and
 * compared). All nine were killed:
 *
 * - M1 the tag ignored (`laneCount` reads whatever station the counts answer)
 *   — "shows no number rather than the wrong station's while the station's is
 *   on its way" and "does not relabel the branch's number … when the cut's
 *   first poll fails". These two are the tag's whole justification; nothing
 *   else notices, which is why they hold the counts read open.
 * - M2 D152's withholding put back (`stationId ? null : …`) — "carries every
 *   lane's number under a cut", "carries the station's number on the Done lane
 *   too", "counts the lane per station" (its Done 4) and the on-its-way test's
 *   positive control.
 * - M3 the LIST read scoped on the server (`stationId` passed to
 *   `listTickets`) — "counts the lane per station" reads "Grill 0" from the
 *   cut list, and the call-shape pins in it and in "carries every lane's
 *   number" trip. This is the one the strip depends on, and the fixture
 *   honouring a station argument is what lets it fail on the NUMBER and not
 *   only on the call shape.
 * - M4 the counts route asked on an unfiltered board too — the two D154
 *   request-count tests and the three cut tests: the 911 the spy answers
 *   without a station reaches the strip.
 * - M5 the counts route never asked (envelope counts under a cut) — the five
 *   cut tests: "Done 7" stands over Main Kitchen.
 * - M6 the tag always `null` — four cut tests: the chip never fills.
 * - M7 a failing counts read swallowed (`.catch(() => null)`, envelope counts
 *   in its place) — "does not relabel … when the cut's first poll fails",
 *   which is the pin for "one failure fails the tick".
 * - M8 the strip counted from the SCOPED list (`inLane(scoped, filter)`) —
 *   "counts the lane per station" and the Grill 1 in "carries every lane's
 *   number": D152's "zero on every station but one".
 * - M9 in api.ts, `laneCounts` losing its `stationId` parameter — a tsc
 *   failure at the board's call (`Expected 2 arguments, but got 3`), not a
 *   test one, for the same reason as the envelope mutant above.
 */
describe('the D152 dialog negative can actually fail', () => {
  it('catches the pre-D147 "no station" warning, in either casing', () => {
    const lower = render(<span>no station</span>);
    expect(() => expectNoUnroutedWarning(lower.container)).toThrow();
    cleanup();

    const upper = render(<span>No Station</span>);
    expect(() => expectNoUnroutedWarning(upper.container)).toThrow();
  });

  it('passes on the markup D152 actually renders, so it is not simply always red', () => {
    // The restored chip: a named station in muted tones, and nothing at all
    // where the join found no name.
    const { container } = render(
      <li>
        <span>1× Kottu</span>
        <span className="bg-muted text-muted-foreground">Main Kitchen</span>
      </li>,
    );
    expect(() => expectNoUnroutedWarning(container)).not.toThrow();
  });

  it('hands the board a D147-window ticket, so the ribbon guard is not vacuous', () => {
    // If this fixture quietly grew a station back, the "no name on the band"
    // assertions above would be describing a card that never had one.
    const row = d147WindowTicket({ id: 'tk_win' });
    expect(row.stationId).toBeNull();
    expect(row.stationName).toBeNull();
    // …and the ordinary fixture DOES carry one, or the ribbon's positive half
    // would be asserting against an empty band.
    expect(ticket({ id: 'tk_ok' }).stationName).toBe('Grill');
  });
});
