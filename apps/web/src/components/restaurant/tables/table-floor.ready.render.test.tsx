/**
 * D105 — the waiter's "food ready" bell, pinned in pairs like every other
 * chime suite: each ring case has a silent twin, because a bell wired to
 * "any response" passes the ring half alone.
 *
 * The bell's memory has two layers with different lifetimes and both are
 * asserted here: the CHIME baseline (per mount — first load never rings),
 * and the ACK set (per device via sessionStorage — a badge answered by
 * opening the order stays answered, until the ticket id leaves the server
 * list, which is how a recalled-then-rebumped dish earns a second ring).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiningAreaView,
  OpenSessionView,
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

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { id: 'usr_1' } },
    hasPermission: () => true,
  }),
}));

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listOpenTables = vi.fn<() => Promise<unknown[]>>();
const listOpen = vi.fn<() => Promise<OpenSessionView[]>>();

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: () => listAreas(), create: vi.fn(), update: vi.fn(), archive: vi.fn() },
  restaurantTables: {
    list: (_s: unknown, areaId: string) => listTables(areaId),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  openTables: { list: () => listOpenTables(), create: vi.fn(), dissolve: vi.fn() },
  tableSessions: { listOpen: () => listOpen(), open: vi.fn() },
}));

// Sound is asserted against the chime module — jsdom has no AudioContext.
const foodReady = vi.fn();
vi.mock('@/lib/restaurant/new-order-chime', () => ({
  playNewOrderChime: vi.fn(),
  playFoodReadyChime: () => foodReady(),
}));

const { TableFloor } = await import('./table-floor');

const AREA: DiningAreaView = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main Floor',
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
  status: 'OCCUPIED',
  isActive: true,
  createdByUserId: 'usr_1',
};

function openSession(readyTicketIds: string[]): OpenSessionView {
  return {
    id: 'ses_1',
    branchId: 'brn_1',
    tableId: 'tbl_1',
    sessionNumber: 'TS-000001',
    status: 'OPEN',
    waiterUserId: 'usr_1',
    guestCount: 2,
    openedAt: new Date().toISOString(),
    closedAt: null,
    finalSaleId: null,
    version: 1,
    activeOrderId: 'ord_1',
    readyTicketIds,
  };
}

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Let one full 8 s session-refresh interval elapse (and its fetch settle). */
async function tickPoll() {
  await vi.advanceTimersByTimeAsync(8000);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  listAreas.mockResolvedValue([AREA]);
  listTables.mockResolvedValue([TABLE]);
  listOpenTables.mockResolvedValue([]);
  listOpen.mockResolvedValue([openSession([])]);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the food-ready bell (D105)', () => {
  it('never rings on first load, but a standing bump still shows its badge', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // Positive control: the floor rendered the session's badge…
    await waitFor(() => expect(screen.getByText('Food ready')).toBeTruthy());
    // …and stayed silent: food bumped before this screen opened is state to
    // read, not an arrival to announce.
    expect(foodReady).not.toHaveBeenCalled();
  });

  it('rings once, and badges the table, when a poll brings a new bump', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    expect(screen.queryByText('Food ready')).toBeNull();

    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    await tickPoll();

    await waitFor(() => expect(foodReady).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Food ready')).toBeTruthy();
  });

  it('stays silent when the poll repeats the same bumped tickets', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    await tickPoll();

    await waitFor(() => expect(listOpen.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(foodReady).not.toHaveBeenCalled();
  });

  it('opening the order answers the bell — badge gone, and the next poll does not revive it', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    await waitFor(() => expect(screen.getByText('Food ready')).toBeTruthy());

    fireEvent.click(screen.getByRole('link', { name: 'View order' }));
    expect(screen.queryByText('Food ready')).toBeNull();

    await tickPoll();
    await waitFor(() => expect(listOpen.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('Food ready')).toBeNull();
    expect(foodReady).not.toHaveBeenCalled();
  });

  it('a recalled-then-rebumped ticket rings and badges again despite the old ack', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    fireEvent.click(screen.getByRole('link', { name: 'View order' }));
    expect(screen.queryByText('Food ready')).toBeNull();

    // The kitchen recalls the bump: the id leaves the list, taking the ack
    // with it (the ONE poll where silence is right — nothing arrived).
    listOpen.mockResolvedValue([openSession([])]);
    await tickPoll();
    expect(foodReady).not.toHaveBeenCalled();

    // …and bumps it again: to the floor this is fresh news.
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    await tickPoll();

    await waitFor(() => expect(foodReady).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Food ready')).toBeTruthy();
  });
});
