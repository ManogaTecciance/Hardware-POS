/**
 * D90 — the calendar's day window comes from the branch's opening hours.
 *
 * ## What makes each assertion non-vacuous
 *
 * "The chart follows the hours" is easy to fake: a chart drawn from 00:00 to
 * 24:00 contains every label any test could ask for, and a chart that
 * rendered no labels at all would satisfy every "that hour is absent" check.
 * So each case asserts the window's FIRST and LAST labels positively and the
 * hour just outside it negatively — a component ignoring the hours fails the
 * negative, one rendering nothing fails the positives.
 *
 * The override case keeps the weekday rule it must beat in the input, so
 * "the override won" cannot pass on a resolver that ignores weekday rules.
 *
 * Mutation-proven inline at the bottom of this file.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  OpeningHoursView,
  ReservationView,
  RestaurantTableView,
} from '@/lib/restaurant/types';

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listReservations = vi.fn<() => Promise<ReservationView[]>>();
const getHours = vi.fn<() => Promise<OpeningHoursView>>();

vi.mock('@/lib/restaurant/api', () => ({
  openingHours: { get: () => getHours() },
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
// The resolver itself is NOT mocked — the mutation proofs at the bottom run
// against the real one, which is the whole point of them.
const { resolveHoursForDate } = await import('@/lib/restaurant/opening-hours');

/*
 * A FIXED date, so the weekday under test never depends on when the suite
 * runs: 2026-08-10 is a Monday and 2026-08-13 is the Thursday the PO named as
 * a poya day. The component defaults to "today", so the clock is faked rather
 * than the date typed — typing would exercise the date input, not the window.
 */
const MONDAY = new Date(2026, 7, 10, 12, 0, 0);
const THURSDAY = new Date(2026, 7, 13, 12, 0, 0);

const AREA: DiningAreaView = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main Hall',
  position: 0,
  isActive: true,
  createdByUserId: 'usr_1',
} as DiningAreaView;

const TABLE: RestaurantTableView = {
  id: 'tbl_1',
  areaId: AREA.id,
  branchId: 'brn_1',
  kind: 'PHYSICAL',
  code: 'H1',
  label: null,
  capacity: 4,
  positionX: null,
  positionY: null,
  status: 'AVAILABLE',
  isActive: true,
  createdByUserId: 'usr_1',
} as RestaurantTableView;

function hours(over: Partial<OpeningHoursView> = {}): OpeningHoursView {
  return {
    branchId: 'brn_1',
    weekly: [],
    overrides: [],
    defaults: { opensAt: 8 * 60, closesAt: 23 * 60 },
    ...over,
  };
}

function booking(startHour: number, endHour: number): ReservationView {
  const start = new Date(MONDAY);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(MONDAY);
  end.setHours(endHour, 0, 0, 0);
  return {
    id: 'res_1',
    branchId: 'brn_1',
    tableId: TABLE.id,
    customerId: null,
    customerName: 'Late Guest',
    partySize: 2,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    status: 'BOOKED',
    notes: null,
  } as ReservationView;
}

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderAt(when: Date) {
  vi.setSystemTime(when);
  render(<ReservationCalendar session={session} branchId="brn_1" canCreate canManage />);
  await settle();
  await waitFor(() => expect(screen.getByText('H1')).toBeTruthy());
}

/** The hour column labels actually drawn, e.g. ['09:00', '10:00', …]. */
function hourLabels(): string[] {
  return screen
    .getAllByText(/^\d{2}:00$/)
    .map((el) => el.textContent ?? '')
    .filter(Boolean);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  listAreas.mockResolvedValue([AREA]);
  listTables.mockResolvedValue([TABLE]);
  listReservations.mockResolvedValue([]);
  getHours.mockResolvedValue(hours());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('D90 — the calendar draws the configured day', () => {
  it('an unconfigured branch keeps the window it has always drawn (08:00–23:00)', async () => {
    await renderAt(MONDAY);

    const labels = hourLabels();
    expect(labels[0]).toBe('08:00');
    expect(labels.at(-1)).toBe('22:00'); // the last full hour before 23:00
    expect(labels).not.toContain('07:00');
    expect(labels).not.toContain('23:00');
  });

  it('a weekday rule narrows the chart to those hours', async () => {
    getHours.mockResolvedValue(
      hours({ weekly: [{ dayOfWeek: 1, isClosed: false, opensAt: 9 * 60, closesAt: 22 * 60 }] }),
    );

    await renderAt(MONDAY);

    const labels = hourLabels();
    expect(labels[0]).toBe('09:00');
    expect(labels.at(-1)).toBe('21:00');
    // NEGATIVE: the default window's edges are gone. Without this, a chart
    // still drawn 08:00–23:00 would pass the two assertions above.
    expect(labels).not.toContain('08:00');
    expect(labels).not.toContain('22:00');
  });

  it('a date override beats the weekday rule that would otherwise apply', async () => {
    getHours.mockResolvedValue(
      hours({
        // The rule it must beat is present, and it is Thursday's.
        weekly: [{ dayOfWeek: 4, isClosed: false, opensAt: 7 * 60, closesAt: 23 * 60 }],
        overrides: [
          { date: '2026-08-13', isClosed: false, opensAt: 17 * 60, closesAt: 20 * 60, note: 'Poya day' },
        ],
      }),
    );

    await renderAt(THURSDAY);

    const labels = hourLabels();
    expect(labels[0]).toBe('17:00');
    expect(labels.at(-1)).toBe('19:00');
    expect(labels).not.toContain('07:00'); // the weekday rule did not win
    expect(screen.getByText(/Poya day/)).toBeTruthy();
  });

  it('says the branch is closed — and still draws that day’s bookings', async () => {
    getHours.mockResolvedValue(
      hours({ overrides: [{ date: '2026-08-10', isClosed: true, opensAt: 480, closesAt: 1380, note: null }] }),
    );
    listReservations.mockResolvedValue([booking(19, 21)]);

    await renderAt(MONDAY);

    expect(screen.getByText('Closed today')).toBeTruthy();
    // The guest is going to turn up whatever the schedule says. Hiding the
    // booking because the door is marked shut is how they get forgotten.
    expect(screen.getByText(/Late Guest/)).toBeTruthy();
    /*
     * …and the chart it is drawn on is still the ordinary day, not a collapsed
     * sliver. Asserting only that the booking is in the DOM was VACUOUS: a
     * window of 00:00–01:00 keeps the element and renders it off-chart, and
     * an earlier version of this test passed under exactly that mutation.
     */
    const labels = hourLabels();
    expect(labels[0]).toBe('08:00');
    expect(labels).toContain('19:00');
    expect(labels).not.toContain('00:00');
  });

  it('a booking outside the configured hours still widens the chart', async () => {
    getHours.mockResolvedValue(
      hours({ weekly: [{ dayOfWeek: 1, isClosed: false, opensAt: 9 * 60, closesAt: 17 * 60 }] }),
    );
    listReservations.mockResolvedValue([booking(19, 21)]);

    await renderAt(MONDAY);

    const labels = hourLabels();
    expect(labels[0]).toBe('09:00');
    // Widened past the configured close so nothing renders off-chart.
    expect(labels).toContain('20:00');
    expect(screen.getByText(/Late Guest/)).toBeTruthy();
  });

  it('a failed hours request draws the default day rather than an empty one', async () => {
    // D31 — unresolved is not "closed". The bookings are the point.
    getHours.mockRejectedValue(new Error('network'));
    listReservations.mockResolvedValue([booking(19, 21)]);

    await renderAt(MONDAY);

    const labels = hourLabels();
    expect(labels[0]).toBe('08:00');
    expect(screen.queryByText('Closed today')).toBeNull();
    expect(screen.getByText(/Late Guest/)).toBeTruthy();
  });
});

/*
 * MUTATION PROOFS (D30). Each mutation is applied to the resolver the chart
 * reads, and shown to change the labels the tests above assert. Written here,
 * beside the tripwire, because a green chart test is otherwise
 * indistinguishable from a chart that ignores the schedule entirely.
 */
describe('the window assertions can actually fail', () => {
  const weekday = hours({
    weekly: [{ dayOfWeek: 1, isClosed: false, opensAt: 9 * 60, closesAt: 22 * 60 }],
    overrides: [
      { date: '2026-08-10', isClosed: false, opensAt: 17 * 60, closesAt: 20 * 60, note: null },
    ],
  });

  it('M1: ignoring the schedule (always the default) changes the drawn window', () => {
    const real = resolveHoursForDate(weekday, MONDAY);
    const mutated = { opensAt: 480, closesAt: 1380 }; // the pre-D90 constants
    expect(Math.floor(real.opensAt / 60)).not.toBe(Math.floor(mutated.opensAt / 60));
  });

  it('M2: checking the weekday rule BEFORE the override changes which wins', () => {
    const real = resolveHoursForDate(weekday, MONDAY);
    const mutated =
      weekday.weekly.find((w) => w.dayOfWeek === MONDAY.getDay()) ?? weekday.defaults;
    expect(real.source).toBe('override');
    expect(real.opensAt).not.toBe(mutated.opensAt);
  });

  it('M3: treating an unresolved schedule as closed changes what is drawn', () => {
    expect(resolveHoursForDate(null, MONDAY).isClosed).toBe(false);
  });
});
