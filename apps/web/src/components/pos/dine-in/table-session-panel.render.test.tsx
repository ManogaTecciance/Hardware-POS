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
     * A floor lists the tables you can seat. The occupied T2 is NOT here —
     * under D92 it lives under the Open chip, which the tests below prove.
     * The pairing matters: "absent from the floor" on its own is also what a
     * component that dropped every occupied table would produce, which is
     * exactly the pre-D91 defect.
     */
    const t1 = await screen.findByRole('button', { name: /T1/ });
    const room = screen.getByRole('group', { name: 'Tables in this area' });
    expect(t1.hasAttribute('disabled')).toBe(false);
    expect(within(room).queryByRole('button', { name: /T2/ })).toBeNull();

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

describe('D92 — Open is a destination in the strip, not a second filter', () => {
  const room = () => screen.getByRole('group', { name: 'Tables in this area' });
  const roomTables = () =>
    within(room())
      .queryAllByRole('button')
      .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
  const openSessionRow = (id: string, tableId: string) => ({
    id,
    sessionNumber: '0000' + id.slice(-1),
    tableId,
    openedAt: '2026-08-21T09:00:00.000Z',
    guestCount: 2,
    activeOrderId: 'ord_' + id.slice(-1),
  });

  it('offers Open beside the floors, and nothing else — the All and Free chips are gone', async () => {
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    // POSITIVE: one strip, three destinations.
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terrace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Main Hall' })).toBeTruthy();
    // NEGATIVE: the D91 state chips are gone (PO, 2026-08-21). Asserted by
    // name because their return would be invisible to every other test here.
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Free' })).toBeNull();
  });

  it('a floor lists its free tables and says where the seated ones went', async () => {
    // Terrace: one free, one seated. The seated one is under Open.
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    expect(roomTables().some((t) => t.startsWith('T1'))).toBe(true);
    expect(roomTables().some((t) => t.startsWith('T2'))).toBe(false);

    // And when a floor is ENTIRELY seated it points at Open rather than
    // reading as an area with no tables in it.
    cleanup();
    tablesFor.mockImplementation((areaId: string) =>
      areaId === 'area_1' ? [table('tbl_2', 'area_1', 'T2', 'OCCUPIED')] : TABLES[areaId] ?? [],
    );
    panel(null);
    await waitFor(() =>
      expect(within(room()).getByText(/Every table here is seated — they are under Open/)).toBeTruthy(),
    );
    expect(within(room()).queryByText(/No tables in this area/)).toBeNull();
  });

  it('Open lists the seated tables of EVERY floor, and none of the free ones', async () => {
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    // Both floors' occupied tables, which is the point of it being its own
    // destination: a waiter carrying two rooms looks in one place.
    await waitFor(() => expect(roomTables().some((t) => t.startsWith('T2'))).toBe(true));
    expect(roomTables().some((t) => t.startsWith('M2'))).toBe(true);
    // NEGATIVE, both floors: the free tables are not here.
    expect(roomTables().some((t) => t.startsWith('T1'))).toBe(false);
    expect(roomTables().some((t) => t.startsWith('M1'))).toBe(false);
  });

  it('under Open, mine resumes and another waiter’s is shown but dead', async () => {
    // tbl_2 (T2) is this waiter's; tbl_4 (M2) is occupied by someone whose
    // session the server does not return (D70).
    listOpenSessions.mockResolvedValue([openSessionRow('ts_9', 'tbl_2')]);
    const onPick = vi.fn();
    panel(null, onPick);
    await screen.findByRole('button', { name: /T1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(within(room()).getByRole('button', { name: /T2/ })).toBeTruthy());

    const theirs = within(room()).getByRole('button', { name: /M2/ });
    expect(theirs.hasAttribute('disabled')).toBe(true);
    // …and it says WHY, rather than being mysteriously dead.
    expect(theirs.textContent).toMatch(/In service/);
    fireEvent.click(theirs);
    expect(onPick).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();

    // The same chip shape, the other way: ownership is the difference.
    const mine = within(room()).getByRole('button', { name: /T2/ });
    expect(mine.hasAttribute('disabled')).toBe(false);
    fireEvent.click(mine);
    expect(openSession).not.toHaveBeenCalled(); // resuming, not seating
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ts_9', tableLabel: 'T2', orderId: 'ord_9' }),
    );
  });

  it('says so once when nothing is open, instead of once per empty floor', async () => {
    tablesFor.mockImplementation((areaId: string) =>
      areaId === 'area_1'
        ? [table('tbl_1', 'area_1', 'T1', 'AVAILABLE')]
        : [table('tbl_3', 'area_2', 'M1', 'AVAILABLE')],
    );
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(within(room()).getByText(/No open tables right now/)).toBeTruthy());
    // NEGATIVE: two floors, ONE message — no per-floor heading with nothing
    // under it, which is what makes a quiet branch unreadable.
    expect(within(room()).queryByText('Terrace')).toBeNull();
    expect(within(room()).queryByText('Main Hall')).toBeNull();
  });

  it('picking a floor again leaves Open, so the strip holds one selection', async () => {
    panel(null);
    await screen.findByRole('button', { name: /T1/ });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(roomTables().some((t) => t.startsWith('T2'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Main Hall' }));

    // Back to a floor: its free table, and neither floor's open ones.
    await waitFor(() => expect(roomTables().some((t) => t.startsWith('M1'))).toBe(true));
    expect(roomTables().some((t) => t.startsWith('T2'))).toBe(false);
    expect(roomTables().some((t) => t.startsWith('M2'))).toBe(false);
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
