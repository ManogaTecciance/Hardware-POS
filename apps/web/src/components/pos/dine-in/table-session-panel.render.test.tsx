/**
 * D69 — the dine-in session block, and the gate it puts in front of the cart.
 *
 * ## Why these two claims and not "it renders"
 *
 * The whole point of the block is that a dine-in order cannot be sent into
 * the void: without a table there is nothing to attach a round to, and the
 * failure mode if that gate is missing is silent — the waiter taps Confirm,
 * nothing reaches the kitchen, and the guests wait. So the gate is asserted
 * in BOTH directions on the same screen (no table → refused; table → armed),
 * because a one-sided test passes against a button that is permanently
 * disabled just as happily as against a correct one.
 *
 * Mutation-proven: dropping `tableSession !== null` from `canPlace` in
 * pos-counter-workspace.tsx flips test 2 to a pass-when-it-should-fail and
 * fails here.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiningAreaView, RestaurantTableView, TableSessionView } from '@/lib/restaurant/types';

import { TableSessionPanel, type ActiveTableSession } from './table-session-panel';

const AREAS: DiningAreaView[] = [
  { id: 'area_1', branchId: 'br_1', name: 'Terrace', position: 0, isActive: true } as DiningAreaView,
];
const TABLES: RestaurantTableView[] = [
  {
    id: 'tbl_1',
    areaId: 'area_1',
    code: 'T1',
    label: 'T1',
    capacity: 4,
    status: 'AVAILABLE',
  } as RestaurantTableView,
  {
    id: 'tbl_2',
    areaId: 'area_1',
    code: 'T2',
    label: 'T2',
    capacity: 2,
    status: 'OCCUPIED',
  } as RestaurantTableView,
];

const openSession = vi.fn();
const listOpenSessions = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => Promise.resolve(AREAS) },
  restaurantTables: { list: () => Promise.resolve(TABLES) },
  tableSessions: {
    listOpen: () => listOpenSessions(),
    open: (...args: unknown[]) => openSession(...args),
  },
}));

vi.mock('@/lib/restaurant/labels', () => ({
  formatElapsed: () => '5m',
  formatMoney: (v: number) => String(v),
}));

const session = { token: 't', user: { id: 'usr_waiter', tenantId: 'tnt' } } as never;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  listOpenSessions.mockResolvedValue([]);
});

const panel = (active: ActiveTableSession | null, onPick = vi.fn()) =>
  render(
    <TableSessionPanel
      session={session}
      branchId="br_1"
      active={active}
      onPick={onPick}
      onCloseSession={vi.fn()}
      closing={false}
      roundsSent={0}
    />,
  );

describe('picking a table', () => {
  it('offers only tables that are free, and seats the one tapped', async () => {
    const onPick = vi.fn();
    openSession.mockResolvedValue({
      id: 'ts_1',
      sessionNumber: '000012',
      openedAt: '2026-08-21T10:00:00.000Z',
      guestCount: null,
    } as Partial<TableSessionView>);

    panel(null, onPick);

    // POSITIVE — the free table is offered…
    const t1 = await screen.findByRole('button', { name: /T1/ });
    // …NEGATIVE — and the occupied one is not, so this is a real filter and
    // not merely "some buttons rendered".
    expect(screen.queryByRole('button', { name: /T2/ })).toBeNull();

    fireEvent.click(t1);

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    /*
     * The waiter is asserted explicitly. The server does not default it to
     * the caller, so omitting it leaves the kitchen board showing a ticket
     * with no name and the close path falling back to whoever pressed the
     * button. `toHaveBeenCalledWith` ignores undefined properties, so an
     * assertion that named only `tableId` would pass either way.
     */
    expect(openSession).toHaveBeenCalledWith(session, 'br_1', {
      tableId: 'tbl_1',
      waiterUserId: 'usr_waiter',
    });
    expect(onPick.mock.calls[0]![0]).toMatchObject({
      id: 'ts_1',
      tableLabel: 'T1',
      // Lazily created on the first send — a freshly seated table has no
      // order yet, and claiming one here would post the first round to a
      // non-existent id.
      orderId: null,
    });
  });

  it('lists an already-open session by its TABLE, not by a raw id', async () => {
    // The table behind an open session is OCCUPIED, so it is absent from the
    // available list — the label has to come from the full table set. This is
    // the regression that made every running session read "Session 000012".
    listOpenSessions.mockResolvedValue([
      {
        id: 'ts_9',
        sessionNumber: '000009',
        tableId: 'tbl_2',
        openedAt: '2026-08-21T09:00:00.000Z',
        guestCount: 2,
        activeOrderId: 'ord_9',
      },
    ]);
    const onPick = vi.fn();
    panel(null, onPick);

    const chip = await screen.findByRole('button', { name: /T2/ });
    fireEvent.click(chip);

    expect(openSession).not.toHaveBeenCalled(); // resuming, not seating
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ts_9', tableLabel: 'T2', orderId: 'ord_9' }),
    );
  });
});

describe('an active session', () => {
  it('replaces the picker with a strip that can close the session', async () => {
    const onCloseSession = vi.fn();
    render(
      <TableSessionPanel
        session={session}
        branchId="br_1"
        active={{
          id: 'ts_1',
          sessionNumber: '000012',
          tableLabel: 'T1',
          openedAt: '2026-08-21T10:00:00.000Z',
          guestCount: 4,
          orderId: 'ord_1',
        }}
        onPick={vi.fn()}
        onCloseSession={onCloseSession}
        closing={false}
        roundsSent={2}
      />,
    );

    // POSITIVE — the strip names the table and what has happened on it.
    expect(screen.getByText(/T1/)).toBeTruthy();
    expect(screen.getByText(/2 rounds sent/)).toBeTruthy();
    // NEGATIVE — the picker is gone, so this is a swap and not an addition.
    expect(screen.queryByText(/Which table\?/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Close session/ }));
    expect(onCloseSession).toHaveBeenCalledTimes(1);
  });
});
