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
const completeFn = vi.fn();
const reopenFn = vi.fn();
const orderFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    listTickets: (...args: unknown[]) => listFn(...args),
    complete: (...args: unknown[]) => completeFn(...args),
    reopen: (...args: unknown[]) => reopenFn(...args),
    order: (...args: unknown[]) => orderFn(...args),
  },
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
  completeFn.mockReset();
  reopenFn.mockReset();
  orderFn.mockReset();
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
  it('shows a full-width Mark done to the kitchen', async () => {
    outstandingRows = [ticket({ id: 'tk_1' }), ticket({ id: 'tk_2', placeLabel: 'T2' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /mark done/i })).toHaveLength(2),
    );
    // The bump is the whole bottom of the card, not a footer-sized button.
    for (const btn of screen.getAllByRole('button', { name: /mark done/i })) {
      expect(btn.className).toContain('w-full');
    }
  });

  it('shows the till no verbs at all, while Details still counts the tickets', async () => {
    canUpdate = false;
    outstandingRows = [ticket({ id: 'tk_1' }), ticket({ id: 'tk_2', placeLabel: 'T2' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(2),
    );
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /recall/i })).toBeNull();
  });
});

describe('the bump', () => {
  it('sends the completion and drops the card without waiting for the poll', async () => {
    outstandingRows = [ticket({ id: 'tk_1', placeLabel: 'T7' })];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);

    await waitFor(() => expect(screen.getByText('T7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /mark done/i }));

    await waitFor(() => expect(completeFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'tk_1'));
    await waitFor(() => expect(screen.queryByText('T7')).toBeNull());
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
