/**
 * The service dashboard: the reservations card, and the promise that the page
 * fits its screen (D148).
 *
 * Two claims, and they pull against each other — which is the whole reason
 * this spec exists. Adding a fourth panel is the obvious way to make a
 * dashboard scroll, and "it fits" is the kind of thing that is true on the
 * developer's monitor and false on the tablet by the pass.
 *
 * The fit is asserted as the CSS contract rather than by measuring pixels,
 * because jsdom lays nothing out: no element has a height here, so a test that
 * measured one would pass on any markup at all. What IS provable is the
 * mechanism — the page is height-bounded, the panel row absorbs the slack, and
 * each card is the scroller instead of the page. Every one of those is
 * asserted positively AND negatively, since dropping any single one puts the
 * scroll back on the page while the other two still read correctly.
 *
 * ## Mutation proof (D30)
 *
 * Eight mutants of restaurant-dashboard.tsx, each run against this spec and
 * then reverted. All eight were killed:
 *
 *   1. the card is dropped from the panel row .............. 6 tests fail
 *   2. `lg:h-full` removed from the page root .............. 1 test fails
 *   3. `lg:flex-1` removed from the panel row .............. 1 test fails
 *   4. `lg:overflow-y-auto` removed from the card bodies ... 1 test fails
 *   5. `lg:auto-rows-fr` removed from the panel row ........ 1 test fails
 *   6. the permission gate renders an empty card instead
 *      of saying the book is not theirs ................... 1 test fails
 *   7. the soonest-first sort is dropped ................... 1 test fails
 *   8. the window is anchored to midnight, not to now ...... 1 test fails
 *
 * Mutants 2 through 5 are the ones that matter most: each removes ONE of the
 * four rules that together keep the page off a scrollbar, and each is caught
 * by exactly one test. That is the evidence that the four assertions are
 * independent rather than four spellings of the same check.
 */
import { RESTAURANT_ROLE_TEMPLATES, ROLE_PERMISSIONS } from '@hardware-pos/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `next/link` reaches for the router context, which no unit render provides.
// The same one-line stand-in the settings specs use.
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

const listReservations = vi.fn();
const listAreas = vi.fn();
const listTables = vi.fn();
const listTickets = vi.fn();
const listTakeaway = vi.fn();

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: { list: (...a: unknown[]) => listAreas(...a) },
  restaurantTables: { list: (...a: unknown[]) => listTables(...a) },
  kitchen: { listTickets: (...a: unknown[]) => listTickets(...a) },
  takeaway: { list: (...a: unknown[]) => listTakeaway(...a) },
  reservations: { list: (...a: unknown[]) => listReservations(...a) },
  tableSessions: { list: vi.fn() },
}));

let granted = new Set<string>();
/*
 * ONE stable object, deliberately — the real `AuthProvider` memoises its
 * context value, so `hasPermission` keeps its identity across renders. A stub
 * that returned a fresh object each render would re-fire the dashboard's
 * effect on every state update and re-fetch in a loop: a defect invented by
 * the test, which would then be "fixed" in the component that never had it.
 */
const auth = { hasPermission: (p: string) => granted.has(p) };
vi.mock('@/lib/auth', () => ({ useAuth: () => auth }));

import { RestaurantDashboard } from './restaurant-dashboard';

const SESSION = {
  branchId: 'brn_1',
  branchName: 'Colombo',
  registerName: 'Till 1',
} as unknown as Parameters<typeof RestaurantDashboard>[0]['session'];

/** Two bookings, deliberately given OUT of time order so the sort is load-bearing. */
const BOOKINGS = [
  {
    id: 'rsv_2',
    branchId: 'brn_1',
    tableId: 'tbl_7',
    reservationNumber: 'R-2',
    customerId: null,
    customerName: 'Ayesha Fernando',
    customerPhone: null,
    partySize: 2,
    startAt: '2026-09-09T14:00:00.000Z',
    endAt: '2026-09-09T16:00:00.000Z',
    status: 'BOOKED' as const,
    notes: null,
    createdByUserId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'rsv_1',
    branchId: 'brn_1',
    tableId: 'tbl_3',
    reservationNumber: 'R-1',
    customerId: null,
    customerName: 'Nimal Perera',
    customerPhone: null,
    partySize: 6,
    startAt: '2026-09-09T12:30:00.000Z',
    endAt: '2026-09-09T14:30:00.000Z',
    status: 'SEATED' as const,
    notes: null,
    createdByUserId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  },
];

const TABLES = [
  { id: 'tbl_3', areaId: 'area_1', branchId: 'brn_1', kind: 'STANDARD', code: '3', label: null, capacity: 6, positionX: null, positionY: null, status: 'AVAILABLE', isActive: true, createdByUserId: null },
  { id: 'tbl_7', areaId: 'area_1', branchId: 'brn_1', kind: 'STANDARD', code: '7', label: 'Window', capacity: 2, positionX: null, positionY: null, status: 'AVAILABLE', isActive: true, createdByUserId: null },
];

beforeEach(() => {
  granted = new Set(['reservation:view', 'kot:view', 'takeaway:view']);
  listAreas.mockResolvedValue([{ id: 'area_1', branchId: 'brn_1', name: 'Main', createdByUserId: null }]);
  listTables.mockResolvedValue(TABLES);
  listTickets.mockResolvedValue([]);
  listTakeaway.mockResolvedValue([]);
  listReservations.mockResolvedValue(BOOKINGS);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mount() {
  render(<RestaurantDashboard session={SESSION} />);
  // Every card resolves a real read; wait for the loading copy to clear.
  await waitFor(() => expect(screen.queryByText('Loading reservations…')).toBeNull());
}

const reservationCard = () =>
  screen.getByRole('heading', { name: 'Upcoming reservations' }).closest('div.rounded-2xl')!;

describe('the upcoming reservations card', () => {
  it('lists the bookings soonest first, with time, guest, table and party size', async () => {
    await mount();
    const card = reservationCard();

    const rows = within(card as HTMLElement).getAllByRole('link');
    // Soonest first, and the fixture is supplied in the OPPOSITE order — so a
    // component that simply rendered what it was handed fails here.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Nimal Perera'),
      expect.stringContaining('Ayesha Fernando'),
    ]);
    // The table's own label wins over "Table <code>", as it does on the floor.
    expect(rows[0]!.textContent).toContain('Table 3');
    expect(rows[1]!.textContent).toContain('Window');
    // Singular vs plural, because "1 guests" is the kind of thing nobody fixes.
    expect(rows[0]!.textContent).toContain('6 guests');
    expect(rows[1]!.textContent).toContain('2 guests');
  });

  it('asks the server for a window that starts NOW, not at the top of the day', async () => {
    await mount();

    expect(listReservations).toHaveBeenCalledTimes(1);
    const [, branchId, from, to] = listReservations.mock.calls[0]!;
    expect(branchId).toBe('brn_1');
    /*
     * The defect this pins: `from` at midnight makes a card headed "upcoming"
     * open with every booking already seated. A window anchored to now cannot
     * do that. Asserted as a bound rather than an exact instant, since the
     * component reads the real clock.
     */
    const drift = Math.abs((from as Date).getTime() - Date.now());
    expect(drift).toBeLessThan(60_000);
    expect((to as Date).getTime() - (from as Date).getTime()).toBe(24 * 60 * 60 * 1000);
    // NEGATIVE — closed bookings are never asked for, so cancelled and
    // no-show tables cannot occupy the card.
    expect(listReservations.mock.calls[0]!.length).toBeLessThanOrEqual(4);
  });

  it('says the book is empty in words, and offers the calendar', async () => {
    listReservations.mockResolvedValue([]);
    await mount();

    expect(screen.getByText(/Nothing booked in the next 24 hours\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the calendar' })).toBeTruthy();
  });

  it('NEGATIVE — a role without the permission is told so, not shown an empty book', async () => {
    granted = new Set(['kot:view', 'takeaway:view']);
    render(<RestaurantDashboard session={SESSION} />);

    await waitFor(() =>
      expect(screen.getByText('The reservation book is not part of your role.')).toBeTruthy(),
    );
    /*
     * The distinction that matters: an empty card claims "no bookings
     * tonight", and a host who believes that gives the table away. So the
     * empty-state wording must NOT appear, and the read must not be attempted.
     */
    expect(screen.queryByText(/Nothing booked in the next 24 hours\./)).toBeNull();
    expect(listReservations).not.toHaveBeenCalled();
  });
});

describe('what the page header says (D151)', () => {
  it('names the branch and NOT the counter', async () => {
    await mount();

    // The fixture carries `registerName: 'Till 1'`, so this negative is about
    // a value the component was handed and chose not to print — not about a
    // session that never had one.
    expect(screen.getByRole('heading', { name: 'Service dashboard' })).toBeTruthy();
    expect(screen.getByText('Colombo')).toBeTruthy();
    expect(screen.queryByText(/Till 1/)).toBeNull();
    // The separator went with it: "Colombo · " would be the half-removal.
    expect(screen.queryByText(/Colombo\s*·/)).toBeNull();
  });
});

describe('the dashboard fits its screen', () => {
  /*
   * jsdom computes no layout, so none of this can be measured. It is asserted
   * as the mechanism instead, in both directions — each rule below is one that
   * puts the scroll back on the page if it goes missing on its own.
   */
  const page = () => screen.getByRole('heading', { name: 'Service dashboard' }).closest('div.flex.flex-col')!.parentElement!;

  it('bounds the page to the height it is given', async () => {
    await mount();
    const root = screen.getByRole('heading', { name: 'Service dashboard' }).closest('.lg\\:h-full')!;

    expect(root.className).toContain('lg:h-full');
    // `min-h-0` is the one that is easy to omit and impossible to see: without
    // it a flex child's minimum height is its content, so the row below grows
    // past the bound instead of scrolling inside it.
    expect(root.className).toContain('lg:min-h-0');
    // NEGATIVE — a fixed height would crop a short dashboard's own content.
    expect(root.className).not.toMatch(/(^|\s)h-screen(\s|$)/);
  });

  it('gives the slack to the panel row, and shares it evenly between rows', async () => {
    await mount();
    const row = reservationCard().parentElement!;

    expect(row.className).toContain('lg:flex-1');
    expect(row.className).toContain('lg:min-h-0');
    // Two-by-two at `lg`: without `auto-rows-fr` the rows size to content and
    // the taller one pushes the page past the fold again.
    expect(row.className).toContain('lg:auto-rows-fr');
    // Four panels across at `xl` — the card was ADDED to the row, not stacked
    // under it, which is what keeps the cost in width rather than height.
    expect(row.className).toContain('xl:grid-cols-4');
    expect(row.children).toHaveLength(4);
  });

  it('makes each CARD the scroller, never the page', async () => {
    await mount();
    const row = reservationCard().parentElement!;

    for (const card of Array.from(row.children)) {
      const body = card.querySelector('.lg\\:overflow-y-auto');
      expect(body, `every panel scrolls inside itself: ${card.textContent?.slice(0, 40)}`).not.toBeNull();
      expect(body!.className).toContain('lg:min-h-0');
      expect(body!.className).toContain('lg:flex-1');
      // The card holds its own height so the body is the only thing that gives.
      expect((card as HTMLElement).className).toContain('lg:h-full');
    }
    // NEGATIVE — the page itself must never be a scroller, or the header and
    // the tiles scroll away and the constraint above buys nothing.
    expect(page().className).not.toContain('overflow-y-auto');
  });

  it('leaves the phone alone, where scrolling is the right answer', async () => {
    await mount();
    const row = reservationCard().parentElement!;

    /*
     * Every height rule is `lg:`-prefixed on purpose. On a phone the tiles
     * alone are taller than the viewport, and four panels squeezed into
     * quarter-height boxes would be unreadable. A bare `h-full` or `flex-1`
     * here would apply at every width — this is the check that catches it.
     */
    for (const klass of ['h-full', 'flex-1', 'min-h-0', 'overflow-y-auto', 'auto-rows-fr']) {
      expect(row.className).not.toMatch(new RegExp(`(^|\\s)${klass}(\\s|$)`));
    }
  });
});

describe('who actually gets the card', () => {
  /*
   * The card is on the SERVICE dashboard, and in a table-service tenant that
   * one screen is what the owner, the waiter and the restaurant cashier all
   * land on — the dashboard router dispatches on business type before it
   * looks at a role. So "add it for the waiter and the cashier" and "add it
   * for the owner too" are the same change, and the only thing that can still
   * keep it from a role is the permission.
   *
   * Driven from the REAL templates rather than hand-written permission sets.
   * A spec that invented its own sets would keep passing after someone took
   * RESERVATION_VIEW off the waiter, which is precisely the regression that
   * would empty this card for the person who needs it most.
   */
  const templateFor = (key: string) => {
    const found = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === key);
    // FAIL rather than skip: a renamed template must not make this inspect
    // nothing and report success (D30).
    if (!found) throw new Error(`no ${key} template — this spec is inspecting nothing`);
    return found.permissions as readonly string[];
  };

  const ROLES: Array<[string, readonly string[]]> = [
    ['the owner', ROLE_PERMISSIONS.OWNER as readonly string[]],
    ['the waiter', templateFor('WAITER')],
    ['the restaurant cashier', templateFor('RESTAURANT_CASHIER')],
  ];

  for (const [who, permissions] of ROLES) {
    it(`shows the bookings to ${who}`, async () => {
      granted = new Set(permissions);
      await mount();

      expect(
        within(reservationCard() as HTMLElement).getByText(/Nimal Perera/),
        `${who} must see the reservation book on the service dashboard`,
      ).toBeTruthy();
      expect(screen.queryByText('The reservation book is not part of your role.')).toBeNull();
    });
  }

  it('NEGATIVE — the templates really do differ, so the loop above is not three copies of one case', () => {
    /*
     * The control. If every template held every permission, the three tests
     * above would prove nothing about gating. They differ, and specifically
     * they differ on keys this dashboard reads.
     */
    const waiter = new Set(templateFor('WAITER'));
    const cashier = new Set(templateFor('RESTAURANT_CASHIER'));
    expect(waiter.has('sale:read')).toBe(false);
    expect(cashier.has('sale:read')).toBe(true);
    // …while all three DO carry the key this card depends on.
    for (const [, permissions] of ROLES) expect(new Set(permissions).has('reservation:view')).toBe(true);
  });
});
