/**
 * The calendar's dining-area filter.
 *
 * ## What makes each assertion non-vacuous
 *
 * "Filtering works" is easy to fake: a chart that rendered nothing would
 * satisfy every "the other area is absent" check. So the two directions are
 * always asserted together — after selecting Terrace, Terrace's tables must
 * still be on screen and Main Hall's must be gone. A component that dropped
 * everything fails the first half; one that ignored the filter fails the
 * second.
 *
 * "All" is likewise asserted to restore the full chart rather than merely to
 * exist as a chip, because a default that cannot be returned to is a trap.
 *
 * Mutation-proven: charting `state.snapshot.areas` instead of `visibleAreas`
 * — i.e. rendering the chips but ignoring them — fails the two narrowing
 * tests while the default-state and single-area tests stay green.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  ReservationView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listReservations = vi.fn<() => Promise<ReservationView[]>>();

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => listAreas() },
  restaurantTables: { list: (_s: unknown, areaId: string) => listTables(areaId) },
  reservations: {
    list: () => listReservations(),
    create: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('@/lib/customers-api', () => ({ fetchCustomers: async () => [] }));

const { ReservationCalendar } = await import('./reservation-calendar');

function area(id: string, name: string, position: number): DiningAreaView {
  return {
    id,
    branchId: 'brn_1',
    name,
    description: null,
    position,
    isActive: true,
    createdByUserId: 'usr_1',
  };
}

function table(id: string, areaId: string, code: string): RestaurantTableView {
  return {
    id,
    areaId,
    branchId: 'brn_1',
    kind: 'PHYSICAL',
    code,
    label: null,
    capacity: 4,
    positionX: null,
    positionY: null,
    status: 'AVAILABLE',
    isActive: true,
    createdByUserId: 'usr_1',
  };
}

const TERRACE = area('area_terrace', 'Terrace', 0);
const MAIN_HALL = area('area_hall', 'Main Hall', 1);

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function renderCalendar() {
  return render(
    <ReservationCalendar session={session} branchId="brn_1" canCreate canManage />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listAreas.mockResolvedValue([TERRACE, MAIN_HALL]);
  listTables.mockImplementation(async (areaId: string) =>
    areaId === TERRACE.id
      ? [table('tbl_t1', TERRACE.id, 'T1')]
      : [table('tbl_h1', MAIN_HALL.id, 'H1')],
  );
  listReservations.mockResolvedValue([]);
});

afterEach(cleanup);

describe('ReservationCalendar — area filter', () => {
  it('defaults to All areas and charts every area', async () => {
    renderCalendar();
    await settle();
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    expect(screen.getByText('H1')).toBeTruthy();
    // "All areas" is the selected chip, not merely a present one.
    const all = screen.getByRole('button', { name: 'All areas' });
    expect(all.getAttribute('data-active')).toBe('true');
  });

  it('narrows the chart to one area, and keeps that area on screen', async () => {
    renderCalendar();
    await settle();
    await waitFor(() => expect(screen.getByText('H1')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: 'Terrace' }).click();
    });

    // Both halves. Either alone would pass for a broken component.
    expect(screen.getByText('T1')).toBeTruthy();
    expect(screen.queryByText('H1')).toBeNull();
  });

  it('returns to the full chart when All areas is chosen again', async () => {
    renderCalendar();
    await settle();
    await waitFor(() => expect(screen.getByText('H1')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: 'Terrace' }).click();
    });
    expect(screen.queryByText('H1')).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'All areas' }).click();
    });
    expect(screen.getByText('T1')).toBeTruthy();
    expect(screen.getByText('H1')).toBeTruthy();
  });

  it('offers a way back when the chosen area has no tables', async () => {
    listTables.mockImplementation(async (areaId: string) =>
      areaId === TERRACE.id ? [] : [table('tbl_h1', MAIN_HALL.id, 'H1')],
    );
    renderCalendar();
    await settle();
    await waitFor(() => expect(screen.getByText('H1')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: 'Terrace' }).click();
    });

    // Distinct from the "no tables at all" message, which would be wrong here:
    // the branch has tables, this area does not.
    expect(screen.getByText('No tables in this area.')).toBeTruthy();
    expect(screen.queryByText(/No tables yet/)).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'Show all areas' }).click();
    });
    expect(screen.getByText('H1')).toBeTruthy();
  });

  it('hides the filter entirely for a branch with a single area', async () => {
    listAreas.mockResolvedValue([TERRACE]);
    renderCalendar();
    await settle();
    await waitFor(() => expect(screen.getByText('T1')).toBeTruthy());

    // Nothing to choose between, so the strip is clutter. The chart still
    // renders — proving the filter was hidden, not the whole toolbar.
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Terrace' })).toBeNull();
  });
});
