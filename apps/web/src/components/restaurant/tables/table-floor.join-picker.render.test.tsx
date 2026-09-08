/**
 * D105 — the New open table picker offers only tables that are actually free.
 *
 * ## Why this test exists
 *
 * The picker had no test at all, and it shipped a rule that was wrong in a way
 * nothing could see: D50 offered `RESERVED` tables so two unrelated pairs could
 * each hold their own arrangement over one free four-top. That rested on an
 * arrangement meaning exactly ONE tab. D104 ended that — a member stays
 * RESERVED while its arrangement fills with guests — so the picker was listing
 * tables with people physically sitting at them, and the operator's report was
 * exactly that: "I joined M2 and M3, and they still show in the popup."
 *
 * ## Why it is paired
 *
 * "The RESERVED table is absent" is satisfied just as well by a dialog that
 * renders nothing at all, or one that failed to load — which is the commonest
 * way a filter test rots. So the AVAILABLE table is asserted PRESENT in the
 * same render, and the area heading with it.
 *
 * ## Mutation proof (D30 §5)
 *
 * Restoring `t.status === 'RESERVED' ||` to the `joinable` filter in
 * `table-floor.tsx` FAILS 2 of the 3 tests here — "lists only the free
 * tables" and "says so when every table is already joined". Measured, not
 * predicted. The third (submit) survives on purpose: it is the positive
 * control, and a mutation to the FILTER should not be able to break it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  OpenTableView,
  RestaurantTableView,
  TableSessionView,
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

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { id: 'usr_1' } },
    hasPermission: () => true,
  }),
}));

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listOpenTables = vi.fn<() => Promise<OpenTableView[]>>();
const createOpenTable = vi.fn();

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => listAreas(), create: vi.fn(), update: vi.fn(), archive: vi.fn() },
  restaurantTables: {
    list: (_s: unknown, areaId: string) => listTables(areaId),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  openTables: {
    list: () => listOpenTables(),
    create: (...a: unknown[]) => createOpenTable(...a),
    dissolve: vi.fn(),
    releaseMember: vi.fn(),
  },
  tableSessions: { listOpen: async () => [] as TableSessionView[], open: vi.fn() },
}));

const { TableFloor } = await import('./table-floor');

const AREA: DiningAreaView = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main Hall',
  description: null,
  position: 0,
  isActive: true,
  createdByUserId: 'usr_1',
};

const table = (
  id: string,
  code: string,
  status: RestaurantTableView['status'],
): RestaurantTableView => ({
  id,
  areaId: 'area_1',
  branchId: 'brn_1',
  kind: 'PHYSICAL',
  code,
  label: null,
  capacity: 4,
  positionX: null,
  positionY: null,
  status,
  isActive: true,
  createdByUserId: 'usr_1',
});

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Open the picker and hand back the dialog, so queries cannot stray onto the floor. */
async function openPicker() {
  render(<TableFloor session={session} branchId="brn_1" canManage />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /New open table/ }));
  return await screen.findByRole('dialog');
}

/** An arrangement holding M2 and M3, so a member card has a holder to name. */
const ARRANGEMENT = {
  id: 'open_1',
  areaId: null,
  branchId: 'brn_1',
  kind: 'OPEN',
  code: 'OPEN-1',
  label: 'minin',
  capacity: 6,
  positionX: null,
  positionY: null,
  status: 'OCCUPIED',
  isActive: true,
  createdByUserId: 'usr_1',
  liveTabs: 3,
  seatsTaken: 6,
  members: [
    { id: 'tbl_m2', code: 'M2', label: null, areaId: 'area_1', status: 'RESERVED' },
    { id: 'tbl_m3', code: 'M3', label: null, areaId: 'area_1', status: 'RESERVED' },
  ],
} as OpenTableView;

beforeEach(() => {
  vi.clearAllMocks();
  listAreas.mockResolvedValue([AREA]);
  listOpenTables.mockResolvedValue([]);
  // M6 is free; M2 and M3 are already inside an arrangement.
  listTables.mockResolvedValue([
    table('tbl_m2', 'M2', 'RESERVED'),
    table('tbl_m3', 'M3', 'RESERVED'),
    table('tbl_m6', 'M6', 'AVAILABLE'),
  ]);
});

afterEach(cleanup);

describe('D105 — New open table picker', () => {
  it('lists only the free tables — a table already joined is not offered', async () => {
    const dialog = await openPicker();

    // POSITIVE — the free table is offered, under its area, and is tickable.
    const m6 = within(dialog).getByRole('checkbox', { name: /M6/ });
    expect(m6).toBeTruthy();
    expect(within(dialog).getByText('Main Hall')).toBeTruthy();

    // NEGATIVE — the two tables inside an arrangement are gone. Paired with the
    // line above, so a dialog that rendered nothing fails the first half.
    expect(within(dialog).queryByRole('checkbox', { name: /M2/ })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: /M3/ })).toBeNull();

    // …and the "shared" hint D50 used to print on them is gone with the rule.
    expect(within(dialog).queryByText('shared')).toBeNull();
  });

  it('says so when every table is already joined, instead of showing an empty list', async () => {
    listTables.mockResolvedValue([
      table('tbl_m2', 'M2', 'RESERVED'),
      table('tbl_m3', 'M3', 'RESERVED'),
    ]);
    const dialog = await openPicker();

    await waitFor(() =>
      expect(within(dialog).getByText(/No available tables to reserve right now/)).toBeTruthy(),
    );
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('creates the arrangement from the tables actually ticked', async () => {
    /*
     * The positive control for the whole dialog: without it, every assertion
     * above would still pass against a picker that could list tables but never
     * submit them.
     */
    createOpenTable.mockResolvedValue({ id: 'open_9' });
    const dialog = await openPicker();

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Birthday party' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /M6/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create open table' }));

    await waitFor(() => expect(createOpenTable).toHaveBeenCalledTimes(1));
    expect(createOpenTable.mock.calls[0]![2]).toMatchObject({
      name: 'Birthday party',
      memberTableIds: ['tbl_m6'],
    });
  });
});

/**
 * D106 — a joined table is shown, not offered.
 *
 * The card for a member table used to carry an "Unreserve" button. Pressing it
 * pulled the table out of an arrangement that was serving guests — the server
 * guard read the MEMBER's own sessions, and a joined member never has one, so
 * it could not fire. On the operator's own floor it left an arrangement running
 * three tabs with no tables under it.
 *
 * The card still has to EARN its place, which is why this is paired: the badge
 * and the "Held by" line say where the table went. "No button" on its own is
 * satisfied by a card that failed to render at all, which is the failure this
 * would otherwise hide.
 *
 * ## Mutation proof (D30 §5)
 *
 * Restoring an Unreserve button to the held branch of `TableCard` FAILS 1 of
 * the 2 tests here — "offers nothing to press". Measured, not predicted. The
 * other asserts the card's CONTENT, which that mutation does not touch, and
 * keeping them apart is what makes the failure point at the right line.
 */
describe('D106 — a held table on the floor', () => {
  async function floor() {
    listOpenTables.mockResolvedValue([ARRANGEMENT]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    return await screen.findByText('M2');
  }

  it('says where the table went — Reserved, and the arrangement holding it', async () => {
    const m2 = await floor();
    const card = m2.closest('.rounded-xl') as HTMLElement;
    expect(card).toBeTruthy();

    // POSITIVE — both halves of the answer are on the card.
    expect(within(card).getByText('Reserved')).toBeTruthy();
    expect(within(card).getByText(/Held by minin/)).toBeTruthy();
  });

  it('offers nothing to press', async () => {
    const m2 = await floor();
    const card = m2.closest('.rounded-xl') as HTMLElement;

    /*
     * NEGATIVE, as an exact SET rather than a count or a lone absence: the only
     * control left on a held card is the owner's Manage menu, which is floor
     * administration and nothing to do with the arrangement. Unreserve is gone,
     * and "Open table" was never offered either — a member cannot be seated on
     * its own (D49).
     */
    expect(
      within(card)
        .queryAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()),
    ).toEqual(['Manage M2']);

    // …while a free table on the same floor still offers its action, so this
    // is proving the HELD case rather than a floor that renders no buttons.
    const m6 = screen.getByText('M6').closest('.rounded-xl') as HTMLElement;
    expect(within(m6).getByRole('button', { name: /Open table/ })).toBeTruthy();
  });
});
