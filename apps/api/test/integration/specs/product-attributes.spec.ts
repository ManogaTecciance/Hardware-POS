/**
 * D64 — Product.attributes end to end (convergence plan §4.6, Phase 7).
 *
 * One declarative schema per domain drives the schema read, the write-side
 * refusal and the sellable listing's `attr[…]` filters. Held to D30 in both
 * directions with the two live registry answers:
 *
 *  - POSITIVE: a HOTEL tenant (the one declaring domain) reads its schema,
 *    stores a valid document, replaces it wholesale on update, and filters
 *    the sellable listing by attribute.
 *  - NEGATIVE: invalid values and unknown keys are 400s naming themselves —
 *    and the HARDWARE tenant's EMPTY schema refuses every key, proving the
 *    empty answer is a closed door rather than validation skipped.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;
let hotel: SeededTenant;

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
  hotel = await seedTenant(prisma, {
    prefix: 'hotel',
    name: 'Fixture Hotel',
    slug: 'fixture-hotel',
  });
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
  await seedTenantRoles(prisma, hotel.tenantId, 'HOTEL');
  await linkUsersToRoles(prisma, tile.tenantId);
  await linkUsersToRoles(prisma, hotel.tenantId);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: hotel.tenantId,
      businessType: 'HOTEL',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });
});

const createProduct = (t: SeededTenant, body: Record<string, unknown>) =>
  http.request<{ id: string; attributes: Record<string, unknown> }>('POST', '/products', {
    token: ownerToken(t),
    body: { name: 'Room-ish product', unitPrice: 100, type: 'Service', ...body },
  });

describe('GET /products/attribute-schema', () => {
  it('serves the declaring domain its fields, and the refusing domain an empty list', async () => {
    const h = await http.request<{ fields: { key: string }[] }>(
      'GET',
      '/products/attribute-schema',
      { token: ownerToken(hotel) },
    );
    expect(h.status).toBe(200);
    expect(h.data.fields.map((f) => f.key)).toEqual(['bedCount', 'maxOccupancy', 'viewType']);

    const t = await http.request<{ fields: unknown[] }>('GET', '/products/attribute-schema', {
      token: ownerToken(tile),
    });
    expect(t.status).toBe(200);
    expect(t.data.fields).toEqual([]);
  });
});

describe('write-side validation', () => {
  it('stores a valid document and replaces it wholesale on update', async () => {
    const created = await createProduct(hotel, {
      sku: 'ROOM-1',
      attributes: { bedCount: 2, viewType: 'Sea' },
    });
    expect(created.status).toBe(201);
    expect(created.data.attributes).toEqual({ bedCount: 2, viewType: 'Sea' });

    // Replace semantics: the new document is the whole document.
    const patched = await http.request<{ attributes: Record<string, unknown> }>(
      'PATCH',
      `/products/${created.data.id}`,
      { token: ownerToken(hotel), body: { attributes: { viewType: 'Garden' } } },
    );
    expect(patched.status).toBe(200);
    expect(patched.data.attributes).toEqual({ viewType: 'Garden' });

    // And undefined leaves it untouched.
    const renamed = await http.request<{ attributes: Record<string, unknown> }>(
      'PATCH',
      `/products/${created.data.id}`,
      { token: ownerToken(hotel), body: { name: 'Renamed' } },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.data.attributes).toEqual({ viewType: 'Garden' });
  });

  it('refuses an invalid value with the machine-readable code', async () => {
    const res = await createProduct(hotel, {
      sku: 'ROOM-2',
      attributes: { bedCount: 'two' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PRODUCT_ATTRIBUTES_INVALID' });
  });

  it('refuses unknown keys — and the hardware tenant refuses EVERY key', async () => {
    const unknown = await createProduct(hotel, {
      sku: 'ROOM-3',
      attributes: { bedCount: 2, colour: 'red' },
    });
    expect(unknown.status).toBe(400);

    const hardware = await createProduct(tile, {
      sku: 'TILE-ATTR',
      attributes: { colour: 'red' },
    });
    expect(hardware.status).toBe(400);
    expect(hardware.body).toMatchObject({ code: 'PRODUCT_ATTRIBUTES_INVALID' });

    // Positive control on the same tenant: without attributes the create
    // works, so the refusal above is the schema, not a broken endpoint.
    const plain = await createProduct(tile, { sku: 'TILE-PLAIN' });
    expect(plain.status).toBe(201);
  });
});

describe('sellable attr[…] filters', () => {
  it('filters by enum and by integer value, validated against the schema', async () => {
    const sea = await createProduct(hotel, {
      name: 'Sea View Room',
      sku: 'SEA-1',
      attributes: { bedCount: 2, viewType: 'Sea' },
    });
    const garden = await createProduct(hotel, {
      name: 'Garden Room',
      sku: 'GARDEN-1',
      attributes: { bedCount: 3, viewType: 'Garden' },
    });
    expect(sea.status).toBe(201);
    expect(garden.status).toBe(201);

    const byView = await http.request<{ items: { id: string }[] }>(
      'GET',
      `/products/sellable?branchId=${hotel.branchId}&attr[viewType]=Sea`,
      { token: ownerToken(hotel) },
    );
    expect(byView.status).toBe(200);
    expect(byView.data.items.map((i) => i.id)).toContain(sea.data.id);
    expect(byView.data.items.map((i) => i.id)).not.toContain(garden.data.id);

    // Integer coercion: '3' filters on the NUMBER 3, not the string '3'.
    const byBeds = await http.request<{ items: { id: string }[] }>(
      'GET',
      `/products/sellable?branchId=${hotel.branchId}&attr[bedCount]=3`,
      { token: ownerToken(hotel) },
    );
    expect(byBeds.data.items.map((i) => i.id)).toEqual([garden.data.id]);
  });

  it('refuses an unknown key and an uncoercible value as 400s, not empty pages', async () => {
    const unknown = await http.request(
      'GET',
      `/products/sellable?branchId=${hotel.branchId}&attr[colour]=red`,
      { token: ownerToken(hotel) },
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ code: 'PRODUCT_ATTRIBUTE_FILTER_INVALID' });

    const uncoercible = await http.request(
      'GET',
      `/products/sellable?branchId=${hotel.branchId}&attr[bedCount]=many`,
      { token: ownerToken(hotel) },
    );
    expect(uncoercible.status).toBe(400);
  });
});
