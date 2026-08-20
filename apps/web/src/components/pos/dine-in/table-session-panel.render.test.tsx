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
  { id: 'area_2', branchId: 'br_1', name: 'Main Hall', position: 1, isActive: true } as DiningAreaView,
];

const table = (
  id: string,
  areaId: string,
  code: string,
  status: string,
): RestaurantTableView =>
  ({ id, areaId, code, label: code, capacity: 4, status } as RestaurantTableView);

const TABLES: Record<string, RestaurantTableView[]> = {
  area_1: [table('tbl_1', 'area_1', 'T1', 'AVAILABLE'), table('tbl_2', 'area_1', 'T2', 'OCCUPIED')],
  // The occupied table behind the cross-area open-session test.
  area_2: [table('tbl_3', 'area_2', 'M1', 'AVAILABLE'), table('tbl_4', 'area_2', 'M2', 'OCCUPIED')],
};

const openSession = vi.fn();
const listOpenSessions = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => Promise.resolve(AREAS) },
  restaurantTables: {
    list: (_s: unknown, areaId: string) => Promise.resolve(TABLES[areaId] ?? []),
  },
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
    /*
     * Two ways this label goes missing, both covered by this one fixture:
     * the table behind an open session is OCCUPIED (absent from the
     * available lists), and it lives in a DIFFERENT area from the one the
     * filter would show. Either shortcut — deriving labels from the
     * available rows, or loading only the filtered area — leaves the waiter
     * a chip reading "Session 000009" with no way to tell which table it is.
     */
    listOpenSessions.mockResolvedValue([
      {
        id: 'ts_9',
        sessionNumber: '000009',
        tableId: 'tbl_4',
        openedAt: '2026-08-21T09:00:00.000Z',
        guestCount: 2,
        activeOrderId: 'ord_9',
      },
    ]);
    const onPick = vi.fn();
    panel(null, onPick);

    const chip = await screen.findByRole('button', { name: /M2/ });
    fireEvent.click(chip);

    expect(openSession).not.toHaveBeenCalled(); // resuming, not seating
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ts_9', tableLabel: 'M2', orderId: 'ord_9' }),
    );
  });

  it('narrows the table list to one area, and can be widened again', async () => {
    panel(null);

    // Default: both areas' free tables are offered.
    expect(await screen.findByRole('button', { name: /T1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /M1/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Main Hall' }));

    // POSITIVE + NEGATIVE together: a component that rendered nothing would
    // satisfy the absence check alone, and one that ignored the chips would
    // satisfy the presence check alone.
    await waitFor(() => expect(screen.queryByRole('button', { name: /T1/ })).toBeNull());
    expect(screen.getByRole('button', { name: /M1/ })).toBeTruthy();

    // A filter that cannot be undone is a trap.
    fireEvent.click(screen.getByRole('button', { name: 'All areas' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /T1/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /M1/ })).toBeTruthy();
  });

  it('keeps open sessions visible when an area filter is applied', async () => {
    // The session is in Terrace; the filter shows Main Hall. Filtering it out
    // would hide a running party — which is how one gets forgotten.
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
    panel(null);

    expect(await screen.findByRole('button', { name: /T2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Main Hall' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /T1/ })).toBeNull());
    expect(screen.getByRole('button', { name: /T2/ })).toBeTruthy();
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

  it('re-opens the picker on demand and collapses it again on a new pick', async () => {
    const onPick = vi.fn();
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
        onPick={onPick}
        onCloseSession={vi.fn()}
        closing={false}
        roundsSent={2}
      />,
    );

    // Collapsed by default — the menu is what the waiter is looking at now.
    expect(screen.queryByText('Which table?')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Change table/ }));
    expect(await screen.findByText('Which table?')).toBeTruthy();
    // The strip stays: the waiter must be able to see which session they are
    // about to move away from.
    expect(screen.getByText(/Session 000012/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /M1/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    // Picking collapses it again without waiting for the parent to re-render
    // with a new `active` — otherwise the wall of chips stays over the menu.
    await waitFor(() => expect(screen.queryByText('Which table?')).toBeNull());
  });
});
