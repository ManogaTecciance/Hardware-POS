/**
 * D153 — changing the waiter on a table, from the floor.
 *
 * The PO's case: mid-service the guests ask for someone else, and the owner has
 * to be able to answer without stopping service. The control lives on the
 * served-by name D151a put on the card, because that is the thing being
 * changed.
 *
 * ## Why these claims
 *
 *   - the affordance is PERMISSION-gated, and "hidden" is indistinguishable
 *     from "the card has no name" unless the same fixture is proven to show the
 *     name either way — so both cases assert the name and differ only on the
 *     button;
 *   - the picker's list comes from the SERVER (roles that can send to the
 *     kitchen, on this branch), so the request is asserted, not just the
 *     rendering: a client-side guess would eventually offer somebody the API
 *     refuses;
 *   - the waiter already on the table is offered as context and NOT as a
 *     choice, which is the one option that would look like it worked and
 *     change nothing.
 *
 * Mutation-proven, each run against the component itself:
 *   1. the `canReassignWaiter` gate dropped (button always rendered) — 1
 *      failed, 3 passed;
 *   2. the current waiter left enabled in the picker — 1 failed, 3 passed;
 *   3. `reassignWaiter` called with the session's TABLE id instead of the
 *      session id — 1 failed, 3 passed.
 *
 * D153a mutations (long-list handling), same method:
 *   4. the second group filtered on `openTableCount === 0` instead of the
 *      complement of the first — 1 failed, 6 passed: a row with no count
 *      vanishes from the picker (this was a real defect, caught here);
 *   5. the search box rendered unconditionally — 1 failed, 6 passed;
 *   6. the search filter ignored (every row rendered regardless of the query)
 *      — 1 failed, 6 passed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  OpenSessionView,
  OpenTableView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

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

const ME = 'usr_owner';
/** Flipped per test: the whole point is that the control is permission-gated. */
let canReassign = true;

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { id: ME } },
    hasPermission: (p: string) =>
      p === 'table-session:reassign' ? canReassign : true,
  }),
}));

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listOpenTables = vi.fn<() => Promise<OpenTableView[]>>();
const listOpen = vi.fn<() => Promise<OpenSessionView[]>>();
const listAssignableWaiters = vi.fn<
  () => Promise<{ id: string; name: string; openTableCount?: number }[]>
>();
const reassignWaiter = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => listAreas(), create: vi.fn(), update: vi.fn(), archive: vi.fn() },
  restaurantTables: {
    list: (_s: unknown, areaId: string) => listTables(areaId),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  openTables: { list: () => listOpenTables(), create: vi.fn(), dissolve: vi.fn() },
  tableSessions: {
    listOpen: () => listOpen(),
    open: vi.fn(),
    listAssignableWaiters: () => listAssignableWaiters(),
    reassignWaiter: (...args: unknown[]) => reassignWaiter(...args),
  },
}));

const { TableFloor } = await import('./table-floor');

const AREA = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main Floor',
  position: 0,
  isActive: true,
  createdByUserId: ME,
} as DiningAreaView;

const TABLE = {
  id: 'tbl_1',
  areaId: 'area_1',
  branchId: 'brn_1',
  kind: 'PHYSICAL',
  code: 'T1',
  label: 'Table one',
  capacity: 4,
  status: 'OCCUPIED',
  isActive: true,
  createdByUserId: ME,
} as RestaurantTableView;

const SESSION_ON_IT = {
  id: 'ses_1',
  branchId: 'brn_1',
  tableId: 'tbl_1',
  sessionNumber: 'TS-000001',
  status: 'OPEN',
  waiterUserId: 'usr_nimal',
  waiterName: 'Nimal Perera',
  guestCount: 2,
  openedAt: new Date().toISOString(),
  closedAt: null,
  finalSaleId: null,
  version: 1,
  activeOrderId: 'ord_1',
  tabName: null,
  readyTicketIds: [],
} as OpenSessionView;

const session = { token: 't', user: { id: ME, tenantId: 'tnt_1' } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  canReassign = true;
  listAreas.mockResolvedValue([AREA]);
  listTables.mockResolvedValue([TABLE]);
  listOpenTables.mockResolvedValue([]);
  listOpen.mockResolvedValue([SESSION_ON_IT]);
  listAssignableWaiters.mockResolvedValue([
    // D153a — the payload carries each waiter's current load.
    { id: 'usr_nimal', name: 'Nimal Perera', openTableCount: 2 },
    { id: 'usr_sunil', name: 'Sunil Fernando', openTableCount: 3 },
    { id: 'usr_kamala', name: 'Kamala Jayasuriya', openTableCount: 0 },
  ]);
  reassignWaiter.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('changing the waiter on a table (D153)', () => {
  it('offers Change beside the name, and hands the session to the picked waiter', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // The name is there (D151a) and, for a holder of the permission, so is the
    // way to change it.
    await waitFor(() => expect(screen.getByText('Nimal Perera')).toBeTruthy());
    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving Table one/ }));

    // The list is the SERVER's answer, not a client-side guess.
    await waitFor(() => expect(listAssignableWaiters).toHaveBeenCalledTimes(1));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Change waiter — Table one/);

    /*
     * The waiter already on the table is shown ONCE, as context, and is not a
     * choice at all (D153a made it a plain row rather than a disabled button —
     * "changing" to the same person is the one action that would look like it
     * worked and do nothing). Asserted as the pair: the name is present, and
     * not as something pressable.
     */
    expect(screen.getByText('On this table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nimal Perera/ })).toBeNull();

    // Pick the colleague and confirm.
    fireEvent.click(screen.getByRole('button', { name: /Sunil Fernando/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change waiter' }));

    // Addressed by SESSION id — the thing that carries the waiter — not by the
    // table, which outlives every party that sits at it.
    await waitFor(() =>
      expect(reassignWaiter).toHaveBeenCalledWith(session, 'brn_1', 'ses_1', 'usr_sunil'),
    );
    // The floor re-reads afterwards, so the card names the new waiter without a
    // manual refresh.
    await waitFor(() => expect(listOpen.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('D153a — groups by who is actually serving, and shows each load', async () => {
    /*
     * With fifteen waiters the question is not "who exists" but "who is here
     * and has room". There is no clock-in in this schema, so "here" reads as
     * "holding an open session on this branch" — the same fact the floor behind
     * the dialog is showing — and the count is what decides a handover.
     */
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving/ }));
    await waitFor(() => expect(listAssignableWaiters).toHaveBeenCalled());

    // Sunil is carrying three tables and is grouped as serving…
    const serving = screen.getByRole('group', { name: 'Serving now' });
    expect(serving.textContent).toMatch(/Sunil Fernando/);
    expect(serving.textContent).toMatch(/3 tables/);
    // …Kamala has none, so she is the obvious person to hand a table to.
    const free = screen.getByRole('group', { name: 'No tables right now' });
    expect(free.textContent).toMatch(/Kamala Jayasuriya/);
    // NEGATIVE — and Kamala carries no count, because "0 tables" is the group
    // she is in rather than a number to read.
    expect(free.textContent).not.toMatch(/0 table/);
    // The waiter on the table is in NEITHER group: they are not a candidate.
    expect(serving.textContent).not.toMatch(/Nimal Perera/);
    expect(free.textContent).not.toMatch(/Nimal Perera/);
  });

  it('D153a — a countless row is still offered rather than dropped', async () => {
    /*
     * `openTableCount` is guaranteed by the current server; a row that arrives
     * without one (an older API, a trimmed payload) must still be pickable. The
     * bug this pins is real and was mine: grouping on `=== 0` beside
     * `> 0` left such a row in neither group and it disappeared from the list.
     */
    listAssignableWaiters.mockResolvedValue([{ id: 'usr_sunil', name: 'Sunil Fernando' }]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving/ }));

    expect(await screen.findByRole('button', { name: /Sunil Fernando/ })).toBeTruthy();
  });

  it('D153a — searches once the list is long, and not before', async () => {
    // Three staff: a search box would cost a tap and save none.
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving/ }));
    await waitFor(() => expect(listAssignableWaiters).toHaveBeenCalled());
    expect(screen.queryByLabelText('Search staff by name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Twelve: now it earns its place, and it filters.
    listAssignableWaiters.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        id: `usr_${i}`,
        name: i === 4 ? 'Chaminda Silva' : `Waiter ${i}`,
        openTableCount: 0,
      })),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving/ }));
    const search = await screen.findByLabelText('Search staff by name');

    fireEvent.change(search, { target: { value: 'chami' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Chaminda Silva/ })).toBeTruthy(),
    );
    // NEGATIVE — the other eleven are gone, which is the whole point.
    expect(screen.queryByRole('button', { name: /Waiter 7/ })).toBeNull();

    // A search that matches nobody says so, instead of showing an empty panel
    // that reads as "this branch has no staff".
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByText(/Nobody matches/)).toBeTruthy();
  });

  it('NEGATIVE — a role without the permission sees the name and no way to change it', async () => {
    canReassign = false;
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // Same card, same name — so the absence below is the gate, not an empty
    // card or a missing session.
    await waitFor(() => expect(screen.getByText('Nimal Perera')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Change the waiter serving/ })).toBeNull();
  });

  it('says so when the branch has nobody else who can serve', async () => {
    listAssignableWaiters.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving/ }));

    expect(await screen.findByText(/No other staff on this branch can be given a table/)).toBeTruthy();
    // NEGATIVE — and Change waiter cannot be pressed into a no-op.
    expect(screen.getByRole('button', { name: 'Change waiter' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('keeps the dialog open and says why when the server refuses', async () => {
    reassignWaiter.mockRejectedValue(new Error('That user cannot be assigned a table'));
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    fireEvent.click(await screen.findByRole('button', { name: /Change the waiter serving/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Sunil Fernando/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change waiter' }));

    // The reason on screen, the dialog still up: a supervisor mid-service needs
    // to pick again, not to start over.
    expect(await screen.findByText(/cannot be assigned a table/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
