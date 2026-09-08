/**
 * Overlapping blocks share the row as lanes.
 *
 * The reported defect: book 17:30, cancel it, book 17:30 again — with
 * cancelled rows shown, the two blocks drew at identical pixels, one
 * painting over the other. Both directions are pinned: the overlapping pair
 * must render at DIFFERENT tops with split heights, AND a lone booking must
 * keep the full-height geometry — a layout that halved every block would
 * pass the first half alone.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  OpeningHoursView,
  ReservationView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<() => Promise<RestaurantTableView[]>>();
const listReservations = vi.fn<() => Promise<ReservationView[]>>();

vi.mock('@/lib/restaurant/api', () => ({
  openingHours: {
    get: async (): Promise<OpeningHoursView> => ({
      branchId: 'brn_1',
      weekly: [],
      overrides: [],
      defaults: { opensAt: 8 * 60, closesAt: 23 * 60 },
    }),
  },
  diningAreas: { list: () => listAreas() },
  restaurantTables: { list: () => listTables() },
  reservations: {
    list: () => listReservations(),
    create: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
  },
}));

vi.mock('@/lib/customers-api', () => ({
  fetchCustomers: async () => ({ items: [], total: 0, page: 1, pageSize: 6 }),
  createCustomer: vi.fn(),
}));

const { ReservationCalendar } = await import('./reservation-calendar');

const AREA: DiningAreaView = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main',
  description: null,
  position: 0,
  isActive: true,
  createdByUserId: 'usr_1',
} as DiningAreaView;

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
} as RestaurantTableView;

function reservation(
  id: string,
  number: string,
  status: ReservationView['status'],
  startHour: number,
  startMinute = 0,
  durationMinutes = 90,
): ReservationView {
  const start = new Date();
  start.setHours(startHour, startMinute, 0, 0);
  return {
    id,
    branchId: 'brn_1',
    tableId: TABLE.id,
    reservationNumber: number,
    customerId: null,
    customerName: `Guest ${number}`,
    customerPhone: null,
    partySize: 2,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + durationMinutes * 60_000).toISOString(),
    status,
    notes: null,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
  } as ReservationView;
}

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listAreas.mockResolvedValue([AREA]);
  listTables.mockResolvedValue([TABLE]);
});

afterEach(() => {
  cleanup();
});

describe('overlapping reservation blocks', () => {
  it('draws a cancelled slot and its rebooking side by side, live one on top', async () => {
    listReservations.mockResolvedValue([
      reservation('rsv_dead', 'RSV-000001', 'CANCELLED', 17, 30),
      reservation('rsv_live', 'RSV-000002', 'BOOKED', 17, 30),
    ]);
    render(<ReservationCalendar session={session} branchId="brn_1" canCreate canManage />);
    await settle();

    const dead = screen.getByTitle(/RSV-000001/) as HTMLElement;
    const live = screen.getByTitle(/RSV-000002/) as HTMLElement;
    // Split row: 36 usable px minus the 2px gap, halved.
    expect(live.style.height).toBe('17px');
    expect(dead.style.height).toBe('17px');
    // The reservation that still holds the slot takes the top lane.
    expect(live.style.top).toBe('6px');
    expect(dead.style.top).toBe('25px');
  });

  it('keeps a lone booking at full height', async () => {
    listReservations.mockResolvedValue([reservation('rsv_solo', 'RSV-000003', 'BOOKED', 19)]);
    render(<ReservationCalendar session={session} branchId="brn_1" canCreate canManage />);
    await settle();

    const solo = screen.getByTitle(/RSV-000003/) as HTMLElement;
    expect(solo.style.height).toBe('36px');
    expect(solo.style.top).toBe('6px');
  });
});
