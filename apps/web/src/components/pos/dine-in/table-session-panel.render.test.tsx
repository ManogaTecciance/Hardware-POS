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
 *
 * D91 additions, all three mutations run against the component itself:
 * restoring the pre-D91 `.filter(status === 'AVAILABLE')` in `load()` fails
 * five; rendering the state chips but ignoring them fails three; and making
 * every table clickable regardless of whose session it is fails one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * Overridable per test (D91): the empty-state messages depend on what an area
 * CONTAINS, and the shared fixture deliberately holds one free and one
 * occupied table per area, so no filter over it is ever empty.
 */
const tablesFor = vi.fn<(areaId: string) => RestaurantTableView[]>(
  (areaId: string) => TABLES[areaId] ?? [],
);

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => Promise.resolve(AREAS) },
  restaurantTables: {
    list: (_s: unknown, areaId: string) => Promise.resolve(tablesFor(areaId)),
  },
  tableSessions: {
    listOpen: () => listOpenSessions(),
    open: (...args: unknown[]) => openSession(...args),
  },
}));

vi.mock('@/lib/restaurant/labels', () => ({
  formatElapsed: () => '5m',
  formatMoney: (v: number) => String(v),
  // D91 — the picker names a table's state on the chip. A stub missing this
  // does not fail loudly: the component reads `undefined[status]` and the
  // whole panel throws, which reads as a component bug rather than a mock gap.
  TABLE_STATUS_LABELS: {
    AVAILABLE: 'Available',
    SEATED: 'Seated',
    OCCUPIED: 'In service',
    BILLING: 'Bill requested',
    CLEANING: 'Cleaning',
    BLOCKED: 'Blocked',
    RESERVED: 'Reserved',
  },
}));

const session = { token: 't', user: { id: 'usr_waiter', tenantId: 'tnt' } } as never;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  listOpenSessions.mockResolvedValue([]);
  tablesFor.mockImplementation((areaId: string) => TABLES[areaId] ?? []);
});

const panel = (active: ActiveTableSession | null, onPick = vi.fn()) =>
  render(
    <TableSessionPanel
      session={session}
      branchId="br_1"
      active={active}
      onPick={onPick}
      onOpenBill={vi.fn()}
      roundsSent={0}
    />,
  );

describe('picking a table', () => {
  it('seats the free table tapped, and shows the occupied one without offering it', async () => {
    const onPick = vi.fn();
    openSession.mockResolvedValue({
      id: 'ts_1',
      sessionNumber: '000012',
      openedAt: '2026-08-21T10:00:00.000Z',
      guestCount: null,
    } as Partial<TableSessionView>);

    panel(null, onPick);

    /*
     * D91 (PO, 2026-08-21) — the picker used to DROP every table that was not
     * AVAILABLE, so a seated table simply was not there. It is drawn now, and
     * the distinction moved from "listed / not listed" to "tappable / not":
     * T2 belongs to another waiter, and the server refuses it (D70), so
     * offering the tap would be offering a refusal.
     */
    const t1 = await screen.findByRole('button', { name: /T1/ });
    const t2 = within(screen.getByRole('group', { name: 'Tables in this area' })).getByRole(
      'button',
      { name: /T2/ },
    );
    expect(t1.hasAttribute('disabled')).toBe(false);
    expect(t2.hasAttribute('disabled')).toBe(true);
    // …and it says WHY, rather than being mysteriously dead.
    expect(t2.textContent).toMatch(/In service/);

    // NEGATIVE, the half that still matters: tapping the other waiter's table
    // starts nothing at all.
    fireEvent.click(t2);
    expect(openSession).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();

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
    // NEGATIVE — the chip is the table, not "Session 000009".
    expect(chip.textContent).not.toMatch(/Session/);
    fireEvent.click(chip);

    expect(openSession).not.toHaveBeenCalled(); // resuming, not seating
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ts_9', tableLabel: 'M2', orderId: 'ord_9' }),
    );
  });

  it('shows exactly ONE area — the first — and offers no "all areas" escape', async () => {
    panel(null);

    // POSITIVE — the first area (Terrace, position 0) is selected on load.
    expect(await screen.findByRole('button', { name: /T1/ })).toBeTruthy();
    // NEGATIVE — and the second area's tables are NOT on screen. Paired, so a
    // component rendering nothing fails the first half and one rendering
    // everything fails the second.
    expect(screen.queryByRole('button', { name: /M1/ })).toBeNull();

    // PO, 2026-08-21: no "All areas" chip on this screen. Asserted by name
    // because its return would be invisible to every other test here.
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull();
    expect(screen.queryByRole('button', { name: /all areas/i })).toBeNull();
    // …and the real chips ARE present, so the two absences above are not
    // passing because the filter failed to render at all.
    expect(screen.getByRole('button', { name: 'Terrace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Main Hall' })).toBeTruthy();
  });

  it('swaps to the other area when its chip is tapped', async () => {
    panel(null);
    expect(await screen.findByRole('button', { name: /T1/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Main Hall' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /M1/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /T1/ })).toBeNull();

    // And back again — one area is always selected, so this is a swap rather
    // than a toggle that can land on nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Terrace' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /T1/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /M1/ })).toBeNull();
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

    // Scoped to the strip: under D91 the same table is ALSO drawn in the room
    // below while its own area is selected, and an unscoped query matches two.
    const strip = () => screen.getByRole('group', { name: 'Your open tables' });
    await waitFor(() => expect(within(strip()).getByRole('button', { name: /T2/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Main Hall' }));
    // Terrace's free table is gone with the filter…
    await waitFor(() => expect(screen.queryByRole('button', { name: /T1/ })).toBeNull());
    // …but Terrace's OPEN SESSION is still there, which is the claim.
    expect(within(strip()).getByRole('button', { name: /T2/ })).toBeTruthy();
    // …and it is no longer in the room grid, so the line above is proving the
    // strip survived the filter rather than finding the grid's copy.
    expect(
      within(screen.getByRole('group', { name: 'Tables in this area' })).queryByRole('button', {
        name: /T2/,
      }),
    ).toBeNull();
  });
});

describe('D91 — the table-state filter', () => {
  const room = () => screen.getByRole('group', { name: 'Tables in this area' });
  const roomTables = () =>
    within(room())
      .queryAllByRole('button')
      .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

  it('defaults to All, so both the free and the seated table are on screen', async () => {
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    // The ask was to SEE open tables, not to have to find a filter first.
    expect(screen.getByRole('button', { name: 'All' }).dataset.active).toBe('true');
    const shown = roomTables();
    expect(shown.some((t) => t.startsWith('T1'))).toBe(true);
    expect(shown.some((t) => t.startsWith('T2'))).toBe(true);
  });

  it('Free hides the seated table and keeps the free one', async () => {
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Free' }));

    // BOTH halves. A component that dropped everything passes the negative
    // alone; one that ignored the chip passes the positive alone.
    await waitFor(() => expect(roomTables().some((t) => t.startsWith('T2'))).toBe(false));
    expect(roomTables().some((t) => t.startsWith('T1'))).toBe(true);
  });

  it('Open hides the free table and keeps the seated one', async () => {
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(roomTables().some((t) => t.startsWith('T1'))).toBe(false));
    expect(roomTables().some((t) => t.startsWith('T2'))).toBe(true);
  });

  it('says which question came back empty rather than "no tables"', async () => {
    // Terrace: every table seated. Under Free that is "all seated", NOT "this
    // area has no tables" — the second reads as a setup error and sends a
    // waiter to the Tables screen to fix something that is not broken.
    tablesFor.mockImplementation((areaId: string) =>
      areaId === 'area_1' ? [table('tbl_2', 'area_1', 'T2', 'OCCUPIED')] : TABLES[areaId] ?? [],
    );
    panel(null);
    await screen.findByRole('button', { name: 'Free' });

    fireEvent.click(screen.getByRole('button', { name: 'Free' }));
    await waitFor(() => expect(within(room()).getByText(/Every table here is seated/)).toBeTruthy());
    // NEGATIVE — and not the message for an area with nothing in it.
    expect(within(room()).queryByText(/No tables in this area/)).toBeNull();

    // The mirror case: an area with nothing open says so in its own words.
    cleanup();
    tablesFor.mockImplementation((areaId: string) =>
      areaId === 'area_1' ? [table('tbl_1', 'area_1', 'T1', 'AVAILABLE')] : TABLES[areaId] ?? [],
    );
    panel(null);
    await screen.findByRole('button', { name: 'Open' });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(within(room()).getByText(/No open tables here/)).toBeTruthy());
    expect(within(room()).queryByText(/Every table here is seated/)).toBeNull();
  });

  it('an open table of MINE is tappable from the room, and resumes rather than seats', async () => {
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
    await screen.findByRole('button', { name: /T1/ });

    const mine = within(room()).getByRole('button', { name: /T2/ });
    // The same chip was DISABLED in the first test, where the session was not
    // this user's — so the difference being asserted is ownership, not status.
    expect(mine.hasAttribute('disabled')).toBe(false);

    fireEvent.click(mine);

    expect(openSession).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ts_9', tableLabel: 'T2', orderId: 'ord_9' }),
    );
  });
});

describe('an active session', () => {
  it('replaces the picker with a strip that can close the session', async () => {
    const onOpenBill = vi.fn();
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
        onOpenBill={onOpenBill}
        roundsSent={2}
      />,
    );

    // POSITIVE — the strip names the table and what has happened on it.
    expect(screen.getByText(/T1/)).toBeTruthy();
    expect(screen.getByText(/2 rounds sent/)).toBeTruthy();
    /*
     * NEGATIVE (PO, 2026-08-21) — and never the word "Session". A waiter says
     * "table nine"; the session number is an internal document id, and
     * leading with it buries the one label they recognise.
     */
    expect(screen.queryByText(/Session/)).toBeNull();
    // NEGATIVE — the picker is gone, so this is a swap and not an addition.
    expect(screen.queryByText(/Which table\?/)).toBeNull();

    // D71 — one door to the money. The strip opens the bill sheet; it no
    // longer closes the session directly, because reviewing and splitting
    // happen before the close and the waiter must see both first.
    fireEvent.click(screen.getByRole('button', { name: 'Bill' }));
    expect(onOpenBill).toHaveBeenCalledTimes(1);
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
        onOpenBill={vi.fn()}
        roundsSent={2}
      />,
    );

    // Collapsed by default — the menu is what the waiter is looking at now.
    expect(screen.queryByText('Which table?')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Change table/ }));
    expect(await screen.findByText('Which table?')).toBeTruthy();
    /*
     * The strip stays: the waiter must be able to see which table they are
     * about to move away from. Scoped to the strip deliberately — "T1" is
     * now on screen twice (the strip AND its own chip in the re-opened
     * picker), so an unscoped query would be ambiguous rather than wrong.
     */
    const stripMeta = screen.getByText(/2 rounds sent/);
    expect(stripMeta.parentElement?.textContent).toContain('T1');

    // M1 is in the second area, and only one area shows at a time now.
    fireEvent.click(await screen.findByRole('button', { name: 'Main Hall' }));
    fireEvent.click(await screen.findByRole('button', { name: /M1/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    // Picking collapses it again without waiting for the parent to re-render
    // with a new `active` — otherwise the wall of chips stays over the menu.
    await waitFor(() => expect(screen.queryByText('Which table?')).toBeNull());
  });
});
