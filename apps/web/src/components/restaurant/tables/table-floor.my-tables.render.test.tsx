/**
 * D156 — the floor opens on MY tables, and the whole floor is one tap away.
 *
 * ## Why these claims
 *
 * The server now returns the branch's sessions to a waiter (D70 withheld them),
 * so the screen is the only thing standing between a waiter and a list that
 * mixes their three tables with the room's eleven — which is precisely what D70
 * was protecting against when it solved the problem by making colleagues
 * invisible. Each half therefore has to be asserted against its opposite on the
 * same data:
 *
 *   - "defaults to mine" is indistinguishable from "drops sessions it cannot
 *     parse" unless the same render also proves the colleague's table IS there
 *     once All is tapped;
 *   - "All shows everything" is indistinguishable from "the filter does
 *     nothing" unless Mine is proven to hide the same card;
 *   - D157b: a default computed from the data moved AFTER the first paint in
 *     one direction or the other (the two flickers the PO reported), so the
 *     no-tables-of-mine case is asserted to STAY on mine with the All chip
 *     naming what is there — the screen offers the room rather than taking the
 *     operator to it.
 *
 * The card's "View order" link is what each case counts, because it exists ONLY
 * for a session the floor is showing: the table itself renders either way, so
 * querying the table name would pass against a broken filter.
 *
 * Mutation-proven, each mutation run against the components themselves:
 *   1. reading `snapshot.sessionsByTableId` instead of `visibleSessions` at the
 *      table-card call site (the scope honoured by the chips and ignored by the
 *      cards) — 3 failed, 2 passed;
 *   2. `resolveOwnerScope` returning `chosen ?? 'all'` (a waiter opens on the
 *      whole room) — 2 failed, 3 passed;
 *   3. `resolveOwnerScope` ignoring `chosen` (the poll-stomping shape) — 3
 *      failed, 2 passed;
 *   4. D157b: the pre-D157b data-driven default restored
 *      (`mineCount > 0 ? 'mine' : 'all'`) — 2 failed, 4 passed: the
 *      no-tables-of-mine case and the first-paint case;
 *   5. D156a: the server's name taken from the SCOPED session the card renders
 *      (`servedBy={s?.waiterName}`) instead of the branch snapshot — 2 failed,
 *      5 passed: a colleague's table goes anonymous the moment the operator
 *      narrows to their own;
 *   6. D156a: the pre-D156a "only when it is not mine" rule restored — 2
 *      failed, 5 passed.
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

const ME = 'usr_me';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { id: ME } },
    // Every permission, TABLE_SESSION_VIEW_ALL among them — which is what makes
    // the chips render at all, and what the server is answering with a floor.
    hasPermission: () => true,
  }),
}));

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listOpenTables = vi.fn<() => Promise<OpenTableView[]>>();
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

// ── fixtures ────────────────────────────────────────────────────────────────

const AREA: DiningAreaView = {
  id: 'area_1',
  branchId: 'brn_1',
  name: 'Main Floor',
  description: null,
  position: 0,
  isActive: true,
  createdByUserId: ME,
} as DiningAreaView;

/** Label distinct from code, as a real floor has them — and so a query for the
 *  label matches ONE element rather than the card's two lines. */
const tbl = (id: string, code: string, label: string): RestaurantTableView =>
  ({
    id,
    areaId: 'area_1',
    branchId: 'brn_1',
    kind: 'PHYSICAL',
    code,
    label,
    capacity: 4,
    status: 'OCCUPIED',
    isActive: true,
    createdByUserId: ME,
  }) as RestaurantTableView;

const ses = (
  id: string,
  tableId: string,
  waiterUserId: string,
  waiterName: string,
): OpenSessionView =>
  ({
    id,
    branchId: 'brn_1',
    tableId,
    sessionNumber: `TS-${id}`,
    status: 'OPEN',
    waiterUserId,
    waiterName,
    guestCount: 2,
    openedAt: new Date().toISOString(),
    closedAt: null,
    finalSaleId: null,
    version: 1,
    activeOrderId: `ord_${id}`,
    tabName: null,
    readyTicketIds: [],
  }) as OpenSessionView;

const session = { token: 't', user: { id: ME, tenantId: 'tnt_1' } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Every session the floor is currently showing, by its card's link target. */
const shownSessionIds = () =>
  screen
    .queryAllByRole('link', { name: 'View order' })
    .map((a) => new URL(a.getAttribute('href')!, 'http://x').searchParams.get('sessionId'));

beforeEach(() => {
  listAreas.mockResolvedValue([AREA]);
  listTables.mockResolvedValue([
    tbl('tbl_mine', 'T1', 'Table one'),
    tbl('tbl_theirs', 'T2', 'Table two'),
  ]);
  listOpenTables.mockResolvedValue([]);
  listOpen.mockResolvedValue([
    ses('mine', 'tbl_mine', ME, 'Nimal'),
    ses('theirs', 'tbl_theirs', 'usr_other', 'Sunil'),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('whose tables the floor shows (D156)', () => {
  it('opens on my tables, and says so on the chip', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // POSITIVE — my table's order is reachable…
    await waitFor(() => expect(shownSessionIds()).toEqual(['mine']));
    // …NEGATIVE — and the colleague's session is not on the screen, even though
    // the server returned it and its table is drawn.
    expect(screen.getByText('Table two')).toBeTruthy();
    expect(shownSessionIds()).not.toContain('theirs');

    // The counts are the answer to "is it worth switching": one of mine, two
    // running.
    expect(screen.getByRole('button', { name: 'My tables · 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All tables · 2' })).toBeTruthy();
  });

  it('D157a — is already on My tables on the FIRST paint, before any data lands', async () => {
    /*
     * The PO's report: "for a second it's in all tables, all orders, then
     * navigates to my". `mineCount` was a plain number, and before the first
     * response it is zero — which the resolver could not tell from "this
     * operator has no tables", so every arrival opened on the whole floor and
     * snapped over a fetch later.
     *
     * Asserted at the one moment that was wrong: the promise is held open, so
     * this is the paint the waiter sees while the request is in flight. Then
     * released, to prove the same render settles on My tables rather than
     * passing through it.
     */
    let release!: (rows: OpenSessionView[]) => void;
    listOpen.mockReturnValue(
      new Promise<OpenSessionView[]>((resolve) => {
        release = resolve;
      }),
    );

    render(<TableFloor session={session} branchId="brn_1" canManage />);

    // First paint, nothing loaded: My tables is already the active chip…
    const mine = await screen.findByRole('button', { name: /^My tables/ });
    expect(mine.getAttribute('data-active')).toBe('true');
    // …and NOT All, which is what the operator was seeing.
    expect(screen.getByRole('button', { name: /^All tables/ }).getAttribute('data-active')).toBe(
      'false',
    );

    await act(async () => {
      release([ses('mine', 'tbl_mine', ME, 'Nimal'), ses('theirs', 'tbl_theirs', 'usr_other', 'Sunil')]);
      await new Promise((r) => setTimeout(r, 0));
    });

    // Settled on the same chip — no flip in either direction.
    await waitFor(() => expect(shownSessionIds()).toEqual(['mine']));
    expect(screen.getByRole('button', { name: 'My tables · 1' }).getAttribute('data-active')).toBe(
      'true',
    );
  });

  it('shows the floor — with the colleague named — when All tables is tapped', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    await waitFor(() => expect(shownSessionIds()).toEqual(['mine']));

    fireEvent.click(screen.getByRole('button', { name: 'All tables · 2' }));

    await waitFor(() => expect(shownSessionIds().sort()).toEqual(['mine', 'theirs']));
    /*
     * D156a — EVERY occupied table names its server, mine included (PO: "in
     * tables can you add serve waiter name"). A floor plan that named everyone
     * except the reader is a strange thing to hold up in front of a colleague,
     * and the room is what this view is for.
     */
    expect(screen.getByText('Sunil')).toBeTruthy();
    expect(screen.getByText('Nimal')).toBeTruthy();
  });

  it('goes back to mine, so the chips are a filter and not a one-way door', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'All tables · 2' }));
    await waitFor(() => expect(shownSessionIds()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'My tables · 1' }));
    await waitFor(() => expect(shownSessionIds()).toEqual(['mine']));
    /*
     * D156a — the colleague's table is still NAMED under "mine"; what the chip
     * takes away is the order, not the attribution. Asserted together, because
     * the pair is the rule: a name with no View order beside it is "somebody
     * else is on that table", which is the question a waiter asks about M3.
     */
    expect(screen.getByText('Sunil')).toBeTruthy();
    expect(shownSessionIds()).not.toContain('theirs');
  });

  it('D156a — names the server on a table it will not let you open', async () => {
    /*
     * The half of "add serve waiter name" that a scoped floor makes easy to get
     * wrong: the name must come from the branch's sessions, not from the ones
     * the chip is showing, or a colleague's table goes back to being an
     * anonymous "In service" the moment the operator narrows to their own.
     *
     * Asserted as the PAIR, on the same card, in the default scope: the name is
     * there AND the order is not reachable.
     */
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // Default scope — only my own order is reachable…
    await waitFor(() => expect(shownSessionIds()).toEqual(['mine']));
    // …and yet both tables say who is on them.
    expect(screen.getByText('Sunil')).toBeTruthy();
    expect(screen.getByText('Nimal')).toBeTruthy();

    // NEGATIVE — a name is not an entry point: no second View order appeared.
    expect(screen.getAllByRole('link', { name: 'View order' })).toHaveLength(1);
  });

  it('D157b — STAYS on my tables when none are mine, and names what All holds', async () => {
    /*
     * The second flicker the PO reported: this case used to widen itself once
     * the count landed, so a cashier (or a waiter before their first table)
     * watched the screen answer "mine" and then move to "all" on its own.
     *
     * Now it holds. Nothing of theirs is on the floor, which is the truth, and
     * the All chip carries the branch count so the room is one tap away rather
     * than one surprise away. The floor plan itself still draws every table, so
     * this is not a blank screen — only the View-order links are scoped.
     */
    listOpen.mockResolvedValue([
      ses('theirs', 'tbl_theirs', 'usr_other', 'Sunil'),
      ses('alsotheirs', 'tbl_mine', 'usr_third', 'Kamal'),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    // Held on mine: no session of theirs, so no order is reachable…
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'My tables · 0' }).getAttribute('data-active')).toBe(
        'true',
      ),
    );
    expect(shownSessionIds()).toEqual([]);
    // …and the room is offered, with its size, rather than taken.
    const all = screen.getByRole('button', { name: 'All tables · 2' });
    expect(all.getAttribute('data-active')).toBe('false');
    // The tables themselves are still drawn — an empty scope is not an empty
    // screen, which is what the old auto-widening was worried about.
    expect(screen.getByText('Table one')).toBeTruthy();
    expect(screen.getByText('Table two')).toBeTruthy();

    // One tap over, and now the colleagues' orders are reachable.
    fireEvent.click(all);
    await waitFor(() => expect(shownSessionIds().sort()).toEqual(['alsotheirs', 'theirs']));
  });

  it('keeps showing my tables across a poll that brings a colleague a new one', async () => {
    // The stomping case: the 8 s poll re-renders with fresh data, and an
    // operator's chip choice must survive it.
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'All tables · 2' }));
    await waitFor(() => expect(shownSessionIds()).toHaveLength(2));

    listOpen.mockResolvedValue([
      ses('mine', 'tbl_mine', ME, 'Nimal'),
      ses('theirs', 'tbl_theirs', 'usr_other', 'Sunil'),
      ses('third', 'tbl_theirs', 'usr_other', 'Sunil'),
    ]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Still on the floor, now three — not snapped back to "mine" by the poll.
    await waitFor(() => expect(shownSessionIds().length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('button', { name: 'All tables · 3' })).toBeTruthy();
  });
});
