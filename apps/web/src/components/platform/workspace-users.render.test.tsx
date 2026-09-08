/**
 * D55.1 — the console's role picker is driven by the workspace, not by a list
 * in this component.
 *
 * ## Why this needs a test rather than a code review
 *
 * The component shipped with `const ROLES = ['OWNER', 'ADMIN', 'MANAGER',
 * 'CASHIER', 'ACCOUNTANT']` in it. That list *looked* right for a hardware
 * workspace, which is exactly what makes the bug survivable: every hardware
 * screenshot looks plausible, and only a restaurant workspace — where Waiter is
 * the role the workspace exists to assign — reveals it. So the load-bearing
 * assertions here are a matched pair on the SAME component:
 *
 *  • given the restaurant rows, Waiter and Kitchen staff are offered and the
 *    hardware-only Salesperson is not;
 *  • given the hardware rows, exactly Owner, Salesperson and Cashier are
 *    offered and nothing food-service appears.
 *
 * A component that re-hardcoded a list would pass one half and fail the other.
 * One that offered every role it had ever seen would pass the positives and
 * fail the negatives. Neither half is sufficient alone.
 *
 * ## The fixtures are the real templates (D30, D100)
 *
 * The rows are built from `HARDWARE_ROLE_TEMPLATES` and
 * `FOOD_SERVICE_ROLE_TEMPLATES` in `@hardware-pos/shared`, mapped to the API's
 * view shape and ordered as `PlatformAdminService.listRoles` orders them
 * (built-ins first, then by name). The fixtures used to be hand-written — a
 * seven-role list carrying ADMIN, MANAGER and ACCOUNTANT rows that no template
 * has seeded since 2026-08-17 — so the spec was green against a catalogue that
 * did not exist. Deriving from the templates means a template change (D100
 * putting Salesperson on the hardware list and nowhere else) reaches this spec
 * without anyone editing it, and the exact-list assertions fail loudly when the
 * catalogue moves.
 *
 * Mutation-proven inline, at the bottom: the same component fed the restaurant
 * rows plus a Salesperson row renders it and the D100 negative throws; fed the
 * pre-D100 hardware pair (Owner, Cashier — what `GENERAL_ROLE_TEMPLATES` still
 * is) the exact hardware list throws. And a component that hard-coded either
 * workspace's list in place of the `roles` map would pass that workspace's half
 * and fail the other's — the asymmetry the paired assertions exist to cover,
 * shown on the two exact lists in the last proof.
 */
import {
  FOOD_SERVICE_ROLE_TEMPLATES,
  GENERAL_ROLE_TEMPLATES,
  HARDWARE_ROLE_TEMPLATES,
  type RoleTemplate,
} from '@hardware-pos/shared';
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

/**
 * The rows `GET /platform-admin/workspaces/:id/roles` returns for a workspace
 * seeded from `templates`: the API's view shape (`isSystem` is the template's
 * `isBuiltIn`, written by `seedTenantRoles`) in the API's order — `isSystem`
 * desc, then `name` asc — so an exact-list assertion here is an assertion
 * about what the operator sees, not about template declaration order.
 *
 * Throws on an empty list: a renamed export would otherwise hand every test
 * an empty picker, and "does not contain Salesperson" passes on nothing.
 */
function rowsFor(templates: readonly RoleTemplate[]): WorkspaceRoleView[] {
  if (templates.length === 0) {
    throw new Error('No role templates — every picker assertion would be vacuous.');
  }
  return templates
    .map((t) => ({
      id: `r_${t.key.toLowerCase()}`,
      key: t.key,
      name: t.name,
      description: t.description,
      isSystem: t.isBuiltIn,
    }))
    .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
}

const RESTAURANT_ROLES = rowsFor(FOOD_SERVICE_ROLE_TEMPLATES);
const HARDWARE_ROLES = rowsFor(HARDWARE_ROLE_TEMPLATES);

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

const HARDWARE_WORKSPACE: WorkspaceView = {
  ...WORKSPACE,
  id: 'tnt_2',
  name: 'Test Hardware',
  slug: 'test-hardware',
  templateKey: 'HARDWARE',
  businessType: 'HARDWARE',
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

async function openAddUser(workspace: WorkspaceView = WORKSPACE) {
  render(
    <WorkspaceUsers
      session={session}
      workspace={workspace}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  const add = await screen.findByRole('button', { name: 'Add user' });
  add.click();
  return screen.findByLabelText('Role');
}

const optionsOf = (select: HTMLElement): (string | null)[] =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('the fixtures are the production shape', () => {
  it('the hardware rows are exactly Cashier, Owner, Salesperson — all built in (D100)', () => {
    // Pinned here, not only through the component: if the template catalogue
    // moves, the failure names the catalogue rather than the picker.
    expect(HARDWARE_ROLES.map((r) => [r.key, r.name, r.isSystem])).toEqual([
      ['CASHIER', 'Cashier', true],
      ['OWNER', 'Owner', true],
      ['SALESPERSON', 'Salesperson', true],
    ]);
  });

  it('the restaurant rows put the Owner first and carry no Salesperson', () => {
    expect(RESTAURANT_ROLES.map((r) => [r.key, r.name, r.isSystem])).toEqual([
      ['OWNER', 'Owner', true],
      ['RESTAURANT_CASHIER', 'Cashier', false],
      ['KITCHEN_STAFF', 'Kitchen staff', false],
      ['WAITER', 'Waiter', false],
    ]);
    expect(RESTAURANT_ROLES.map((r) => r.key)).not.toContain('SALESPERSON');
  });
});

describe('the Add user role picker', () => {
  it('offers the restaurant roles for a restaurant workspace', async () => {
    const select = await openAddUser();
    const options = optionsOf(select);

    expect(options).toContain('Waiter');
    expect(options).toContain('Kitchen staff');
    // Positive on the built-in too, so "it renders the roles it was given" is
    // proven rather than "it renders the non-built-in ones".
    expect(options).toContain('Owner');
    expect(options).toHaveLength(RESTAURANT_ROLES.length);
    // D100 — the hardware-only role is offered in no other workspace. The
    // positives above are what stop this passing on an empty picker.
    expect(options).not.toContain('Salesperson');
  });

  it('offers exactly Owner, Salesperson and Cashier for a hardware workspace', async () => {
    listRoles.mockResolvedValue(HARDWARE_ROLES);
    const select = await openAddUser(HARDWARE_WORKSPACE);
    const options = optionsOf(select);

    // The API's order: all three are built in, so alphabetical.
    expect(options).toEqual(['Cashier', 'Owner', 'Salesperson']);
    expect(options).not.toContain('Waiter');
    expect(options).not.toContain('Kitchen staff');
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
    /*
     * D100's rollout case: a hardware pilot's salesperson before the tenant's
     * rows are backfilled. The enum still grants the owner's permissions, and
     * the console must say that is where the authority comes from — not render
     * a blank select that looks like a load failure — while the picker offers
     * the workspace's own rows so the operator can link them.
     */
    const unlinked: WorkspaceUserView = {
      id: 'u_sales',
      name: 'Sam Salesperson',
      email: 'sam@test.example',
      role: 'SALESPERSON',
      isActive: true,
      roleId: null,
      roleKey: null,
    };
    const linked: WorkspaceUserView = {
      ...unlinked,
      id: 'u_sales_linked',
      name: 'Lin Linked',
      roleId: 'r_salesperson',
      roleKey: 'SALESPERSON',
    };
    listUsers.mockResolvedValue([unlinked, linked]);
    listRoles.mockResolvedValue(HARDWARE_ROLES);
    render(
      <WorkspaceUsers
        session={session}
        workspace={HARDWARE_WORKSPACE}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    // The whole sentence, read from the paragraph: `getByText` matches an
    // element's own text nodes, and the enum sits in a child span.
    const note = await screen.findByText(/No workspace role/);
    expect(note.textContent).toBe(
      'No workspace role — running on the built-in SALESPERSON permissions.',
    );

    const select = screen.getByLabelText('Role for Sam Salesperson') as HTMLSelectElement;
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(select.value).toBe('');
    expect(options[0]?.textContent).toBe('Not set');
    expect(options[0]?.disabled).toBe(true);
    // "Not set" is a placeholder, not a choice — the rest are the real rows.
    expect(options.map((o) => o.textContent)).toEqual([
      'Not set',
      'Cashier',
      'Owner',
      'Salesperson',
    ]);

    // The paired positive: a LINKED user in the same list gets no placeholder
    // and no note, so the placeholder is about the missing link, not about
    // this workspace or this component.
    const linkedSelect = screen.getByLabelText('Role for Lin Linked') as HTMLSelectElement;
    await waitFor(() => expect(linkedSelect.value).toBe('r_salesperson'));
    expect(optionsOf(linkedSelect)).toEqual(['Cashier', 'Owner', 'Salesperson']);
    expect(optionsOf(linkedSelect)).not.toContain('Not set');
    expect(screen.getAllByText(/No workspace role/)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs (D30) — each renders the REAL component with a deliberately
// wrong fixture and shows the assertion above throwing on it.
// ─────────────────────────────────────────────────────────────────────────────

describe('the picker assertions can actually fail', () => {
  it('a Salesperson row leaking into a restaurant workspace would be detected', async () => {
    // D100's negative, shown to bite: the same component fed the restaurant
    // rows plus the hardware-only role renders it, and `not.toContain` throws.
    const salesperson = HARDWARE_ROLES.find((r) => r.key === 'SALESPERSON');
    expect(salesperson).toBeDefined();
    const leaked = [...RESTAURANT_ROLES, salesperson!];
    expect(leaked).toHaveLength(RESTAURANT_ROLES.length + 1);
    listRoles.mockResolvedValue(leaked);

    const options = optionsOf(await openAddUser());
    expect(options).toContain('Salesperson');
    expect(() => expect(options).not.toContain('Salesperson')).toThrow();
    // …and the length assertion on the restaurant case catches it too.
    expect(() => expect(options).toHaveLength(RESTAURANT_ROLES.length)).toThrow();
  });

  it('a hardware workspace seeded without the Salesperson would be detected', async () => {
    // The pre-D100 hardware pair, which is what GENERAL still seeds. The
    // exact-list assertion is the one that fails — a `toContain('Owner')`
    // would not have.
    const preD100 = rowsFor(GENERAL_ROLE_TEMPLATES);
    expect(preD100.map((r) => r.name)).toEqual(['Cashier', 'Owner']);
    listRoles.mockResolvedValue(preD100);

    const options = optionsOf(await openAddUser(HARDWARE_WORKSPACE));
    expect(options).not.toContain('Salesperson');
    expect(() => expect(options).toEqual(['Cashier', 'Owner', 'Salesperson'])).toThrow();
  });

  it('a picker hard-coding either workspace’s list would pass that half and fail the other', () => {
    // The asymmetry named in the header, on the two exact lists the component
    // is asserted against above. Neither half alone would catch a component
    // that ignored `roles` and rendered a constant: the constant that satisfies
    // one half is exactly what the other refuses. (The two proofs above are the
    // ones that exercise the real component; this pins why there must be two.)
    const hardwareConstant = ['Cashier', 'Owner', 'Salesperson'];
    const restaurantConstant = ['Owner', 'Cashier', 'Kitchen staff', 'Waiter'];

    // Positive controls: each constant does pass its own half.
    expect(hardwareConstant).toEqual(HARDWARE_ROLES.map((r) => r.name));
    expect(restaurantConstant).toEqual(RESTAURANT_ROLES.map((r) => r.name));

    // A hard-coded hardware list fails the restaurant half on its positive and
    // on its D100 negative…
    expect(() => expect(hardwareConstant).toContain('Waiter')).toThrow();
    expect(() => expect(hardwareConstant).not.toContain('Salesperson')).toThrow();
    // …and a hard-coded restaurant list fails the hardware half on its exact
    // list and on its negative.
    expect(() => expect(restaurantConstant).toEqual(['Cashier', 'Owner', 'Salesperson'])).toThrow();
    expect(() => expect(restaurantConstant).not.toContain('Waiter')).toThrow();
  });
});
