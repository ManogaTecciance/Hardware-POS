/**
 * `8.10` — Phase 8 acceptance, over the wire.
 *
 * ## Why this file exists separately from the feature specs
 *
 * Every Phase 8 step already has integration tests that call SERVICES. Those
 * prove the arithmetic and the persistence. They cannot prove:
 *
 *  • that the route is reachable at the path the client actually calls,
 *  • that `ModuleAccessGuard` and `PermissionsGuard` let the right people
 *    through and refuse the rest — those are `APP_GUARD`s and only run on an
 *    HTTP request,
 *  • that the DTOs accept what a client sends and reject what it should not,
 *  • that money survives JSON serialisation as an exact string rather than
 *    arriving as `{}` (which is what a `Decimal` does if it ever escapes).
 *
 * This is the closest thing to the manual pass that a test can be: real HTTP,
 * real guards, real tokens, real roles. It does NOT replace a human opening the
 * screens — see `PROGRESS.md` for what remains unverified by eye.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every gate is asserted from both sides: a role that should pass DOES, and a
 * role that should be refused IS. A test that only checked the refusal would
 * pass for a route that was broken for everyone, and one that only checked the
 * success would pass for a route with no guard at all.
 */

import {
  linkUsersToRoles,
  seedTenantRoles,
  syncPermissionCatalogue,
  type PrismaClient,
} from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let shop: SeededTenant;
let mediumId: string;

const owner = () =>
  http.tokenFor({
    userId: shop.ownerId,
    tenantId: shop.tenantId,
    role: 'OWNER',
    activeBranchId: shop.branchId,
  });

const cashier = () =>
  http.tokenFor({
    userId: shop.cashierId,
    tenantId: shop.tenantId,
    role: 'CASHIER',
    activeBranchId: shop.branchId,
  });

const RANGE = '?from=2026-03-01&to=2026-03-31';

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
  shop = await seedTileShopWithQuickBooks(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, shop.tenantId, 'RETAIL');
  await linkUsersToRoles(prisma, shop.tenantId);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: shop.tenantId,
      businessType: 'RETAIL',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });

  await prisma.product.update({ where: { id: shop.productAId }, data: { hasVariants: true } });
  const dimension = await prisma.productVariationDimension.create({
    data: { tenantId: shop.tenantId, productId: shop.productAId, name: 'Size', position: 0 },
  });
  const option = await prisma.productVariationOption.create({
    data: { tenantId: shop.tenantId, dimensionId: dimension.id, name: 'Medium', position: 0 },
  });
  const medium = await prisma.productVariant.create({
    data: {
      tenantId: shop.tenantId,
      productId: shop.productAId,
      sku: 'A-M',
      unitPrice: 1000,
      averageCost: 600,
      isDefault: true,
    },
  });
  await prisma.productVariantOptionValue.create({
    data: {
      tenantId: shop.tenantId,
      variantId: medium.id,
      dimensionId: dimension.id,
      optionId: option.id,
    },
  });
  await prisma.branchInventory.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      productId: shop.productAId,
      productVariantId: medium.id,
      quantityOnHand: 20,
    },
  });
  mediumId = medium.id;
});

/** One completed sale in March 2026, written the way production writes one. */
async function marchSale(): Promise<void> {
  const sale = await prisma.sale.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      cashierId: shop.ownerId,
      saleNumber: 'S-ACCEPT-1',
      status: 'COMPLETED',
      completedAt: new Date('2026-03-15T10:00:00.000Z'),
      subtotal: 2000,
      taxAmount: 360,
      total: 2360,
    },
  });
  await prisma.saleItem.create({
    data: {
      saleId: sale.id,
      productId: shop.productAId,
      productVariantId: mediumId,
      productName: 'Fixture Product A',
      quantity: 2,
      unitPrice: 1000,
      lineSubtotal: 2000,
      lineTotal: 2000,
      taxAmount: 0,
      taxRatePercent: 18,
    },
  });
}

describe('8.3 — GET /sales/reports/by-variant', () => {
  it('answers an owner with exact money, as strings', async () => {
    await marchSale();
    const res = await http.request<{
      rows: { variantName: string; revenue: string; tax: string; brandName: string | null }[];
      totals: { revenue: string; tax: string };
    }>('GET', `/sales/reports/by-variant${RANGE}`, { token: owner() });

    expect(res.status).toBe(200);
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0]!.variantName).toBe('Medium');
    // Strings, not numbers and not `{}`. A `Prisma.Decimal` that escaped the
    // service would serialise as an object and this is where that shows.
    expect(res.data.rows[0]!.revenue).toBe('2000.00');
    expect(res.data.rows[0]!.tax).toBe('360.00');
    expect(res.data.totals.revenue).toBe('2000.00');
  });

  it('refuses a cashier — a report is not a till function', async () => {
    const res = await http.request('GET', `/sales/reports/by-variant${RANGE}`, {
      token: cashier(),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed range at the DTO, not in the query', async () => {
    const res = await http.request('GET', '/sales/reports/by-variant?from=nonsense&to=2026-03-31', {
      token: owner(),
    });
    expect(res.status).toBe(400);
  });

  it('is not shadowed by GET /sales/:id', async () => {
    // The literal segment is declared before the parameter. If that ever
    // reverses, this route returns 404 "sale reports/by-variant not found"
    // rather than a report, and every assertion above would still be about a
    // service nobody can reach.
    const res = await http.request('GET', `/sales/reports/by-variant${RANGE}`, { token: owner() });
    expect(res.status).not.toBe(404);
  });
});

describe('8.4 — GET /sales/reports/tax-by-rate', () => {
  it('answers an owner, and ties to the sale that was recorded', async () => {
    await marchSale();
    const res = await http.request<{
      rows: { rateLabel: string; taxable: string; tax: string }[];
      totals: { tax: string };
      hasUnattributed: boolean;
    }>('GET', `/sales/reports/tax-by-rate${RANGE}`, { token: owner() });

    expect(res.status).toBe(200);
    expect(res.data.rows).toEqual([
      { ratePercent: '18.00', rateLabel: '18%', taxable: '2000.00', tax: '360.00' },
    ]);
    expect(res.data.hasUnattributed).toBe(false);
  });

  it('refuses a cashier', async () => {
    const res = await http.request('GET', `/sales/reports/tax-by-rate${RANGE}`, {
      token: cashier(),
    });
    expect(res.status).toBe(403);
  });
});

describe('8.5 — GET /sales/reports/margin', () => {
  it('costs the sale at the variant average and reports the source', async () => {
    await marchSale();
    const res = await http.request<{
      rows: { cost: string | null; margin: string | null; costSource: string }[];
      totals: { margin: string; marginPercent: string | null };
      unknownCost: { rows: number };
    }>('GET', `/sales/reports/margin${RANGE}`, { token: owner() });

    expect(res.status).toBe(200);
    // 2 × 600 cost against 2000 revenue.
    expect(res.data.rows[0]!.cost).toBe('1200.00');
    expect(res.data.rows[0]!.margin).toBe('800.00');
    expect(res.data.rows[0]!.costSource).toBe('VARIANT_AVERAGE');
    expect(res.data.totals.marginPercent).toBe('40.00');
    expect(res.data.unknownCost.rows).toBe(0);
  });

  it('refuses a cashier', async () => {
    const res = await http.request('GET', `/sales/reports/margin${RANGE}`, { token: cashier() });
    expect(res.status).toBe(403);
  });
});

describe('8.6 — GET /sales/reports/ageing', () => {
  it('reports stock that has never sold, from a real threshold', async () => {
    await prisma.stockMovement.create({
      data: {
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: shop.productAId,
        productVariantId: mediumId,
        delta: 20,
        balanceAfter: 20,
        reason: 'RECEIPT',
        createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await http.request<{
      rows: { ageDays: number; ageBasis: string; stockValue: string | null }[];
      thresholdDays: number;
      hasStockLedger: boolean;
    }>('GET', '/sales/reports/ageing?thresholdDays=90', { token: owner() });

    expect(res.status).toBe(200);
    expect(res.data.thresholdDays).toBe(90);
    expect(res.data.hasStockLedger).toBe(true);
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0]!.ageBasis).toBe('FIRST_RECEIPT');
    expect(res.data.rows[0]!.ageDays).toBeGreaterThanOrEqual(199);
    // 20 on hand at 600.
    expect(res.data.rows[0]!.stockValue).toBe('12000.00');
  });

  it('rejects a fractional threshold at the DTO', async () => {
    const res = await http.request('GET', '/sales/reports/ageing?thresholdDays=1.5', {
      token: owner(),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a cashier', async () => {
    const res = await http.request('GET', '/sales/reports/ageing', { token: cashier() });
    expect(res.status).toBe(403);
  });
});

describe('8.7 — POST /stock-takes', () => {
  it('an owner counts a shelf down, and the correction is applied', async () => {
    const res = await http.request<{
      countNumber: string;
      lines: { expectedQuantity: string; countedQuantity: string; variance: string }[];
      varianceValue: string;
    }>('POST', '/stock-takes', {
      token: owner(),
      body: {
        branchId: shop.branchId,
        lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 14 }],
        note: 'Acceptance count',
      },
    });

    expect(res.status).toBe(201);
    expect(res.data.countNumber).toMatch(/^SC-\d{6}$/);
    expect(res.data.lines[0]).toMatchObject({
      expectedQuantity: '20.000',
      countedQuantity: '14.000',
      variance: '-6.000',
    });
    expect(res.data.varianceValue).toBe('-3600.00');

    const cell = await prisma.branchInventory.findFirstOrThrow({
      where: { tenantId: shop.tenantId, productVariantId: mediumId },
    });
    expect(Number(cell.quantityOnHand)).toBe(14);
  });

  it('refuses a cashier — counting is a manager action', async () => {
    const res = await http.request('POST', '/stock-takes', {
      token: cashier(),
      body: {
        branchId: shop.branchId,
        lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 14 }],
      },
    });
    expect(res.status).toBe(403);
    // NEGATIVE, and the point: nothing moved on the way to the refusal.
    const cell = await prisma.branchInventory.findFirstOrThrow({
      where: { tenantId: shop.tenantId, productVariantId: mediumId },
    });
    expect(Number(cell.quantityOnHand)).toBe(20);
  });

  it('rejects a count with no lines', async () => {
    const res = await http.request('POST', '/stock-takes', {
      token: owner(),
      body: { branchId: shop.branchId, lines: [] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a negative counted quantity', async () => {
    const res = await http.request('POST', '/stock-takes', {
      token: owner(),
      body: {
        branchId: shop.branchId,
        lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: -1 }],
      },
    });
    expect(res.status).toBe(400);
  });

  it('lets a cashier READ the count history', async () => {
    // Reading is `product:read`, which a cashier holds. Asserted so the 403
    // above reads as a decision about WRITING, not as "cashiers cannot see
    // stock at all".
    const res = await http.request('GET', '/stock-takes', { token: cashier() });
    expect(res.status).toBe(200);
  });
});

describe('8.8 — hold and resume over the wire', () => {
  it('a cashier holds a basket, finds it, resumes it and it disappears', async () => {
    const held = await http.request<{ id: string; status: string }>('POST', '/sales/draft', {
      token: cashier(),
      body: {
        branchId: shop.branchId,
        registerId: shop.registerId,
        items: [{ productId: shop.productAId, productVariantId: mediumId, quantity: 2 }],
      },
    });
    expect([200, 201]).toContain(held.status);
    expect(held.data.status).toBe('DRAFT');

    const list = await http.request<{ id: string }[]>('GET', '/sales/held', { token: cashier() });
    expect(list.status).toBe(200);
    expect(list.data.map((s) => s.id)).toEqual([held.data.id]);

    const completed = await http.request<{ status: string }>('POST', '/sales/complete', {
      token: cashier(),
      body: {
        saleId: held.data.id,
        branchId: shop.branchId,
        payments: [{ method: 'CASH', amount: 2000 }],
      },
    });
    expect([200, 201]).toContain(completed.status);
    expect(completed.data.status).toBe('COMPLETED');

    const after = await http.request<unknown[]>('GET', '/sales/held', { token: cashier() });
    expect(after.data).toEqual([]);
  });

  it('discards a held basket, and cannot touch a completed one', async () => {
    const held = await http.request<{ id: string }>('POST', '/sales/draft', {
      token: cashier(),
      body: {
        branchId: shop.branchId,
        registerId: shop.registerId,
        items: [{ productId: shop.productAId, productVariantId: mediumId, quantity: 1 }],
      },
    });

    const discarded = await http.request('DELETE', `/sales/held/${held.data.id}`, {
      token: cashier(),
    });
    expect(discarded.status).toBe(204);

    const sale = await prisma.sale.create({
      data: {
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        cashierId: shop.ownerId,
        saleNumber: 'S-ACCEPT-DONE',
        status: 'COMPLETED',
        completedAt: new Date(),
        subtotal: 1000,
        total: 1000,
      },
    });
    const refused = await http.request('DELETE', `/sales/held/${sale.id}`, { token: cashier() });
    expect(refused.status).toBe(404);
    expect(await prisma.sale.findUnique({ where: { id: sale.id } })).not.toBeNull();
  });

  it('is not shadowed by GET /sales/:id', async () => {
    const res = await http.request('GET', '/sales/held', { token: cashier() });
    expect(res.status).toBe(200);
  });
});

describe('8.9 — brands over the wire', () => {
  it('an owner creates one, a cashier can read it and cannot create one', async () => {
    const created = await http.request<{ id: string; name: string }>('POST', '/brands', {
      token: owner(),
      body: { name: 'Acceptance Label' },
    });
    expect([200, 201]).toContain(created.status);
    expect(created.data.name).toBe('Acceptance Label');

    const read = await http.request<{ name: string }[]>('GET', '/brands', { token: cashier() });
    expect(read.status).toBe(200);
    expect(read.data.map((b) => b.name)).toEqual(['Acceptance Label']);

    const refused = await http.request('POST', '/brands', {
      token: cashier(),
      body: { name: 'Cashier Label' },
    });
    expect(refused.status).toBe(403);
    // Exactly one brand survives: the refusal happened before the write.
    expect(await prisma.brand.count({ where: { tenantId: shop.tenantId } })).toBe(1);
  });

  it('filters the products list, over the wire', async () => {
    const brand = await http.request<{ id: string }>('POST', '/brands', {
      token: owner(),
      body: { name: 'Filtered' },
    });
    await prisma.product.update({
      where: { id: shop.productAId },
      data: { brandId: brand.data.id },
    });

    const filtered = await http.request<{ items: { id: string }[] }>(
      'GET',
      `/products?page=1&pageSize=50&brandId=${brand.data.id}`,
      { token: owner() },
    );
    expect(filtered.status).toBe(200);
    expect(filtered.data.items.map((p) => p.id)).toEqual([shop.productAId]);

    // NEGATIVE: unfiltered returns more, so the filter is doing something. A
    // query parameter the server ignores would make both lists identical.
    const all = await http.request<{ items: unknown[] }>('GET', '/products?page=1&pageSize=50', {
      token: owner(),
    });
    expect(all.data.items.length).toBeGreaterThan(1);
  });

  it('rejects an unknown field on the body, rather than ignoring it', async () => {
    // `forbidNonWhitelisted` is the flag that turns a client-supplied `tenantId`
    // into a 400 instead of a silent no-op. Asserted here because it is a
    // property of the wiring, not of the DTO.
    const res = await http.request('POST', '/brands', {
      token: owner(),
      body: { name: 'Sneaky', tenantId: 'someone-else' },
    });
    expect(res.status).toBe(400);
  });
});

describe('the retail rail as a whole', () => {
  it('every Phase 8 route is reachable by an owner and refused without a token', async () => {
    // A sweep, so a route that regressed to 404 or 500 cannot hide behind a
    // feature spec that calls its service directly.
    const routes: [string, string][] = [
      ['GET', `/sales/reports/by-variant${RANGE}`],
      ['GET', `/sales/reports/tax-by-rate${RANGE}`],
      ['GET', `/sales/reports/margin${RANGE}`],
      ['GET', '/sales/reports/ageing'],
      ['GET', '/sales/held'],
      ['GET', '/stock-takes'],
      ['GET', '/brands'],
    ];

    for (const [method, path] of routes) {
      const authorised = await http.request(method, path, { token: owner() });
      expect({ path, status: authorised.status }).toEqual({ path, status: 200 });

      const anonymous = await http.request(method, path);
      expect({ path, status: anonymous.status }).toEqual({ path, status: 401 });
    }
  });
});
