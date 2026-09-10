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
 * - Layout: `h-full` and `mt-auto` are asserted together, because either one
 *   alone still describes a row of cards whose buttons fail to line up; the
 *   provenance row is pinned by what its row does NOT contain (the timer),
 *   which is the whole of what moving it changed.
 * - D147's "no station on the card" is asserted against a fixture that still
 *   CARRIES one on the wire, so the negative has something to catch, and the
 *   pair is mutation-proved at the foot of the file.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/auth';
import type { KitchenTicketView } from '@/lib/restaurant/types';

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
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    listTickets: (...args: unknown[]) => listFn(...args),
    start: (...args: unknown[]) => startFn(...args),
    complete: (...args: unknown[]) => completeFn(...args),
    reopen: (...args: unknown[]) => reopenFn(...args),
    order: (...args: unknown[]) => orderFn(...args),
    laneCounts: (...args: unknown[]) => laneCountsFn(...args),
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
    // D147 — a ticket is the whole round and is routed to no station, so
    // every ticket cut since that decision carries none.
    stationId: null,
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
 * D147 — a row that still CARRIES a station, exactly as an older server sent
 * it (and as every ticket cut before the decision still stores).
 *
 * The negatives in the D147 suite say the board prints no station anywhere.
 * Against a fixture with no station in it those would be VACUOUS — green on a
 * board that had simply been handed nothing to print, which is the shape D30
 * forbids. So the wire keeps the field the view type no longer declares: the
 * moment any of the card, its subtitle or the Details dialog renders a station
 * again, "Grill" is on screen and these tests go red. Proven by mutation at
 * the bottom of this file.
 */
function withStationOnTheWire(t: KitchenTicketView, stationName = 'Grill'): KitchenTicketView {
  return { ...t, stationId: 'stn_grill', stationName } as KitchenTicketView;
}

/**
 * Nowhere in `root` does the string `station` appear — neither a station NAME
 * the wire carried nor the "no station" warning the old dialog printed.
 *
 * Shared so the mutation proof at the foot of this file can be run against the
 * pre-D147 markup and shown to fail: an assertion no fixture can break is not
 * an assertion.
 */
function expectNoStationAnywhere(root: HTMLElement, name = 'Grill') {
  expect(root.textContent ?? '').not.toContain(name);
  expect(root.textContent ?? '').not.toMatch(/station/i);
}

/** Mutable rows, so a verb can empty them and the reload stays honest. */
let outstandingRows: KitchenTicketView[] = [];
let doneRows: KitchenTicketView[] = [];

beforeEach(() => {
  canUpdate = true;
  outstandingRows = [];
  doneRows = [];
  listFn.mockReset();
  laneCountsFn.mockReset();
  // D142b — the chips the board is not fetching read these.
  laneCountsFn.mockResolvedValue({ toMake: 0, preparing: 0, doneToday: 0 });
  startFn.mockReset();
  completeFn.mockReset();
  reopenFn.mockReset();
  orderFn.mockReset();
  chime.mockReset();
  orderFn.mockImplementation(() => new Promise(() => undefined));
  /*
   * D142 — the Done lane asks for `COMPLETED_TODAY`, not `COMPLETED`. Keyed on
   * the exact token the board sends so a lane that silently reverted to the
   * unbounded fetch would serve OUTSTANDING rows here and fail loudly, rather
   * than passing on a fixture that answered both.
   */
  listFn.mockImplementation((_s: unknown, _b: unknown, filter: unknown) =>
    Promise.resolve(filter === 'COMPLETED_TODAY' ? doneRows : outstandingRows),
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
          // Still on the wire, unread since D147 — left here so this test's
          // dialog is also handed a station it must not print.
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
    const provenance = screen.getByText('RO-000010 · round 1 · Nimal');
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
  const chipText = (name: RegExp) =>
    screen.getByRole('button', { name }).textContent?.replace(/\s+/g, ' ') ?? '';

  it('shows all three counts from the outstanding lanes', async () => {
    outstandingRows = [
      ticket({ id: 'tk_1' }),
      ticket({ id: 'tk_2', status: 'IN_PROGRESS' }),
      ticket({ id: 'tk_3', status: 'IN_PROGRESS' }),
    ];
    laneCountsFn.mockResolvedValue({ toMake: 1, preparing: 2, doneToday: 7 });
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
    laneCountsFn.mockResolvedValue({ toMake: 4, preparing: 3, doneToday: 2 });
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
    laneCountsFn.mockResolvedValue({ toMake: 99, preparing: 99, doneToday: 0 });
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

  it('keeps the last numbers when a counts poll fails, rather than blanking them', async () => {
    outstandingRows = [ticket({ id: 'tk_1' })];
    laneCountsFn.mockResolvedValueOnce({ toMake: 1, preparing: 0, doneToday: 5 });
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(chipText(/^Done/)).toContain('5'));

    laneCountsFn.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: /^Preparing/ }));

    // The board is still up and Done still says what it last knew — a chip
    // without a number is a smaller problem than a board that fell over.
    await waitFor(() => expect(chipText(/^Done/)).toContain('5'));
    expect(screen.queryByText(/Failed to load kitchen tickets/)).toBeNull();
  });
});

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

/*
 * D147 — one ticket per round, and nothing on it names a station.
 *
 * A ticket used to be one STATION's share of a round, which split a single
 * send across several cards and — because there is no reachable screen for
 * linking a dish to a station, and this branch has four — silently dropped
 * every unlinked dish before it ever reached the board. The round is the unit
 * now: one card, every item on it, no station anywhere.
 *
 * Both halves, always. The positive says what the card DOES print (the exact
 * subtitle, every dish of the round); the negative says the station the wire
 * still carries is not on screen. Either alone passes on a broken board: a
 * card that printed nothing at all would satisfy the negative, and a card that
 * kept the station would satisfy the positive.
 */
describe('one ticket per round (D147)', () => {
  it('names the order, the round and the waiter — and no station', async () => {
    outstandingRows = [withStationOnTheWire(ticket({ id: 'tk_1' }))];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1 · Main')).toBeTruthy());
    // POSITIVE — the whole line under the place, exactly as it now reads.
    expect(screen.getByText('RO-000010 · round 1 · Nimal')).toBeTruthy();
    // NEGATIVE — against a row that is still handing the board a station.
    expectNoStationAnywhere(container);
  });

  it('opens the subtitle with the order, never with a stray separator', async () => {
    // The station used to lead this line, so every ` · ` after it was a
    // PREFIX. Removing the first element without removing its separator would
    // read "· round 2" on every card — invisible to a test that only asserts
    // the round is mentioned, which is why the line is pinned whole.
    outstandingRows = [
      withStationOnTheWire(
        ticket({ id: 'tk_1', orderNumber: null, roundNumber: 2, waiterName: null }),
      ),
    ];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1 · Main')).toBeTruthy());
    const subtitle = screen.getByText(/round 2/);
    expect(subtitle.textContent).toBe('round 2');
    expectNoStationAnywhere(container);
  });

  it('joins every surviving part on a full card, and starts a thin one at its first', async () => {
    // The join, seen from both ends on one board: the full ticket keeps the
    // whole dotted run, and the ticket missing its first part starts at the
    // next survivor rather than at " · ".
    outstandingRows = [
      withStationOnTheWire(ticket({ id: 'tk_full', placeLabel: 'T1' })),
      withStationOnTheWire(ticket({ id: 'tk_thin', placeLabel: 'T2', orderNumber: null })),
    ];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T2')).toBeTruthy());

    // Positive: a full ticket still joins every survivor.
    expect(screen.getByText('RO-000010 · round 1 · Nimal')).toBeTruthy();
    // Negative: a thin one carries no leading separator.
    const thin = screen.getByText('round 1 · Nimal');
    expect(thin.textContent).toBe('round 1 · Nimal');
    expectNoStationAnywhere(container);
  });

  it('leaves the round out rather than printing a bare "round null"', async () => {
    /*
     * Their branch pinned this and it very nearly went out with the ribbon
     * (35e94fa: "The round is null-guarded, or a ticket predating rounds
     * prints a bare 'Round'"). The GUARD moved into the join above when the
     * ribbon that carried the round was removed, so the claim outlived the
     * test that proved it — deleting the guard left this whole spec green.
     *
     * A ticket predating rounds is the case: `roundNumber` is null on the
     * wire, and an unguarded template would put "round null" on the pass.
     */
    outstandingRows = [
      withStationOnTheWire(ticket({ id: 'tk_noround', placeLabel: 'T9', roundNumber: null })),
    ];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T9')).toBeTruthy());

    // POSITIVE — the other two parts still join, which is what separates
    // "this ticket has no round" from "this ticket has no subtitle".
    const line = screen.getByText('RO-000010 · Nimal');
    expect(line.textContent).toBe('RO-000010 · Nimal');
    // NEGATIVE — the word never reaches the card at all, in any casing.
    expect(screen.queryByText(/round/i)).toBeNull();
    expectNoStationAnywhere(container);
  });

  it('puts every dish of the round on ONE card, whichever station used to cook it', async () => {
    /*
     * RO-000026 in the dev database: one round of fifteen lines that became
     * KOT-000027 (Main Kitchen) and KOT-000028 (Grill — Chicken Wings and
     * Grilled Seer Fish). Those three dishes now arrive on one ticket, and the
     * card has to show all three: the pass plates the round, not a station's
     * corner of it.
     */
    outstandingRows = [
      withStationOnTheWire(
        ticket({
          id: 'tk_round',
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
        // Not the default 'Grill' here: "Grilled Seer Fish" CONTAINS it, and a
        // negative that a dish name can trip is a false alarm waiting to
        // happen. The wire carries the other half of the real split instead.
        'Main Kitchen',
      ),
    ];
    const { container } = render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T1 · Main')).toBeTruthy());
    // ONE card — the split is what D147 removed, so the count is the claim.
    expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1);
    const card = screen.getByText('T1 · Main').closest('.rounded-2xl') as HTMLElement;
    expect(within(card).getByText(/2× Chicken Wings/)).toBeTruthy();
    expect(within(card).getByText(/1× Grilled Seer Fish/)).toBeTruthy();
    expect(within(card).getByText(/3× Kottu/)).toBeTruthy();
    expectNoStationAnywhere(container, 'Main Kitchen');
  });

  it('the Details dialog lists the order by round, with no station chip and no "no station" warning', async () => {
    outstandingRows = [withStationOnTheWire(ticket({ id: 'tk_1', placeLabel: 'T7' }))];
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
            // Still on the wire, and deliberately so: the chip's absence has
            // to be the component's doing, not the fixture's.
            stationName: 'Grill',
          },
          {
            id: 'oi_2',
            name: 'Watalappan',
            variantName: null,
            quantity: '1.000',
            modifierNames: [],
            specialInstructions: null,
            roundNumber: 2,
            // The other half of the old chip: an unlinked dish used to be
            // labelled "no station" in warning colours, which described the
            // setup and read as a fault on the plate.
            stationName: null,
          },
        ],
      }),
    );
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /details/i }));

    const dialog = await screen.findByRole('dialog');
    // POSITIVE — the rounds and their dishes are what the dialog is for.
    await waitFor(() => expect(within(dialog).getByText('Round 1')).toBeTruthy());
    expect(within(dialog).getByText('Round 2')).toBeTruthy();
    expect(within(dialog).getByText(/1× Kottu/)).toBeTruthy();
    expect(within(dialog).getByText(/1× Watalappan/)).toBeTruthy();
    // NEGATIVE — neither state of the chip survives.
    expectNoStationAnywhere(dialog);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs (D30)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The D147 negatives above are absence claims, and an absence claim is the
 * easiest kind of test to leave vacuous. Two things are shown here:
 *
 * 1. `expectNoStationAnywhere` genuinely fails on the markup this slice
 *    removed — the pre-D147 subtitle and the pre-D147 station chip, rendered
 *    verbatim below.
 * 2. `withStationOnTheWire` really does put a station in front of the
 *    component, so the assertion is looking at a fixture that COULD break it.
 *
 * Beyond these, the real components were mutated on a scratch copy taken
 * outside the repo and this suite re-run against each mutation; every one went
 * red where it should and green again on restore. What each killed:
 *
 * - The station back at the head of the provenance line (as it read before
 *   D147) — all four D147 card negatives.
 * - The station chip back on ticket-order-dialog.tsx's item lines — the D147
 *   dialog negative. Both halves of the old chip come back together, so the
 *   "no station" warning is covered with the name.
 * - `h-full` off the Card — "pins the actions to the bottom". Separately,
 *   `mt-auto` off the actions block — the SAME one test, which is why the
 *   pair is asserted together: either mutation alone still lines the cards up
 *   wrong, and either assertion alone would miss one of them.
 * - The provenance line moved back inside the header row beside the timer —
 *   "gives the provenance line a row of its own".
 * - `shrink-0` off the completion time, letting it truncate with the name —
 *   "keeps the ticket number and Details on one line".
 * - Every chip reading the SERVER count, the fetched lanes included — "moves
 *   the active lane's chip on a bump" (D142b's optimistic half). Dropping the
 *   server counts entirely, back to counting only the open lane, killed all
 *   four chip tests.
 * - `COMPLETED` in place of `COMPLETED_TODAY` — "asks the server for the
 *   day-scoped lane" and seven other tests that reach the Done lane, since the
 *   fixture answers that token with the OUTSTANDING rows rather than pretending
 *   both are the same lane.
 * - The lane cut ignoring IN_PROGRESS — five lane tests, the control that says
 *   `inLane` is doing the work the counts and the board both read from.
 */
describe('the D147 negatives can actually fail', () => {
  it('catches the subtitle this slice removed', () => {
    const { container } = render(
      // The line as it stood before D147: station first, everything else a
      // ` · ` prefix hanging off it.
      <p>{`Grill · RO-000010 · round 1 · Nimal`}</p>,
    );
    expect(() => expectNoStationAnywhere(container)).toThrow();
  });

  it('catches both states of the station chip this slice removed', () => {
    const named = render(<span>Grill</span>);
    expect(() => expectNoStationAnywhere(named.container)).toThrow();
    cleanup();

    // The warning state matched no station NAME, which is why the assertion
    // also refuses the word itself — otherwise "no station" would slip past.
    const unnamed = render(<span>no station</span>);
    expect(() => expectNoStationAnywhere(unnamed.container)).toThrow();
  });

  it('hands the component a station to print, so the negatives are not vacuous', () => {
    const row = withStationOnTheWire(ticket({ id: 'tk_1' })) as KitchenTicketView & {
      stationName?: string;
    };
    expect(row.stationName).toBe('Grill');
    expect(row.stationId).toBe('stn_grill');
  });
});
