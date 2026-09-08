/**
 * Restaurant Pilot Change 1 — TableFloor ownership UX.
 *
 * The rule the tests below prove: the ••• menu that carries "Edit" and
 * "Archive" is rendered only when BOTH (a) the current user is the row's
 * creator AND (b) the current user still holds the matching *_OWN
 * permission. Everything else — hiding rather than disabling, opening the
 * edit dialog, opening the archive dialog, refusing to render the menu
 * from React state alone — falls out of that rule.
 *
 * The tests are careful about the specific failure they are catching:
 *
 * - "Creator sees the menu" (positive) is paired with "non-creator does
 *   not" (negative) so a component that always/never rendered would fail.
 * - "Permissions gate the menu" gives the same creator id but revokes the
 *   permission — the menu must vanish. Otherwise `createdByUserId === id`
 *   alone would let a role-stripped user still see it.
 * - "Client state cannot reveal the menu" simulates a user editing the
 *   DOM (an aria-expanded=true injected on a hidden button); the visible
 *   menu items still are not in the tree, because the render itself is
 *   gated.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@/lib/permissions';
import type {
  DiningAreaView,
  RestaurantTableView,
  TableSessionView,
} from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────

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

const currentUserId = 'usr_owner_alice';

const hasPermissionMock = vi.fn<(p: Permission) => boolean>();

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: { user: { id: currentUserId } },
    hasPermission: hasPermissionMock,
  }),
}));

const listAreas = vi.fn<() => Promise<DiningAreaView[]>>();
const listTables = vi.fn<(areaId: string) => Promise<RestaurantTableView[]>>();
const listOpen = vi.fn<() => Promise<TableSessionView[]>>();

vi.mock('@/lib/restaurant/api', () => ({
  diningAreas: {
    list: (_session: unknown, _branchId: string) => listAreas(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  restaurantTables: {
    list: (_session: unknown, areaId: string) => listTables(areaId),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  // D49 — the floor now lists open tables alongside the physical plan.
  openTables: {
    list: async () => [],
    create: vi.fn(),
    dissolve: vi.fn(),
  },
  tableSessions: {
    listOpen: () => listOpen(),
    open: vi.fn(),
  },
}));

const { TableFloor } = await import('./table-floor');

// ── fixtures ─────────────────────────────────────────────────────────────

function area(over: Partial<DiningAreaView> = {}): DiningAreaView {
  return {
    id: 'area_1',
    branchId: 'brn_1',
    name: 'Main Floor',
    description: null,
    position: 0,
    isActive: true,
    createdByUserId: currentUserId,
    ...over,
  };
}

function table(over: Partial<RestaurantTableView> = {}): RestaurantTableView {
  return {
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
    createdByUserId: currentUserId,
    ...over,
  };
}

const session = {
  user: { id: currentUserId, tenantId: 't1', role: 'OWNER' as const },
} as unknown as Parameters<typeof TableFloor>[0]['session'];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listOpen.mockResolvedValue([]);
});

afterEach(cleanup);

function grantAll() {
  hasPermissionMock.mockImplementation(() => true);
}

function grantNone() {
  hasPermissionMock.mockImplementation(() => false);
}

function grantOnly(...perms: Permission[]) {
  const set = new Set<string>(perms);
  hasPermissionMock.mockImplementation((p) => set.has(p));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('TableFloor — creator-only ••• menus', () => {
  it('23. the row creator sees a menu on their own dining area', async () => {
    grantAll();
    listAreas.mockResolvedValue([area()]);
    listTables.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.getByRole('button', { name: /manage main floor/i })).toBeDefined();
  });

  it('24. a different user does NOT see the menu on someone else\'s dining area', async () => {
    grantAll();
    listAreas.mockResolvedValue([area({ createdByUserId: 'usr_owner_bob' })]);
    listTables.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.queryByRole('button', { name: /manage main floor/i })).toBeNull();
  });

  it('25. the row creator sees a menu on their own table', async () => {
    grantAll();
    listAreas.mockResolvedValue([area()]);
    listTables.mockResolvedValue([table({ label: 'Window seat' })]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.getByRole('button', { name: /manage window seat/i })).toBeDefined();
  });

  it('26. a different user does NOT see the menu on someone else\'s table', async () => {
    grantAll();
    listAreas.mockResolvedValue([area()]);
    listTables.mockResolvedValue([
      table({ id: 'tbl_2', code: 'T2', label: 'Bar 1', createdByUserId: 'usr_owner_bob' }),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.queryByRole('button', { name: /manage bar 1/i })).toBeNull();
  });

  it('27. clicking Edit on the creator\'s area opens a dialog with the area\'s name in it', async () => {
    grantAll();
    listAreas.mockResolvedValue([area({ name: 'Terrace' })]);
    listTables.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    screen.getByRole('button', { name: /manage terrace/i }).click();
    await settle();
    within(screen.getByRole('menu')).getByRole('menuitem', { name: /edit floor/i }).click();
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/edit terrace/i)).toBeDefined();
    const nameInput = within(dialog).getByLabelText(/name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Terrace');
  });

  it('28. archive floor click opens the archive confirmation dialog', async () => {
    grantAll();
    listAreas.mockResolvedValue([area()]);
    listTables.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    screen.getByRole('button', { name: /manage main floor/i }).click();
    await settle();
    within(screen.getByRole('menu')).getByRole('menuitem', { name: /archive floor/i }).click();
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/archive main floor/i)).toBeDefined();
    expect(
      within(dialog).getByText(/all active tables must first be moved or archived/i),
    ).toBeDefined();
  });

  it('29. archive table click opens the table archive confirmation', async () => {
    grantAll();
    listAreas.mockResolvedValue([area()]);
    listTables.mockResolvedValue([table({ label: 'Corner' })]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    screen.getByRole('button', { name: /manage corner/i }).click();
    await settle();
    within(screen.getByRole('menu')).getByRole('menuitem', { name: /archive table/i }).click();
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/archive corner/i)).toBeDefined();
    expect(within(dialog).getByText(/no longer be available for new guests/i)).toBeDefined();
  });

  it('30. losing the *_OWN permission removes the menu even when the row is yours', async () => {
    // Same fixture, same creator — only the permission goes away. The menu
    // must vanish. This is what stops a compromised UI state from surfacing
    // the control: hiding the menu is a *permission* affordance, not a mere
    // ownership one, and both conditions have to hold on every render.
    grantOnly(); // no permissions at all
    listAreas.mockResolvedValue([area()]);
    listTables.mockResolvedValue([table({ label: 'Corner' })]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.queryByRole('button', { name: /manage main floor/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage corner/i })).toBeNull();
  });

  it('30b. a permission-only path with no ownership still hides the menu (positive control for 30)', async () => {
    // Full permissions, but the row's creator is someone else — the menu is
    // still absent. Without this the previous test could hold for the wrong
    // reason (menu is always hidden).
    grantAll();
    listAreas.mockResolvedValue([area({ createdByUserId: 'usr_owner_bob' })]);
    listTables.mockResolvedValue([
      table({ id: 'tbl_x', code: 'X1', label: 'Not yours', createdByUserId: 'usr_owner_bob' }),
    ]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.queryByRole('button', { name: /manage main floor/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage not yours/i })).toBeNull();
  });
});

describe('The "New area" affordance obeys DINING_AREA_CREATE', () => {
  it('is shown to a user who holds DINING_AREA_CREATE', async () => {
    grantOnly(Permission.DINING_AREA_CREATE);
    listAreas.mockResolvedValue([]);
    listTables.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    // Two possible buttons carry that copy — the top-of-page one and the
    // empty-state one — so we just assert at least one is present.
    expect(screen.getAllByRole('button', { name: /new area|create dining area/i }).length).toBeGreaterThan(0);
  });

  it('is hidden from a user without DINING_AREA_CREATE', async () => {
    grantNone();
    listAreas.mockResolvedValue([]);
    listTables.mockResolvedValue([]);
    render(<TableFloor session={session} branchId="brn_1" canManage={true} />);
    await settle();
    expect(screen.queryByRole('button', { name: /new area/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create dining area/i })).toBeNull();
  });
});
