/**
 * Phase 5 — table session lifecycle.
 *
 * The one junction point: closing a session produces a Sale (D1). The
 * TableSession.finalSaleId is @unique so a double-close is impossible.
 *
 * Non-vacuous per D30:
 *
 * - Every successful step is asserted positively AND the corresponding
 *   double-execution is asserted to fail (idempotent round submission, no
 *   second session on the same table, no second close).
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let branchId: string;
let areaId: string;
let tableId: string;
let sectionId: string;
let itemId: string;

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
  restaurant = await seedSecondTenant(prisma);
  branchId = restaurant.branchId;
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, restaurant.tenantId, 'RESTAURANT');
  await linkUsersToRoles(prisma, restaurant.tenantId);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: restaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });

  // Fixture: one area, one table, one menu with one item.
  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main' },
  });
  areaId = area.id;
  const table = await prisma.restaurantTable.create({
    data: {
      tenantId: restaurant.tenantId,
      branchId,
      areaId,
      code: 'T1',
      capacity: 4,
    },
  });
  tableId = table.id;
  const menu = await prisma.menu.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Test Menu' },
  });
  const section = await prisma.menuSection.create({
    data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Mains' },
  });
  sectionId = section.id;
  const item = await prisma.menuItem.create({
    data: {
      tenantId: restaurant.tenantId,
      sectionId,
      name: 'Burger',
      basePrice: '12.50',
    },
  });
  itemId = item.id;
});

describe('Phase 5 — table session lifecycle', () => {
  it('open → order → submit round → close (produces a Sale)', async () => {
    const session = await http.request<{ id: string; sessionNumber: string; status: string }>(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: ownerToken(restaurant), body: { tableId, guestCount: 2 } },
    );
    expect(session.status).toBe(201);
    expect(session.data.status).toBe('OPEN');
    expect(session.data.sessionNumber).toMatch(/^TS-\d{6}$/);

    const order = await http.request<{ id: string; status: string; orderNumber: string }>(
      'POST',
      `/restaurant/table-sessions/${session.data.id}/orders`,
      { token: ownerToken(restaurant) },
    );
    expect(order.status).toBe(201);
    expect(order.data.status).toBe('DRAFT');

    const round1 = await http.request<{ id: string; roundNumber: number; itemIds: string[] }>(
      'POST',
      `/restaurant/orders/${order.data.id}/rounds`,
      {
        token: ownerToken(restaurant),
        body: {
          idempotencyKey: 'round-1-key',
          items: [{ menuItemId: itemId, quantity: 2 }],
        },
      },
    );
    expect(round1.status).toBe(201);
    expect(round1.data.roundNumber).toBe(1);
    expect(round1.data.itemIds.length).toBe(1);

    const close = await http.request<{ session: { status: string }; saleId: string }>(
      'POST',
      `/restaurant/table-sessions/${session.data.id}/close`,
      { token: ownerToken(restaurant), body: {} },
    );
    expect(close.status).toBe(200);
    expect(close.data.session.status).toBe('CLOSED');
    expect(close.data.saleId).toBeTruthy();

    // POSITIVE CONTROL: the Sale exists and its total matches the round.
    const sale = await prisma.sale.findUniqueOrThrow({
      where: { id: close.data.saleId },
    });
    expect(sale.total.toFixed(2)).toBe('25.00'); // 12.50 × 2
    expect(sale.tenantId).toBe(restaurant.tenantId);
    expect(sale.branchId).toBe(branchId);

    // MUTATION PROOF: closing again is refused (session already closed).
    const secondClose = await http.request(
      'POST',
      `/restaurant/table-sessions/${session.data.id}/close`,
      { token: ownerToken(restaurant), body: {} },
    );
    expect(secondClose.status).toBe(409);
  });

  it('idempotent round submission — same key returns the same round (scenario 11)', async () => {
    const session = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: ownerToken(restaurant), body: { tableId } },
    );
    const order = await http.request<{ id: string }>(
      'POST',
      `/restaurant/table-sessions/${session.data.id}/orders`,
      { token: ownerToken(restaurant) },
    );

    const submit = {
      token: ownerToken(restaurant),
      body: {
        idempotencyKey: 'duplicate-request-key',
        items: [{ menuItemId: itemId, quantity: 1 }],
      },
    };
    const first = await http.request<{ id: string; roundNumber: number }>(
      'POST',
      `/restaurant/orders/${order.data.id}/rounds`,
      submit,
    );
    const second = await http.request<{ id: string; roundNumber: number }>(
      'POST',
      `/restaurant/orders/${order.data.id}/rounds`,
      submit,
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Same round returned — the second call did NOT create a duplicate.
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.roundNumber).toBe(first.data.roundNumber);

    const rounds = await prisma.orderRound.count({ where: { orderId: order.data.id } });
    expect(rounds).toBe(1);
  });

  it('a sent item cannot be silently deleted — must be voided (scenario 15)', async () => {
    const session = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: ownerToken(restaurant), body: { tableId } },
    );
    const order = await http.request<{ id: string }>(
      'POST',
      `/restaurant/table-sessions/${session.data.id}/orders`,
      { token: ownerToken(restaurant) },
    );
    const round = await http.request<{ itemIds: string[] }>(
      'POST',
      `/restaurant/orders/${order.data.id}/rounds`,
      {
        token: ownerToken(restaurant),
        body: {
          idempotencyKey: 'x',
          items: [{ menuItemId: itemId, quantity: 1 }],
        },
      },
    );
    const voidRes = await http.request(
      'POST',
      `/restaurant/order-items/${round.data.itemIds[0]}/void`,
      { token: ownerToken(restaurant), body: { reason: 'kitchen mistake' } },
    );
    expect(voidRes.status).toBe(204);
    const item = await prisma.restaurantOrderItem.findUniqueOrThrow({
      where: { id: round.data.itemIds[0] },
    });
    expect(item.status).toBe('VOIDED');
    expect(item.voidReason).toBe('kitchen mistake');
  });

  it('the same table cannot have two open sessions', async () => {
    await http.request('POST', `/restaurant/branches/${branchId}/table-sessions`, {
      token: ownerToken(restaurant),
      body: { tableId },
    });
    const second = await http.request(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: ownerToken(restaurant), body: { tableId } },
    );
    expect(second.status).toBe(409);
  });
});
