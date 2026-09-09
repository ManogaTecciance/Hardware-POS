/**
 * The kitchen board after D100 — age escalation, a kitchen-sized bump, and
 * recall.
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
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/auth';
import type { KitchenTicketView } from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

let canUpdate = true;

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => canUpdate }),
}));

const listFn = vi.fn();
const startFn = vi.fn();
const completeFn = vi.fn();
const reopenFn = vi.fn();
const orderFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    listTickets: (...args: unknown[]) => listFn(...args),
    start: (...args: unknown[]) => startFn(...args),
    complete: (...args: unknown[]) => completeFn(...args),
    reopen: (...args: unknown[]) => reopenFn(...args),
    order: (...args: unknown[]) => orderFn(...args),
  },
}));

// Sound is asserted against the chime module, same as the orders queue's
// polling suite — jsdom has no AudioContext to listen to.
const chime = vi.fn();
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

/** Mutable rows, so a verb can empty them and the reload stays honest. */
let outstandingRows: KitchenTicketView[] = [];
let doneRows: KitchenTicketView[] = [];

beforeEach(() => {
  canUpdate = true;
  outstandingRows = [];
  doneRows = [];
  listFn.mockReset();
  startFn.mockReset();
  completeFn.mockReset();
  reopenFn.mockReset();
  orderFn.mockReset();
  chime.mockReset();
  orderFn.mockImplementation(() => new Promise(() => undefined));
  listFn.mockImplementation((_s: unknown, _b: unknown, filter: unknown) =>
    Promise.resolve(filter === 'COMPLETED' ? doneRows : outstandingRows),
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
    await waitFor(() => expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));
    await waitFor(() => expect(screen.getByText('Nothing on the stove.')).toBeTruthy());
    // NEGATIVE — the instruction is for a verb the till does not hold.
    expect(screen.queryByText(/start a ticket from to make/i)).toBeNull();
  });

  it('…while the kitchen, holding the verb, is told where to start (positive control)', async () => {
    canUpdate = true;
    outstandingRows = [ticket({ id: 'tk_1' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1));

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

/*
 * The station ribbon.
 *
 * Pinned in pairs, like everything else here, because each half alone also
 * describes a broken card:
 *
 * - "Grill is on the card" passes on the OLD board too, where the station was
 *   grey subtitle text. The ribbon assertion is therefore paired with the
 *   subtitle no longer carrying it, which is what actually changed.
 * - The split-order case is the reason the ribbon exists: one table, two
 *   stations, two cards. Asserting one station name would pass on a board that
 *   rendered a single card and dropped the other.
 * - The separator pair guards the join: dropping the station from the front of
 *   the dotted run is exactly what a prefix-per-part build would turn into a
 *   leading " · ".
 */
describe('station ribbon', () => {
  it('promotes the station out of the subtitle into a ribbon atop the card', async () => {
    outstandingRows = [ticket({ id: 'tk_st', placeLabel: 'T1', stationName: 'Grill' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    // Positive: the station is its own ribbon, not loose text.
    const station = screen.getByText('Grill');
    const ribbon = station.parentElement;
    expect(ribbon?.className).toContain('bg-brand-50');

    // Negative: the subtitle it used to lead is still there, without it.
    const subtitle = screen.getByText('RO-000010 · Nimal');
    expect(subtitle.textContent).not.toContain('Grill');

    /*
     * Placement, pinned both ways. "The station is on the card somewhere"
     * passes with it back in the grey run it came from, so pin the ribbon to
     * the top: it precedes the place, and sits OUTSIDE the block that owns the
     * place and its provenance line. Either assertion alone still allows the
     * old position.
     */
    const title = screen.getByText('T1');
    expect(station.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.parentElement?.contains(station)).toBe(false);
  });

  it('tells two cards of one station-split order apart', async () => {
    // The same table, the same round, routed to two stations — the case that
    // made the grey subtitle insufficient.
    outstandingRows = [
      ticket({ id: 'tk_a', placeLabel: 'T4', stationName: 'Main Kitchen' }),
      ticket({ id: 'tk_b', placeLabel: 'T4', stationName: 'Grill' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getAllByText('T4')).toHaveLength(2));
    expect(screen.getByText('Main Kitchen')).toBeTruthy();
    expect(screen.getByText('Grill')).toBeTruthy();
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
});
