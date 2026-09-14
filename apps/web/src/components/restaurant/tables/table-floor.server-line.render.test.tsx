/**
 * D151b — the arrangement's server line names people, not tabs.
 *
 * "surandi: Restaurant Waiter" under a button that already says "View
 * surandi" repeated the tab, and one waiter running two tabs was named twice.
 * The line is now the DISTINCT waiter names, nothing else.
 *
 * Paired per D30: one waiter on two tabs is named ONCE and the `tab:` form is
 * asserted ABSENT (a component still joining `${tab}: ${name}` fails the
 * second; one that dropped the line entirely fails the first); two different
 * waiters are BOTH named (a component that took only the first tab's name
 * would pass the single-waiter case alone). The physical card's own line is
 * untouched and asserted as a control.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiningAreaView, OpenSessionView, RestaurantTableView } from '@/lib/restaurant/types';

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

const OPEN_1 = {
  id: 'open_1',
  areaId: 'area_1',
  branchId: 'brn_1',
  kind: 'OPEN',
  code: 'OPEN-1',
  label: null,
  capacity: 6,
  positionX: null,
  positionY: null,
  status: 'OCCUPIED',
  isActive: true,
  createdByUserId: 'usr_1',
  liveTabs: 2,
  seatsTaken: 4,
  members: [{ id: 'tbl_1', code: 'T1', label: null, areaId: 'area_1', status: 'RESERVED' }],
} as unknown as import('@/lib/restaurant/types').OpenTableView;

function tab(id: string, tabName: string | null, waiterName: string, tableId = 'open_1'): OpenSessionView {
  return {
    id,
    branchId: 'brn_1',
    tableId,
    sessionNumber: 'TS-' + id,
    status: 'OPEN',
    waiterUserId: 'usr_1',
    guestCount: 2,
    openedAt: new Date().toISOString(),
    closedAt: null,
    finalSaleId: null,
    version: 1,
    activeOrderId: 'ord_1',
    tabName,
    readyTicketIds: [],
    waiterName,
  };
}

const session = { user: { id: 'usr_1', tenantId: 't1', role: 'OWNER' as const } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  listAreas.mockResolvedValue([AREA]);
  listTables.mockResolvedValue([TABLE]);
  listOpenTables.mockResolvedValue([OPEN_1]);
});

afterEach(() => {
  cleanup();
});

describe('the server line on a joined table (D151b)', () => {
  it('names one waiter once across two tabs, with no tab prefix', async () => {
    listOpen.mockResolvedValue([
      tab('ses_a', 'surandi', 'Restaurant Waiter'),
      tab('ses_b', 'nuwan', 'Restaurant Waiter'),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // POSITIVE — the tabs are still each reachable by name…
    await waitFor(() => expect(screen.getByRole('link', { name: /View surandi/ })).toBeTruthy());
    expect(screen.getByRole('link', { name: /View nuwan/ })).toBeTruthy();
    // …and the person serving them is named exactly once.
    expect(screen.getAllByText('Restaurant Waiter')).toHaveLength(1);
    // NEGATIVE — the old "tab: name" form is gone.
    expect(screen.queryByText(/surandi:/)).toBeNull();
    expect(screen.queryByText(/nuwan:/)).toBeNull();
  });

  it('names both waiters when two people share the arrangement', async () => {
    listOpen.mockResolvedValue([
      tab('ses_a', 'surandi', 'Restaurant Waiter'),
      tab('ses_b', 'nuwan', 'Nimal Perera'),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    await waitFor(() => expect(screen.getByText('Restaurant Waiter · Nimal Perera')).toBeTruthy());
  });

  it('CONTROL — a physical table still carries its waiter as before (D151a)', async () => {
    listOpenTables.mockResolvedValue([]);
    listOpen.mockResolvedValue([tab('ses_p', null, 'Restaurant Waiter', 'tbl_1')]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    await waitFor(() => expect(screen.getByText('Restaurant Waiter')).toBeTruthy());
  });
});
