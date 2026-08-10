/**
 * Restaurant Pilot Change 1 — creator-owned Dining Area and Restaurant Table
 * management. Exercises the ownership rule end-to-end over the real HTTP wire.
 *
 * The rule is: mutation requires BOTH the matching permission AND
 * `entity.createdByUserId === authenticated user`. Role alone is never enough
 * — that is the whole reason this pilot change exists. Every test in this
 * file targets one of two guard positions:
 *
 *   1. The **permissions guard** blocks a role that doesn't hold the
 *      permission at all (ADMIN, MANAGER, restaurant sub-roles). No service
 *      call happens; the request never reaches ownership.
 *   2. The **ownership check inside the service** blocks a caller who *does*
 *      hold the permission but is not the creator (a second OWNER on the
 *      same tenant, most importantly). Same 403 shape as (1), so a caller
 *      cannot distinguish "you don't have the permission" from "the row is
 *      not yours" — both are refusals a client should surface identically.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let tile: SeededTenant;
let secondOwnerId: string;
let adminId: string;

const tok = (userId: string, tenantId: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'CASHIER', branchId: string) =>
  http.tokenFor({ userId, tenantId, role, activeBranchId: branchId });

const ownerTok = (t: SeededTenant) => tok(t.ownerId, t.tenantId, 'OWNER', t.branchId);
const managerTok = (t: SeededTenant) => tok(t.managerId, t.tenantId, 'MANAGER', t.branchId);
const cashierTok = (t: SeededTenant) => tok(t.cashierId, t.tenantId, 'CASHIER', t.branchId);
const secondOwnerTok = () => tok(secondOwnerId, restaurant.tenantId, 'OWNER', restaurant.branchId);
const adminTok = () => tok(adminId, restaurant.tenantId, 'ADMIN', restaurant.branchId);

beforeAll(async () => {
  prisma = await connectTestPrisma();
  http = await createHttpIntegrationApp();
});

afterAll(async () => {
  await http.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  restaurant = await seedSecondTenant(prisma);

  // A SECOND OWNER on the restaurant tenant — the load-bearing fixture for
  // the "other owner cannot edit my row" cases. Same role, same tenant,
  // different id.
  secondOwnerId = 'rest-second-owner';
  adminId = 'rest-admin';
  await prisma.user.createMany({
    data: [
      {
        id: secondOwnerId,
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        role: 'OWNER',
        name: 'Second Owner',
        email: 'second-owner@fixture-restaurant.test',
      },
      {
        id: adminId,
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        role: 'ADMIN',
        name: 'Fixture Admin',
        email: 'admin@fixture-restaurant.test',
      },
    ],
  });

  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'TILE_SHOP');
  await seedTenantRoles(prisma, restaurant.tenantId, 'RESTAURANT');
  await linkUsersToRoles(prisma, tile.tenantId);
  await linkUsersToRoles(prisma, restaurant.tenantId);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: restaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });
});

async function createArea(token: string, body: Record<string, unknown> = { name: 'Main Floor' }) {
  return http.request<{ id: string; name: string; createdByUserId: string | null }>(
    'POST',
    `/restaurant/branches/${restaurant.branchId}/dining-areas`,
    { token, body },
  );
}

async function createTable(
  token: string,
  areaId: string,
  body: Record<string, unknown> = { code: 'T1', capacity: 4 },
) {
  return http.request<{ id: string; code: string; createdByUserId: string | null }>(
    'POST',
    `/restaurant/dining-areas/${areaId}/tables`,
    { token, body },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–9 — Dining area ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('Dining area — creator-scoped edit + archive', () => {
  it('1. OWNER can create a Dining Area', async () => {
    const res = await createArea(ownerTok(restaurant));
    expect(res.status).toBe(201);
    expect(res.data.name).toBe('Main Floor');
  });

  it('2. createdByUserId is taken from the authenticated context', async () => {
    const res = await createArea(ownerTok(restaurant));
    expect(res.data.createdByUserId).toBe(restaurant.ownerId);
  });

  it('3. a client-supplied createdByUserId is rejected by the DTO whitelist', async () => {
    // The DTO does not declare `createdByUserId`, and `forbidNonWhitelisted`
    // in the pipe rejects unknown fields with 400 — a spoof attempt gets
    // the same treatment as a typo, which is what closes the vector.
    const res = await createArea(ownerTok(restaurant), {
      name: 'Spoofed',
      createdByUserId: secondOwnerId,
    });
    expect(res.status).toBe(400);
  });

  it('4. the creating OWNER can edit their own Dining Area', async () => {
    const created = await createArea(ownerTok(restaurant));
    const patched = await http.request<{ name: string }>(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${created.data.id}`,
      { token: ownerTok(restaurant), body: { name: 'Main Room' } },
    );
    expect(patched.status).toBe(200);
    expect(patched.data.name).toBe('Main Room');
  });

  it('5. a DIFFERENT OWNER on the same tenant cannot edit it', async () => {
    const created = await createArea(ownerTok(restaurant));
    const patched = await http.request(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${created.data.id}`,
      { token: secondOwnerTok(), body: { name: 'Hijacked' } },
    );
    expect(patched.status).toBe(403);
    // The row was unchanged.
    const fresh = await prisma.diningArea.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(fresh.name).toBe('Main Floor');
  });

  it('6. an ADMIN cannot edit a creator-owned Dining Area (permission is gone from ADMIN)', async () => {
    const created = await createArea(ownerTok(restaurant));
    const patched = await http.request(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${created.data.id}`,
      { token: adminTok(), body: { name: 'Hijacked' } },
    );
    expect(patched.status).toBe(403);
  });

  it('7. a MANAGER cannot edit it', async () => {
    const created = await createArea(ownerTok(restaurant));
    const patched = await http.request(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${created.data.id}`,
      { token: managerTok(restaurant), body: { name: 'Hijacked' } },
    );
    expect(patched.status).toBe(403);
  });

  it('8. the creator can archive their own empty Dining Area (soft-delete via isActive=false)', async () => {
    const created = await createArea(ownerTok(restaurant));
    const archived = await http.request<{ isActive: boolean }>(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${created.data.id}`,
      { token: ownerTok(restaurant) },
    );
    expect(archived.status).toBe(200);
    expect(archived.data.isActive).toBe(false);
    const fresh = await prisma.diningArea.findUniqueOrThrow({ where: { id: created.data.id } });
    // Row is preserved, not deleted — so historical joins still resolve.
    expect(fresh).not.toBeNull();
    expect(fresh.isActive).toBe(false);
  });

  it('9. a Dining Area with active tables cannot be archived', async () => {
    const area = await createArea(ownerTok(restaurant));
    await createTable(ownerTok(restaurant), area.data.id);
    const archived = await http.request(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: ownerTok(restaurant) },
    );
    expect(archived.status).toBe(409);
    expect((archived.body as { code?: string }).code).toBe('AREA_HAS_TABLES');
    const fresh = await prisma.diningArea.findUniqueOrThrow({ where: { id: area.data.id } });
    expect(fresh.isActive).toBe(true);
  });

  it('9b. an area with only archived tables CAN be archived (positive control for 9)', async () => {
    // Sibling assertion: the block must be about *active* tables, not the
    // presence of any row. Without this, an implementation that permanently
    // blocked archival once any table ever existed would pass test 9.
    const area = await createArea(ownerTok(restaurant));
    const table = await createTable(ownerTok(restaurant), area.data.id);
    await http.request(
      'DELETE',
      `/restaurant/dining-areas/${area.data.id}/tables/${table.data.id}`,
      { token: ownerTok(restaurant) },
    );
    const archived = await http.request(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: ownerTok(restaurant) },
    );
    expect(archived.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10–16 — Restaurant table ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('Restaurant table — creator-scoped edit + archive', () => {
  let areaId: string;
  beforeEach(async () => {
    const area = await createArea(ownerTok(restaurant));
    areaId = area.data.id;
  });

  it('10. OWNER can create a Restaurant Table', async () => {
    const res = await createTable(ownerTok(restaurant), areaId);
    expect(res.status).toBe(201);
    expect(res.data.code).toBe('T1');
    expect(res.data.createdByUserId).toBe(restaurant.ownerId);
  });

  it('11. the creating OWNER can edit their own table', async () => {
    const table = await createTable(ownerTok(restaurant), areaId);
    const patched = await http.request<{ capacity: number; label: string | null }>(
      'PATCH',
      `/restaurant/dining-areas/${areaId}/tables/${table.data.id}`,
      { token: ownerTok(restaurant), body: { label: 'Window seat', capacity: 6 } },
    );
    expect(patched.status).toBe(200);
    expect(patched.data.capacity).toBe(6);
    expect(patched.data.label).toBe('Window seat');
  });

  it('12. a DIFFERENT OWNER cannot edit it', async () => {
    const table = await createTable(ownerTok(restaurant), areaId);
    const patched = await http.request(
      'PATCH',
      `/restaurant/dining-areas/${areaId}/tables/${table.data.id}`,
      { token: secondOwnerTok(), body: { capacity: 99 } },
    );
    expect(patched.status).toBe(403);
    const fresh = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.data.id } });
    expect(fresh.capacity).toBe(4);
  });

  it('13. an ADMIN cannot edit a creator-owned table', async () => {
    const table = await createTable(ownerTok(restaurant), areaId);
    const patched = await http.request(
      'PATCH',
      `/restaurant/dining-areas/${areaId}/tables/${table.data.id}`,
      { token: adminTok(), body: { capacity: 99 } },
    );
    expect(patched.status).toBe(403);
  });

  it('14. the creator can archive their AVAILABLE table', async () => {
    const table = await createTable(ownerTok(restaurant), areaId);
    const archived = await http.request<{ isActive: boolean }>(
      'DELETE',
      `/restaurant/dining-areas/${areaId}/tables/${table.data.id}`,
      { token: ownerTok(restaurant) },
    );
    expect(archived.status).toBe(200);
    expect(archived.data.isActive).toBe(false);
  });

  it('15. an OPEN session on the table blocks archival', async () => {
    const table = await createTable(ownerTok(restaurant), areaId);
    // Drop an OPEN TableSession directly rather than going through the sessions
    // API — the archive rule must reject the row regardless of how the session
    // got there.
    await prisma.tableSession.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        tableId: table.data.id,
        sessionNumber: 'TS-1',
        status: 'OPEN',
      },
    });
    const archived = await http.request(
      'DELETE',
      `/restaurant/dining-areas/${areaId}/tables/${table.data.id}`,
      { token: ownerTok(restaurant) },
    );
    expect(archived.status).toBe(409);
    expect((archived.body as { code?: string }).code).toBe('TABLE_IN_SERVICE');
  });

  it('16. archiving a table preserves historical sessions (join still resolves)', async () => {
    const table = await createTable(ownerTok(restaurant), areaId);
    const session = await prisma.tableSession.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        tableId: table.data.id,
        sessionNumber: 'TS-HIST',
        status: 'CLOSED',
        closedAt: new Date(),
      },
    });
    await http.request(
      'DELETE',
      `/restaurant/dining-areas/${areaId}/tables/${table.data.id}`,
      { token: ownerTok(restaurant) },
    );
    const stillThere = await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stillThere.tableId).toBe(table.data.id);
    // And the table row is preserved so the join has something to point at.
    const t = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.data.id } });
    expect(t.isActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17–22 — Cross-tenant, direct API, audit, archived cannot receive sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('Boundary + audit + operational effects', () => {
  it('17. Tenant A cannot mutate Tenant B floor / table', async () => {
    const area = await createArea(ownerTok(restaurant));
    // The Tile Shop tenant tries to edit the restaurant's area. Two guards
    // both point in the right direction — the restaurant module isn't even
    // enabled for the tile shop — but the outcome must be a refusal either
    // way.
    const patched = await http.request(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: ownerTok(tile), body: { name: 'Hijacked' } },
    );
    expect([403, 404]).toContain(patched.status);
    const fresh = await prisma.diningArea.findUniqueOrThrow({ where: { id: area.data.id } });
    expect(fresh.name).toBe('Main Floor');
  });

  it('18. branch isolation remains enforced (creating in another tenant\'s branch is refused)', async () => {
    // The restaurant owner tries to create an area inside the tile shop's
    // branch id. Even with a valid token, the URL branchId is validated
    // against the caller's tenant.
    const res = await http.request(
      'POST',
      `/restaurant/branches/${tile.branchId}/dining-areas`,
      { token: ownerTok(restaurant), body: { name: 'Trespass' } },
    );
    expect([403, 404]).toContain(res.status);
  });

  it('19. direct API mutation is refused even when the UI would hide the control', async () => {
    // Simulates "attacker who reads the ids from GET and POSTs by hand" — the
    // frontend hides the ••• menu for a non-creator, but that is UX, not
    // access control. The server refuses regardless.
    const area = await createArea(ownerTok(restaurant));
    const patched = await http.request(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: managerTok(restaurant), body: { description: 'client bypass attempt' } },
    );
    expect(patched.status).toBe(403);
  });

  it('20. audit rows are recorded for CREATE / UPDATE / ARCHIVE', async () => {
    const area = await createArea(ownerTok(restaurant));
    await http.request(
      'PATCH',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: ownerTok(restaurant), body: { description: 'note added' } },
    );
    await http.request(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: ownerTok(restaurant) },
    );
    const actions = await prisma.auditLog.findMany({
      where: { tenantId: restaurant.tenantId, entityId: area.data.id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, userId: true },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'DINING_AREA_CREATED',
      'DINING_AREA_UPDATED',
      'DINING_AREA_ARCHIVED',
    ]);
    for (const row of actions) {
      expect(row.userId).toBe(restaurant.ownerId);
    }
  });

  it('21. an archived table cannot receive a new TableSession', async () => {
    const area = await createArea(ownerTok(restaurant));
    const table = await createTable(ownerTok(restaurant), area.data.id);
    await http.request(
      'DELETE',
      `/restaurant/dining-areas/${area.data.id}/tables/${table.data.id}`,
      { token: ownerTok(restaurant) },
    );
    const opened = await http.request(
      'POST',
      `/restaurant/branches/${restaurant.branchId}/table-sessions`,
      { token: ownerTok(restaurant), body: { tableId: table.data.id, guestCount: 2 } },
    );
    // Sessions service refuses non-active tables — a 4xx of any kind is fine;
    // asserting the row was not opened is the load-bearing part.
    expect(opened.status).toBeGreaterThanOrEqual(400);
    const sessionCount = await prisma.tableSession.count({
      where: { tableId: table.data.id },
    });
    expect(sessionCount).toBe(0);
  });

  it('22. an archived Dining Area is filtered out of the operational list', async () => {
    const area = await createArea(ownerTok(restaurant));
    await http.request(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/dining-areas/${area.data.id}`,
      { token: ownerTok(restaurant) },
    );
    const listed = await http.request<Array<{ id: string }>>(
      'GET',
      `/restaurant/branches/${restaurant.branchId}/dining-areas`,
      { token: ownerTok(restaurant) },
    );
    expect(listed.status).toBe(200);
    expect(listed.data.map((a) => a.id)).not.toContain(area.data.id);
    // Positive control: `includeArchived=true` DOES return it, so the
    // filter is doing the work rather than the row having disappeared.
    const withArchived = await http.request<Array<{ id: string }>>(
      'GET',
      `/restaurant/branches/${restaurant.branchId}/dining-areas?includeArchived=true`,
      { token: ownerTok(restaurant) },
    );
    expect(withArchived.data.map((a) => a.id)).toContain(area.data.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extras — the cashier role has none of these permissions
// ─────────────────────────────────────────────────────────────────────────────

describe('Cashier holds none of the new permissions (belt to the OWNER-only braces)', () => {
  it('cashier cannot create a Dining Area', async () => {
    const res = await createArea(cashierTok(restaurant));
    expect(res.status).toBe(403);
  });
  it('cashier cannot create a Restaurant Table', async () => {
    const area = await createArea(ownerTok(restaurant));
    const res = await createTable(cashierTok(restaurant), area.data.id);
    expect(res.status).toBe(403);
  });
});
