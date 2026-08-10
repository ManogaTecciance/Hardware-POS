/**
 * Restaurant Phase 2C — dining areas + tables.
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
let tile: SeededTenant;
let restaurant: SeededTenant;

const ownerToken = (t: SeededTenant) =>
  http.tokenFor({
    userId: t.ownerId,
    tenantId: t.tenantId,
    role: 'OWNER',
    activeBranchId: t.branchId,
  });

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

describe('Restaurant Phase 2C — dining areas and tables', () => {
  it('creates an area and a table under it', async () => {
    const area = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${restaurant.branchId}/dining-areas`,
      { token: ownerToken(restaurant), body: { name: 'Main Room', position: 0 } },
    );
    expect(area.status).toBe(201);

    const table = await http.request<{ id: string; code: string; status: string }>(
      'POST',
      `/restaurant/dining-areas/${area.data.id}/tables`,
      { token: ownerToken(restaurant), body: { code: 'T1', capacity: 4 } },
    );
    expect(table.status).toBe(201);
    expect(table.data.code).toBe('T1');
    expect(table.data.status).toBe('AVAILABLE');
  });

  it('a hardware tenant is refused (DINING module absent)', async () => {
    const res = await http.request('GET', `/restaurant/branches/${tile.branchId}/dining-areas`, {
      token: ownerToken(tile),
    });
    expect(res.status).toBe(403);
  });

  it('duplicate table code on the same area answers 409', async () => {
    const area = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${restaurant.branchId}/dining-areas`,
      { token: ownerToken(restaurant), body: { name: 'Bar' } },
    );
    await http.request('POST', `/restaurant/dining-areas/${area.data.id}/tables`, {
      token: ownerToken(restaurant),
      body: { code: 'B1', capacity: 2 },
    });
    const dup = await http.request('POST', `/restaurant/dining-areas/${area.data.id}/tables`, {
      token: ownerToken(restaurant),
      body: { code: 'B1', capacity: 4 },
    });
    expect(dup.status).toBe(409);
  });

  it('the creator-scoped PATCH refuses status changes (that is the sessions system\'s job)', async () => {
    // Restaurant Pilot Change 1: the dining PATCH DTO no longer accepts
    // `status`. Table status transitions belong to the sessions system, which
    // has its own test coverage (`table-sessions.spec.ts`). A client sending
    // `status` here now trips the `forbidNonWhitelisted` guard on the pipe,
    // which is the intended fail-loud: nothing silently swallows the field.
    const area = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${restaurant.branchId}/dining-areas`,
      { token: ownerToken(restaurant), body: { name: 'Room' } },
    );
    const table = await http.request<{ id: string }>(
      'POST',
      `/restaurant/dining-areas/${area.data.id}/tables`,
      { token: ownerToken(restaurant), body: { code: 'T1', capacity: 4 } },
    );
    const patched = await http.request(
      'PATCH',
      `/restaurant/dining-areas/${area.data.id}/tables/${table.data.id}`,
      { token: ownerToken(restaurant), body: { status: 'SEATED' } },
    );
    expect(patched.status).toBe(400);
  });
});
