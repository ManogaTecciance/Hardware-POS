/**
 * The Open tables block is the FIRST block on the Tables page.
 *
 * An open table is a live party someone is serving right now; the floor plan
 * below it is mostly static furniture. With five dining areas seeded, the block
 * previously sat past 19 table cards and was reachable only by scrolling.
 *
 * ## Why this is asserted on geometry rather than by eye
 *
 * "Is it first" is exactly the kind of claim a test can fake: querying for the
 * heading and asserting it exists passes whether it renders first or last. So
 * the assertion below compares DOM position between the Open tables card and
 * the first area card — `compareDocumentPosition` answers which one precedes
 * the other, and it cannot be satisfied by both merely being present.
 *
 * Mutation-proven: moving the block back below the floor fails both tests.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: {
    list: () => listAreas(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  restaurantTables: {
    list: (_s: unknown, areaId: string) => listTables(areaId),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  openTables: { list: () => listOpenTables(), create: vi.fn(), dissolve: vi.fn() },
  tableSessions: { listOpen: async () => [] as TableSessionView[], open: vi.fn() },
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
  status: 'AVAILABLE',
  isActive: true,
  createdByUserId: 'usr_1',
};

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
  listOpenTables.mockResolvedValue([]);
});

afterEach(cleanup);

/**
 * The card carrying a given CardTitle.
 *
 * Queried by heading role on purpose: the area name also appears as a filter
 * chip at the top of the page, and a plain text query matches that first —
 * which would compare the chip strip against the floor and "prove" the order
 * regardless of where the Open tables block actually sits.
 */
function cardOf(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const card = heading.closest('.rounded-2xl');
  if (!card) throw new Error(`"${title}" is not inside a card — the query needs updating`);
  return card as HTMLElement;
}

describe('TableFloor block order', () => {
  it('renders Open tables before the first dining area', async () => {
    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();

    await screen.findByRole('heading', { name: 'Open tables' });
    const openCard = cardOf('Open tables');
    const areaCard = cardOf('Main Floor');

    // Both present — otherwise the ordering assertion below is vacuous.
    expect(openCard).not.toBe(areaCard);
    // DOCUMENT_POSITION_FOLLOWING: areaCard comes after openCard.
    expect(openCard.compareDocumentPosition(areaCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('stays first when open tables actually exist', async () => {
    // The empty case renders a placeholder; the populated case renders cards.
    // Both must sit above the floor, so both are asserted.
    listOpenTables.mockResolvedValue([
      {
        id: 'open_1',
        branchId: 'brn_1',
        areaId: null,
        kind: 'OPEN',
        code: 'OPEN-1',
        label: 'Joined 1+2',
        capacity: 8,
        positionX: null,
        positionY: null,
        status: 'AVAILABLE',
        isActive: true,
        createdByUserId: 'usr_1',
        members: [
          { id: 'tbl_1', code: 'T1', label: null, areaId: 'area_1', status: 'AVAILABLE' },
        ],
      } as OpenTableView,
    ]);

    render(<TableFloor session={session} branchId="brn_1" canManage />);
    await settle();
    await waitFor(() => expect(screen.getByText('Joined 1+2')).toBeTruthy());

    const openCard = cardOf('Open tables');
    const areaCard = cardOf('Main Floor');
    expect(openCard.compareDocumentPosition(areaCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
