/**
 * D199 — "No-show" is a verb for a time that has passed.
 *
 * The PO's report: a BOOKED reservation offered No-show from the moment it
 * was made, so an 8 pm party could be recorded as a no-show at 3 pm. The
 * manage dialog now offers Cancel at any time and No-show only once the booked
 * start plus the fifteen-minute grace has passed — with a line saying when.
 *
 * ## Why these claims
 *
 *   - both verbs are asserted on the SAME future booking, because "No-show is
 *     absent" alone is also what an empty action row produces — Cancel being
 *     present proves the row rendered and the gate chose;
 *   - the line names the exact minute (start + 15), so a gate keyed on the
 *     wrong instant (the start itself, or the end) cannot pass;
 *   - a booking past the grace is asserted to offer BOTH, so the rule is a
 *     gate and not a removal.
 *
 * The clock is pinned to 12:00 local so a booking "two hours ahead" always
 * lands inside the chart's opening hours whatever time the suite runs.
 *
 * Mutation-proven, each against the component itself:
 *   1. `noShowReady` forced true — the two "not yet" cases fail, 1 passes;
 *   2. the grace dropped from the client rule (`now >= startAt`) — "inside the
 *      grace" fails alone: a booking 10 minutes ago would offer No-show.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  OpeningHoursView,
  ReservationView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

const listReservations = vi.fn<() => Promise<ReservationView[]>>();
const setStatus = vi.fn();

vi.mock('@/lib/restaurant/api', () => ({
  openingHours: {
    get: async () =>
      ({
        branchId: 'brn_1',
        weekly: [],
        overrides: [],
        defaults: { opensAt: 8 * 60, closesAt: 23 * 60 },
      }) as OpeningHoursView,
  },
  diningAreas: { list: async () => [AREA] },
  restaurantTables: { list: async () => [TABLE] },
  reservations: {
    list: () => listReservations(),
    create: vi.fn(),
    update: vi.fn(),
    setStatus: (...args: unknown[]) => setStatus(...args),
    cancel: vi.fn(),
  },
}));
vi.mock('@/lib/customers-api', () => ({ fetchCustomers: async () => [] }));

const { ReservationCalendar } = await import('./reservation-calendar');

const AREA: DiningAreaView = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main Hall',
  description: null,
  position: 0,
  isActive: true,
  createdByUserId: 'usr_1',
};
const TABLE: RestaurantTableView = {
  id: 'tbl_1',
  areaId: 'area_1',
  branchId: 'brn_1',
  kind: 'PHYSICAL',
  code: 'T1',
  label: null,
  capacity: 4,
  positionX: null,
  positionY: null,
  status: 'AVAILABLE',
  isActive: true,
  createdByUserId: 'usr_1',
};

/** Noon today, local — every booking below is placed relative to it. */
const NOON = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
})();

function bookedAt(minutesFromNoon: number): ReservationView {
  const start = new Date(NOON.getTime() + minutesFromNoon * 60_000);
  return {
    id: 'rsv_1',
    branchId: 'brn_1',
    tableId: TABLE.id,
    reservationNumber: 'RSV-000007',
    customerId: null,
    customerName: 'Nimal Perera',
    customerPhone: null,
    partySize: 2,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 90 * 60_000).toISOString(),
    status: 'BOOKED',
    notes: null,
    createdByUserId: null,
    createdAt: NOON.toISOString(),
  } as ReservationView;
}

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Renders the calendar and opens the one reservation's manage dialog. */
async function openDialog(reservation: ReservationView) {
  listReservations.mockResolvedValue([reservation]);
  render(<ReservationCalendar session={session} branchId="brn_1" canCreate canManage />);
  await settle();
  fireEvent.click(screen.getByTitle(/RSV-000007/));
  return within(await screen.findByRole('dialog'));
}

const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

beforeEach(() => {
  // Date only: timers stay real so the calendar's own async loads settle.
  vi.useFakeTimers({ toFake: ['Date'], now: NOON });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('marking a reservation no-show (D199)', () => {
  it('offers Cancel but not No-show for a booking still ahead, and says when No-show arrives', async () => {
    const dialog = await openDialog(bookedAt(120)); // 14:00

    // POSITIVE — the action row rendered, and chose.
    expect(dialog.getByRole('button', { name: 'Cancel reservation' })).toBeTruthy();
    expect(dialog.getByText(/No-show can be recorded from 14:15/)).toBeTruthy();
    // NEGATIVE — the verb for a time that has not come is not on offer.
    expect(dialog.queryByRole('button', { name: 'No-show' })).toBeNull();
  });

  it('still withholds No-show inside the grace — ten minutes late is late, not absent', async () => {
    const dialog = await openDialog(bookedAt(-10)); // 11:50, now 12:00

    expect(dialog.getByRole('button', { name: 'Cancel reservation' })).toBeTruthy();
    expect(dialog.queryByRole('button', { name: 'No-show' })).toBeNull();
    // Start + 15, not start: the line pins the instant the rule is keyed on.
    expect(
      dialog.getByText(new RegExp(`No-show can be recorded from ${hhmm(new Date(NOON.getTime() - 10 * 60_000 + 15 * 60_000))}`)),
    ).toBeTruthy();
  });

  it('offers both verbs once the grace has run, and No-show sends the transition', async () => {
    setStatus.mockResolvedValue({});
    const dialog = await openDialog(bookedAt(-20)); // 11:40, now 12:00

    expect(dialog.getByRole('button', { name: 'Cancel reservation' })).toBeTruthy();
    const noShow = dialog.getByRole('button', { name: 'No-show' });
    expect(dialog.queryByText(/No-show can be recorded from/)).toBeNull();

    fireEvent.click(noShow);
    await settle();
    expect(setStatus).toHaveBeenCalledWith(session, 'rsv_1', 'NO_SHOW');
  });
});
