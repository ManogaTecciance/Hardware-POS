/**
 * D112 — the waiter's "Food ready" BADGE (D118: visual only — the bell that
 * once rang here was removed; sound lives in the kitchen alone, and one
 * tripwire below re-runs the poll that used to ring and asserts silence).
 *
 * The badge's memory is the ACK set (per device via sessionStorage): a badge
 * answered by opening the order stays answered, until the ticket id leaves
 * the server list — which is how a recalled-then-rebumped dish earns its
 * badge back.
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

// D118's silence is asserted at the runtime boundary, not at a module the
// screen does not even import: the chime is a Web Audio graph, so a sound —
// this branch's, or one re-added any other way — must construct an
// AudioContext. jsdom has none; the stub is the only one, and it counts.
const audioCtor = vi.fn();
vi.stubGlobal('AudioContext', audioCtor);
vi.stubGlobal('webkitAudioContext', audioCtor);

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
    tabName: null,
    readyTicketIds,
    // D151 — the session's own waiter. `usr_1` IS the signed-in user in this
    // spec, so every session here is "mine" and the ownership filter is a
    // no-op: these cases stay about the badge, as they were written.
    waiterName: 'Restaurant Waiter',
  };
}

/** D104 × D112 — a tab on a joined table: its own name, its own bumped tickets. */
function tab(id: string, tableId: string, tabName: string, readyTicketIds: string[]): OpenSessionView {
  return { ...openSession(readyTicketIds), id, tableId, tabName };
}

/** A joined table (D49/D104) holding T1, with room for one more party. */
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

describe('the food-ready badge (D112/D118)', () => {
  it('a standing bump shows its badge on first load', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    await waitFor(() => expect(screen.getByText('Food ready')).toBeTruthy());
  });

  it('a poll bringing a new bump badges the table — and makes NO sound (D118)', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    expect(screen.queryByText('Food ready')).toBeNull();

    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    await tickPoll();

    // The poll that used to ring: badge yes, speaker no.
    await waitFor(() => expect(screen.getByText('Food ready')).toBeTruthy());
    expect(audioCtor).not.toHaveBeenCalled();
  });

  it('opening the order answers the badge, and the next poll does not revive it', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    await waitFor(() => expect(screen.getByText('Food ready')).toBeTruthy());

    const viewOrder = screen.getByRole('link', { name: 'View order' });
    /*
     * D150 — a table card's View order opens the POS on THIS session. Asserted
     * here rather than in its own case because this is the test that taps it:
     * a link whose href had drifted would still clear the badge, so the ack
     * assertions below would pass while the waiter landed nowhere useful.
     */
    expect(viewOrder.getAttribute('href')).toBe('/pos?mode=dine-in&sessionId=ses_1');

    fireEvent.click(viewOrder);
    expect(screen.queryByText('Food ready')).toBeNull();

    await tickPoll();
    await waitFor(() => expect(listOpen.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('Food ready')).toBeNull();
  });

  it('a recalled-then-rebumped ticket badges again despite the old ack', async () => {
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    fireEvent.click(screen.getByRole('link', { name: 'View order' }));
    expect(screen.queryByText('Food ready')).toBeNull();

    // The kitchen recalls the bump: the id leaves the list, taking the ack
    // with it.
    listOpen.mockResolvedValue([openSession([])]);
    await tickPoll();

    // …and bumps it again: to the floor this is fresh news.
    listOpen.mockResolvedValue([openSession(['kt_1'])]);
    await tickPoll();

    await waitFor(() => expect(screen.getByText('Food ready')).toBeTruthy());
    expect(audioCtor).not.toHaveBeenCalled();
  });
});

/**
 * D110/D119 — the badge on a joined table with several tabs. fix/table-tab
 * made a table's sessions a LIST (D104); this branch's badge was written
 * against one session per table. The union sums the unanswered bumps across
 * every tab and answers them tab by tab, because each tab's link is what the
 * runner tapped. Positive and negative both: one badge, the right card, gone
 * only when every tab is answered.
 */
describe('the badge on an arrangement with several tabs (D104 × D112)', () => {
  it('badges the arrangement once, and clears tab by tab as each tab is opened', async () => {
    listOpenTables.mockResolvedValue([OPEN_1]);
    listOpen.mockResolvedValue([
      tab('ses_a', 'open_1', 'Smiths', ['kt_a']),
      tab('ses_b', 'open_1', 'Jones', ['kt_b']),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // ONE badge, on the arrangement: the member table T1 carries no tab of
    // its own and must not badge for a party sat on the arrangement.
    await waitFor(() => expect(screen.getAllByText('Food ready')).toHaveLength(1));
    expect(screen.getByText('2 tabs')).toBeTruthy();
    const smiths = screen.getByRole('link', { name: /View Smiths/ });
    const jones = screen.getByRole('link', { name: /View Jones/ });
    /*
     * D150 — each tab's link is the POS, bound to THAT tab's session. The
     * session id in the query is the whole point: one arrangement, two
     * parties, and the POS has no other way to tell which order it is adding
     * to. (It used to be `/tables/session/<id>`, the retired order-entry
     * screen, which redirects here now.)
     */
    expect(smiths.getAttribute('href')).toBe('/pos?mode=dine-in&sessionId=ses_a');
    expect(jones.getAttribute('href')).toBe('/pos?mode=dine-in&sessionId=ses_b');
    expect(screen.getByRole('button', { name: /add a tab/i })).toBeTruthy();

    // Opening one tab answers ITS bump only — the other party's food is still up.
    fireEvent.click(smiths);
    expect(screen.getAllByText('Food ready')).toHaveLength(1);

    fireEvent.click(jones);
    expect(screen.queryByText('Food ready')).toBeNull();

    // NEGATIVE — the acks are per ticket, so a poll that still lists both
    // ids revives nothing (the answered set survives the poll).
    await tickPoll();
    await waitFor(() => expect(listOpen.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('Food ready')).toBeNull();
  });

  it('MUTATION PROOF — a badge that counted only the first tab would be red', async () => {
    // Bump only the SECOND tab. A union that kept "one session per table"
    // (the first) would show no badge at all; the list shows it.
    listOpenTables.mockResolvedValue([OPEN_1]);
    listOpen.mockResolvedValue([
      tab('ses_a', 'open_1', 'Smiths', []),
      tab('ses_b', 'open_1', 'Jones', ['kt_b']),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    await waitFor(() => expect(screen.getAllByText('Food ready')).toHaveLength(1));
    const firstOnly = [tab('ses_a', 'open_1', 'Smiths', [])].reduce((n, s) => n + s.readyTicketIds.length, 0);
    expect(firstOnly).toBe(0);
    expect(() => expect(firstOnly).toBeGreaterThan(0)).toThrow();
  });
});

/*
 * Last on purpose — see the orders-page polling spec for why.
 */
describe('POSITIVE CONTROL — the stub can hear a real chime', () => {
  it('the real new-order chime constructs an AudioContext', async () => {
    vi.resetModules();
    const { playNewOrderChime } = await import('@/lib/restaurant/new-order-chime');
    playNewOrderChime();
    expect(audioCtor).toHaveBeenCalledTimes(1);
  });
});
