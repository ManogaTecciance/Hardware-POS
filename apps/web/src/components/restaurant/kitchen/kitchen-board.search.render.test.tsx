/**
 * D200 — the kitchen board searches on the SERVER.
 *
 * The board reads one lane at a time and polls; a client-side match over the
 * rows in hand would answer "no tickets" for a ticket on the other lane and
 * leave the chips counting the unsearched pass. So the term goes to the
 * server on every poll, the counts narrow with it, and the fixture below
 * plays the server: it filters on the same three legs the real query does.
 *
 * ## Why these claims
 *
 *   - the term is asserted ON THE WIRE (the fourth argument), not on the
 *     screen alone — a board that filtered client-side would render the same
 *     cards for a one-lane fixture and pass a screen-only assertion;
 *   - the unsearched calls are asserted to keep THREE arguments, because the
 *     D174 specs pin that arity as the proof the list is never station-cut,
 *     and this feature must not blur it;
 *   - under a station cut the counts route is asserted to get the same term,
 *     since a chip that counted the unsearched station over searched cards
 *     is the disagreement D174 was raised to end;
 *   - a term that reveals tickets is asserted NOT to ring: a search is a
 *     change of view, and D152's rule for the station cut applies.
 *
 * Mutation-proven, each against the component itself:
 *   1. the term dropped from the list read — every case fails (the fixture
 *      then returns the whole pass, so nothing narrows and the empty lane
 *      never appears);
 *   2. the term dropped from the counts read under a cut — "narrows the
 *      station's counts" fails alone;
 *   3. the term dropped from the chime key — "does not ring" fails alone.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/auth';
import type { KitchenStationView, KitchenTicketView } from '@/lib/restaurant/types';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const listFn = vi.fn();
const laneCountsFn = vi.fn();
const stationsFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  kitchen: {
    listTickets: (...args: unknown[]) => listFn(...args),
    laneCounts: (...args: unknown[]) => laneCountsFn(...args),
    start: vi.fn(),
    complete: vi.fn(),
    reopen: vi.fn(),
    order: () => new Promise(() => undefined),
  },
  kitchenStations: { list: (...args: unknown[]) => stationsFn(...args) },
}));
const chime = vi.fn();
vi.mock('@/lib/restaurant/new-order-chime', () => ({ playNewOrderChime: () => chime() }));
vi.mock('@/lib/restaurant/kot-print', () => ({ printKitchenTicket: vi.fn() }));

const { KitchenBoard } = await import('./kitchen-board');

const SESSION = { token: 'tok' } as unknown as Session;

function ticket(
  id: string,
  dish: string,
  over: Partial<KitchenTicketView> = {},
): KitchenTicketView {
  return {
    id,
    ticketNumber: `KOT-${id}`,
    branchId: 'brn_1',
    roundId: 'rnd_1',
    stationId: 'stn_1',
    stationName: 'Grill',
    status: 'QUEUED',
    orderNumber: `RO-${id}`,
    callNumber: null,
    placeLabel: 'T1 · Main',
    roundNumber: 1,
    waiterName: 'Nimal',
    items: [
      {
        id: `it_${id}`,
        menuItemName: dish,
        variantName: null,
        quantity: '1.000',
        modifierNames: [],
        specialInstructions: null,
      },
    ],
    completedAt: null,
    completedByName: null,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    ...over,
  };
}

function station(id: string, name: string): KitchenStationView {
  return {
    id,
    branchId: 'brn_1',
    code: name.toUpperCase(),
    name,
    category: 'FOOD',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** The server's three legs, played by the fixture (D175/D200). */
function matches(t: KitchenTicketView, term: string): boolean {
  const q = term.toLowerCase();
  return (
    t.ticketNumber.toLowerCase().includes(q) ||
    (t.orderNumber ?? '').toLowerCase().includes(q) ||
    t.items.some((i) => i.menuItemName.toLowerCase().includes(q))
  );
}

let rows: KitchenTicketView[] = [];

function counted(list: KitchenTicketView[]) {
  return {
    toMake: list.filter((t) => t.status !== 'IN_PROGRESS').length,
    preparing: list.filter((t) => t.status === 'IN_PROGRESS').length,
    doneToday: 0,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Types into the box and waits out the 250 ms debounce. */
async function typeSearch(value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search kitchen tickets' }), {
    target: { value },
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

/** The term each list call carried, or null for a three-argument call. */
const termsSent = () =>
  listFn.mock.calls.map((c) => (c.length > 3 ? (c[3] as { search?: string }).search : null));

beforeEach(() => {
  rows = [ticket('1', 'Kottu'), ticket('2', 'Lamprais'), ticket('3', 'Chicken Wings')];
  listFn.mockReset();
  laneCountsFn.mockReset();
  stationsFn.mockReset();
  chime.mockReset();
  window.localStorage.clear();
  stationsFn.mockImplementation(() => Promise.resolve([station('stn_1', 'Grill')]));
  listFn.mockImplementation(
    (_s: unknown, _b: unknown, _filter: unknown, options?: { search?: string }) => {
      const list = options?.search ? rows.filter((t) => matches(t, options.search!)) : rows;
      return Promise.resolve({ items: list, counts: counted(list) });
    },
  );
  laneCountsFn.mockImplementation(
    (_s: unknown, _b: unknown, stationId: string, search?: string) => {
      const mine = rows.filter((t) => t.stationId === stationId);
      return Promise.resolve(counted(search ? mine.filter((t) => matches(t, search)) : mine));
    },
  );
});

afterEach(() => {
  cleanup();
});

describe('searching the kitchen board (D200)', () => {
  it('sends the term to the server, and keeps three arguments while there is none', async () => {
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText(/1× Lamprais$/)).toBeTruthy());
    // Before a term: the D174 call shape, untouched.
    expect(termsSent()).toEqual([null]);

    await typeSearch('lamp');

    // POSITIVE — the wire carries it, normalised…
    await waitFor(() => expect(termsSent()).toContain('lamp'));
    // …and the screen shows the server's answer: the matching card, the chip
    // counting it, the others gone.
    await waitFor(() => expect(screen.queryByText(/1× Kottu$/)).toBeNull());
    expect(screen.getByText(/1× Lamprais$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^To make/ }).textContent).toMatch(/1/);
  });

  it('the empty lane says what was searched, and offers the whole pass back', async () => {
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText(/1× Kottu$/)).toBeTruthy());

    await typeSearch('pizza');

    await waitFor(() =>
      expect(screen.getByText(/No tickets match “pizza” on this lane\./)).toBeTruthy(),
    );
    // NEGATIVE — not the "nothing to make" copy, which would read as an empty
    // kitchen rather than a search that found nothing.
    expect(screen.queryByText(/Nothing to make/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show every ticket' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    await waitFor(() => expect(screen.getByText(/1× Kottu$/)).toBeTruthy());
    // The read after clearing is a three-argument read again.
    expect(termsSent().at(-1)).toBeNull();
  });

  it('narrows the station’s counts with the same term under a station cut', async () => {
    stationsFn.mockImplementation(() =>
      Promise.resolve([station('stn_1', 'Grill'), station('stn_2', 'Fryer')]),
    );
    rows = [
      ticket('1', 'Kottu'),
      ticket('2', 'Lamprais'),
      ticket('3', 'Chicken Wings', { stationId: 'stn_2', stationName: 'Fryer' }),
      ticket('4', 'Prawn Wings', { stationId: 'stn_2', stationName: 'Fryer' }),
    ];
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Fryer/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Fryer/ }));
    await waitFor(() => expect(laneCountsFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'stn_2'));

    await typeSearch('prawn');

    // POSITIVE — the counts route asked for the station AND the term…
    await waitFor(() =>
      expect(laneCountsFn).toHaveBeenCalledWith(SESSION, 'brn_1', 'stn_2', 'prawn'),
    );
    // …and the list read stayed station-unscoped, carrying only the term.
    const last = listFn.mock.calls.at(-1)!;
    expect(last).toHaveLength(4);
    expect(last[3]).toEqual({ search: 'prawn' });
    await waitFor(() => expect(screen.getByText(/1× Prawn Wings$/)).toBeTruthy());
    expect(screen.queryByText(/1× Chicken Wings$/)).toBeNull();
  });

  it('does not ring for the tickets a search reveals — a search is a change of view', async () => {
    render(<KitchenBoard session={SESSION} branchId="brn_1" />);
    await waitFor(() => expect(screen.getByText(/1× Kottu$/)).toBeTruthy());

    // Narrow to one, then widen back: the two "hidden" tickets come back into
    // view. Nothing arrived, so nothing rings.
    await typeSearch('lamp');
    await waitFor(() => expect(screen.queryByText(/1× Kottu$/)).toBeNull());
    await typeSearch('');
    await waitFor(() => expect(screen.getByText(/1× Kottu$/)).toBeTruthy());
    expect(chime).not.toHaveBeenCalled();

    // POSITIVE CONTROL — a genuine arrival under the same view still rings.
    rows = [...rows, ticket('9', 'Kottu Special')];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(chime).toHaveBeenCalledTimes(1));
  });
});
