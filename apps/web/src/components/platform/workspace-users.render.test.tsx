/**
 * D55.1 — the console's role picker is driven by the workspace, not by a list
 * in this component.
 *
 * ## Why this needs a test rather than a code review
 *
 * The component shipped with `const ROLES = ['OWNER', 'ADMIN', 'MANAGER',
 * 'CASHIER', 'ACCOUNTANT']` in it. That list is *correct for a hardware
 * workspace*, which is exactly what makes the bug survivable: every hardware
 * screenshot looks right, and only a restaurant workspace — where Waiter is the
 * role the workspace exists to assign — reveals it. So the load-bearing
 * assertions here are a matched pair on the SAME component:
 *
 *  • given restaurant roles, Waiter and Kitchen Staff are offered;
 *  • given hardware roles, they are not, and nothing beyond those five appears.
 *
 * A component that re-hardcoded the five would pass the second and fail the
 * first. One that offered every role it had ever seen would pass the first and
 * fail the second. Neither half is sufficient alone.
 *
 * Mutation-proven by reintroducing exactly that constant in place of the
 * `roles` map: two tests fail — "offers the restaurant roles" and "submits the
 * role id, not a role name" — while "offers only the five built-ins" stays
 * green, which is the asymmetry the paired assertions above exist to cover.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceRoleView, WorkspaceUserView, WorkspaceView } from '@/lib/platform-admin-api';

const listUsers = vi.fn();
const listRoles = vi.fn();
const createUser = vi.fn();
const updateUser = vi.fn();

vi.mock('@/lib/platform-admin-api', () => ({
  platformAdmin: {
    listUsers: (...a: unknown[]) => listUsers(...a),
    listRoles: (...a: unknown[]) => listRoles(...a),
    createUser: (...a: unknown[]) => createUser(...a),
    updateUser: (...a: unknown[]) => updateUser(...a),
    resetPassword: vi.fn(),
  },
}));

import { WorkspaceUsers } from './workspace-users';

const RESTAURANT_ROLES: WorkspaceRoleView[] = [
  { id: 'r_owner', key: 'OWNER', name: 'Owner', description: 'Full access.', isSystem: true },
  { id: 'r_admin', key: 'ADMIN', name: 'Administrator', description: null, isSystem: true },
  { id: 'r_manager', key: 'MANAGER', name: 'Manager', description: null, isSystem: true },
  { id: 'r_acct', key: 'ACCOUNTANT', name: 'Accountant', description: null, isSystem: true },
  { id: 'r_cashier', key: 'CASHIER', name: 'Cashier', description: null, isSystem: true },
  {
    id: 'r_waiter',
    key: 'WAITER',
    name: 'Waiter',
    description: 'Opens tables, takes orders, sends them to the kitchen.',
    isSystem: false,
  },
  { id: 'r_kstaff', key: 'KITCHEN_STAFF', name: 'Kitchen Staff', description: null, isSystem: false },
];

const HARDWARE_ROLES: WorkspaceRoleView[] = RESTAURANT_ROLES.filter((r) => r.isSystem);

const WORKSPACE: WorkspaceView = {
  id: 'tnt_1',
  name: 'Test Workspace',
  slug: 'test',
  isActive: true,
  templateKey: 'RESTAURANT',
  businessType: 'RESTAURANT',
  userCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const WAITER_USER: WorkspaceUserView = {
  id: 'u_waiter',
  name: 'Wendy Waiter',
  email: 'wendy@test.example',
  // The enum underneath. The console must not report this as their role.
  role: 'CASHIER',
  isActive: true,
  roleId: 'r_waiter',
  roleKey: 'WAITER',
};

const session = { token: 't', user: { tenantId: 'tnt_platform' } } as never;

// No global setup file, so RTL's auto-cleanup is not registered; without this
// the previous test's dialog survives into the next one's queries.
afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  listUsers.mockResolvedValue([WAITER_USER]);
  listRoles.mockResolvedValue(RESTAURANT_ROLES);
});

async function openAddUser() {
  render(
    <WorkspaceUsers
      session={session}
      workspace={WORKSPACE}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  const add = await screen.findByRole('button', { name: 'Add user' });
  add.click();
  return screen.findByLabelText('Role');
}

describe('the Add user role picker', () => {
  it('offers the restaurant roles for a restaurant workspace', async () => {
    const select = await openAddUser();
    const options = within(select).getAllByRole('option').map((o) => o.textContent);

    expect(options).toContain('Waiter');
    expect(options).toContain('Kitchen Staff');
    // Positive on the built-ins too, so "it renders the roles it was given" is
    // proven rather than "it renders the non-built-in ones".
    expect(options).toContain('Owner');
    expect(options).toHaveLength(RESTAURANT_ROLES.length);
  });

  it('offers only the five built-ins for a hardware workspace', async () => {
    listRoles.mockResolvedValue(HARDWARE_ROLES);
    const select = await openAddUser();
    const options = within(select).getAllByRole('option').map((o) => o.textContent);

    expect(options).toEqual(['Owner', 'Administrator', 'Manager', 'Accountant', 'Cashier']);
    expect(options).not.toContain('Waiter');
    expect(options).not.toContain('Kitchen Staff');
  });

  it('submits the role id, not a role name', async () => {
    // The API resolves the role against the workspace's own rows; sending a
    // name would break the moment a tenant renamed one.
    const select = (await openAddUser()) as HTMLSelectElement;
    expect(RESTAURANT_ROLES.map((r) => r.id)).toContain(select.value);
  });
});

describe('the user list', () => {
  it('shows a waiter as Waiter, never as the CASHIER enum underneath', async () => {
    render(
      <WorkspaceUsers
        session={session}
        workspace={WORKSPACE}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const select = (await screen.findByLabelText('Role for Wendy Waiter')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('r_waiter'));
    const chosen = within(select)
      .getAllByRole('option')
      .find((o) => (o as HTMLOptionElement).selected);
    expect(chosen?.textContent).toBe('Waiter');
    // The enum is not presented as this user's role anywhere in the row.
    expect(screen.queryByText('CASHIER')).toBeNull();
  });

  it('says so when a user is on no workspace role at all', async () => {
    listUsers.mockResolvedValue([{ ...WAITER_USER, roleId: null, roleKey: null, role: 'MANAGER' }]);
    render(
      <WorkspaceUsers
        session={session}
        workspace={WORKSPACE}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    // A legacy account resolves from the enum, and the console reports that
    // rather than rendering an empty select that looks like a load failure.
    expect(await screen.findByText(/No workspace role/)).toBeTruthy();
    expect(screen.getByText('MANAGER')).toBeTruthy();
  });
});
