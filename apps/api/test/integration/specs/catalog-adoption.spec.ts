/**
 * Slice 6C-B — product catalogue synchronisation now goes through
 * `CatalogSyncProvider`, and unsupported profile combinations are refused at
 * configuration time.
 *
 * Written to the Slice 6C-A.5 non-vacuous standard throughout: every negative has a
 * positive control, the provider is observed at runtime rather than inferred from a
 * quantity, and the unsupported-combination block enumerates the **entire**
 * `InventoryMode × AccountingProviderKind` space rather than the handful of pairs
 * that happened to come to mind.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  type PrismaClient,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { BusinessProfileService } from '../../../src/modules/platform/business-profile.service';
import { UnsupportedProfileCombinationError } from '../../../src/modules/platform/platform.errors';
import {
  SUPPORTED_PROFILE_COMBINATIONS,
  isSupportedProfileCombination,
} from '../../../src/modules/platform/profile-combinations';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { ProductsService } from '../../../src/modules/products/products.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { CatalogSyncProviderFactory } from '../../../src/modules/providers/catalog/catalog-sync-provider.factory';
import { ProviderOperationUnavailableError } from '../../../src/modules/providers/provider.errors';
import { UpdateBusinessProfileDto } from '../../../src/modules/platform/dto/update-business-profile.dto';
import { CreateProductDto } from '../../../src/modules/products/dto/create-product.dto';
import { UpdateProductDto } from '../../../src/modules/products/dto/update-product.dto';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let products: ProductsService;
let sales: SalesService;
let catalogFactory: CatalogSyncProviderFactory;
let profiles: BusinessProfileService;
let tile: SeededTenant;
let other: SeededTenant;
let owner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProductsModule,
      SalesModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  products = testModule.get(ProductsService);
  sales = testModule.get(SalesService);
  catalogFactory = testModule.get(CatalogSyncProviderFactory);
  profiles = testModule.get(BusinessProfileService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  other = await seedSecondTenant(prisma);
  owner = { id: tile.ownerId, tenantId: tile.tenantId, role: 'OWNER' , activeBranchId: null };
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function giveProfile(
  tenant: SeededTenant,
  inventoryMode: InventoryMode,
  accountingProvider: AccountingProviderKind,
): Promise<void> {
  await prisma.tenantBusinessProfile.upsert({
    where: { tenantId: tenant.tenantId },
    update: { inventoryMode, accountingProvider },
    create: {
      tenantId: tenant.tenantId,
      businessType: BusinessType.RESTAURANT,
      inventoryMode,
      accountingProvider,
    },
  });
}

/** Disconnect QuickBooks so `enqueueProductSync` reports "not connected". */
function disconnectQuickBooks(tenant: SeededTenant) {
  return prisma.quickBooksConnection.updateMany({
    where: { tenantId: tenant.tenantId },
    data: { isActive: false },
  });
}

function newProduct(name = 'Catalogue Widget', sku = 'CAT-1') {
  return dto(CreateProductDto, { name, sku, type: 'Inventory', unitPrice: 250, quantityOnHand: 10 });
}

function productJobs(productId: string) {
  return prisma.syncJob.findMany({ where: { entityType: 'PRODUCT', entityId: productId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4-13 — QuickBooks compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('4-13 — legacy and explicit QUICKBOOKS catalogue behaviour is unchanged', () => {
  it('4/9/11 — creating a product enqueues a push and marks it PENDING', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    expect(created.syncStatus).toBe('PENDING');
    const jobs = await productJobs(created.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('PRODUCT_SYNC');
    expect(jobs[0].direction).toBe('OUTBOUND');
    expect(jobs[0].status).toBe('PENDING');
    expect(jobs[0].entityType).toBe('PRODUCT');
    // POSITIVE CONTROL: no profile row involved — this is the legacy default path.
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it('4 — with QuickBooks disconnected, the product is kept and stays NOT_SYNCED', async () => {
    await disconnectQuickBooks(tile);

    const created = await products.create(tile.tenantId, newProduct());

    expect(created.syncStatus).toBe('NOT_SYNCED');
    expect(await productJobs(created.id)).toHaveLength(0);
    // The local product still exists and is usable — today's behaviour exactly.
    expect(await prisma.product.findUnique({ where: { id: created.id } })).not.toBeNull();
  });

  it('5 — updating a mirrored field on a LINKED product enqueues a push', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await prisma.product.update({
      where: { id: created.id },
      data: { quickbooksItemId: 'QBO-ITEM-1', syncStatus: 'SYNCED' },
    });
    await prisma.syncJob.deleteMany({});

    const updated = await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { name: 'Renamed Widget' }),
      'OWNER',
    );

    expect(updated.syncStatus).toBe('PENDING');
    expect(await productJobs(created.id)).toHaveLength(1);
  });

  it('5 — updating a NON-mirrored field enqueues nothing and leaves the status alone', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await prisma.product.update({
      where: { id: created.id },
      data: { quickbooksItemId: 'QBO-ITEM-1', syncStatus: 'SYNCED' },
    });
    await prisma.syncJob.deleteMany({});

    const updated = await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { reorderLevel: 7 }),
      'OWNER',
    );

    expect(updated.syncStatus).toBe('SYNCED');
    expect(await productJobs(created.id)).toHaveLength(0);
    // POSITIVE CONTROL: the update really did happen.
    expect(Number(updated.reorderLevel)).toBe(7);
  });

  it('5 — updating an UNLINKED product enqueues nothing', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await prisma.syncJob.deleteMany({});
    expect(created.quickbooksItemId).toBeNull();

    const updated = await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { name: 'Renamed' }),
      'OWNER',
    );

    expect(await productJobs(created.id)).toHaveLength(0);
    expect(updated.name).toBe('Renamed');
  });

  it('12 — the QuickBooks-managed stock rule keeps its exact wording', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await prisma.product.update({
      where: { id: created.id },
      data: { quickbooksItemId: 'QBO-ITEM-1' },
    });

    await expect(
      products.update(tile.tenantId, created.id, dto(UpdateProductDto, { quantityOnHand: 99 }), 'CASHIER'),
    ).rejects.toThrow(
      'Stock for QuickBooks-managed products is controlled by QuickBooks. Ask an owner/admin to override.',
    );
  });

  it('6 — deactivating a LINKED product enqueues a push; an unlinked one does not', async () => {
    const linked = await products.create(tile.tenantId, newProduct('Linked', 'L-1'));
    await prisma.product.update({
      where: { id: linked.id },
      data: { quickbooksItemId: 'QBO-ITEM-1' },
    });
    const unlinked = await products.create(tile.tenantId, newProduct('Unlinked', 'U-1'));
    await prisma.syncJob.deleteMany({});

    const deactivatedLinked = await products.deactivate(tile.tenantId, linked.id);
    const deactivatedUnlinked = await products.deactivate(tile.tenantId, unlinked.id);

    expect(deactivatedLinked.isActive).toBe(false);
    expect(deactivatedUnlinked.isActive).toBe(false);
    expect(await productJobs(linked.id)).toHaveLength(1);
    expect(await productJobs(unlinked.id)).toHaveLength(0);
  });

  it('7 — the explicit sync endpoint enqueues and marks PENDING', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await prisma.syncJob.deleteMany({});

    const synced = await products.syncToQuickBooks(tile.tenantId, created.id);

    expect(synced.syncStatus).toBe('PENDING');
    expect(await productJobs(created.id)).toHaveLength(1);
  });

  it('7/12 — the explicit endpoint keeps its "not connected" wording', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await disconnectQuickBooks(tile);

    await expect(products.syncToQuickBooks(tile.tenantId, created.id)).rejects.toThrow(
      'QuickBooks is not connected',
    );
  });

  it('8 — the catalogue refresh still runs and reports a summary', async () => {
    const summary = await products.mockSync(tile.tenantId);

    expect(summary).toBeDefined();
    expect(typeof summary).toBe('object');
  });

  it('13 — an explicit QUICKBOOKS profile matches the legacy tenant exactly', async () => {
    const legacy = await products.create(tile.tenantId, newProduct('Legacy', 'LEG-1'));
    const legacyJobs = await productJobs(legacy.id);

    await giveProfile(tile, InventoryMode.QUICKBOOKS, AccountingProviderKind.QUICKBOOKS);
    const explicit = await products.create(tile.tenantId, newProduct('Explicit', 'EXP-1'));
    const explicitJobs = await productJobs(explicit.id);

    expect(explicit.syncStatus).toBe(legacy.syncStatus);
    expect(explicitJobs).toHaveLength(legacyJobs.length);
    const shape = (j: (typeof legacyJobs)[number]) => ({
      type: j.type,
      direction: j.direction,
      entityType: j.entityType,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError,
    });
    expect(shape(explicitJobs[0])).toEqual(shape(legacyJobs[0]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14-21 — LOCAL catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe('14-21 — LOCAL inventory means no external catalogue', () => {
  beforeEach(async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
  });

  it('14/15/16/20 — creation succeeds locally with no sync rows and no fabricated item id', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Catalogue Widget');
    expect(created.isActive).toBe(true);
    expect(created.syncStatus).toBe('NOT_SYNCED');
    expect(created.quickbooksItemId).toBeNull();
    expect(await productJobs(created.id)).toHaveLength(0);
    expect(await prisma.syncLog.count()).toBe(0);
    expect(JSON.stringify(created)).not.toMatch(/QBO-/);
  });

  it('17 — an update creates no QuickBooks work', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    const updated = await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { name: 'Renamed', unitPrice: 999 }),
      'OWNER',
    );

    expect(updated.name).toBe('Renamed');
    expect(Number(updated.unitPrice)).toBe(999);
    expect(updated.syncStatus).toBe('NOT_SYNCED');
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('17 — stock is editable by a CASHIER, because no external system owns it', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    const updated = await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { quantityOnHand: 42 }),
      'CASHIER',
    );

    expect(Number(updated.quantityOnHand)).toBe(42);
  });

  it('18 — deactivation creates no QuickBooks work', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    const deactivated = await products.deactivate(tile.tenantId, created.id);

    expect(deactivated.isActive).toBe(false);
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('19 — a locally created product is immediately sellable', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: created.id, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 500 }],
    });

    expect(sale.status).toBe('COMPLETED');
    const after = await prisma.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(Number(after.quantityOnHand)).toBe(8);
  });

  it('21 — the explicit sync endpoint is refused, not silently accepted', async () => {
    const created = await products.create(tile.tenantId, newProduct());

    await expect(products.syncToQuickBooks(tile.tenantId, created.id)).rejects.toThrow(
      ProviderOperationUnavailableError,
    );
    await expect(products.syncToQuickBooks(tile.tenantId, created.id)).rejects.toThrow(
      "does not support 'pushing a product to an external catalogue'",
    );
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('21 — the catalogue refresh is refused too', async () => {
    await expect(products.mockSync(tile.tenantId)).rejects.toThrow(
      "does not support 'refreshing from an external catalogue'",
    );
  });

  it('21 — the refusal names no credential, realm or connection detail', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    try {
      await products.syncToQuickBooks(tile.tenantId, created.id);
      fail('expected a refusal');
    } catch (err) {
      const message = (err as Error).message;
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/token|realm|secret|password|client_id|localhost|postgres/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22-26 — DISABLED catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe('22-26 — DISABLED inventory keeps a catalogue but no stock and no sync', () => {
  beforeEach(async () => {
    await giveProfile(tile, InventoryMode.DISABLED, AccountingProviderKind.NONE);
  });

  it('22 — creation succeeds', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    expect(created.id).toBeTruthy();
    expect(created.syncStatus).toBe('NOT_SYNCED');
  });

  it('23 — update succeeds', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    const updated = await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { name: 'Menu Item' }),
      'OWNER',
    );
    expect(updated.name).toBe('Menu Item');
  });

  it('24 — deactivation succeeds', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    expect((await products.deactivate(tile.tenantId, created.id)).isActive).toBe(false);
  });

  it('25 — selling it mutates no stock', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    const before = Number(created.quantityOnHand);

    await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: created.id, quantity: 1000 }],
      payments: [{ method: 'CASH', amount: 250_000 }],
    });

    const after = await prisma.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(Number(after.quantityOnHand)).toBe(before);
  });

  it('26 — no QuickBooks product work at all, across the whole lifecycle', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    await products.update(tile.tenantId, created.id, dto(UpdateProductDto, { name: 'X' }), 'OWNER');
    await products.deactivate(tile.tenantId, created.id);

    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
    // POSITIVE CONTROL: three operations really did happen.
    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.name).toBe('X');
    expect(row.isActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27-35 — supported profile combinations
// ─────────────────────────────────────────────────────────────────────────────

describe('27-35 — unsupported profile combinations are refused at configuration time', () => {
  const ALL_MODES = Object.values(InventoryMode);
  const ALL_PROVIDERS = Object.values(AccountingProviderKind);

  async function attempt(inventoryMode: InventoryMode, accountingProvider: AccountingProviderKind) {
    return profiles.updateProfile(
      other.tenantId,
      dto(UpdateBusinessProfileDto, { inventoryMode, accountingProvider }),
    );
  }

  it('33/34/35 — every supported pair is accepted', async () => {
    for (const combo of SUPPORTED_PROFILE_COMBINATIONS) {
      await resetDatabase(prisma);
      tile = await seedTileShopWithQuickBooks(prisma);
      other = await seedSecondTenant(prisma);

      const next = await attempt(combo.inventoryMode, combo.accountingProvider);
      expect(next.inventoryMode).toBe(combo.inventoryMode);
      expect(next.accountingProvider).toBe(combo.accountingProvider);
    }
    // POSITIVE CONTROL: the list is not empty, so the loop proved something.
    expect(SUPPORTED_PROFILE_COMBINATIONS.length).toBe(3);
  });

  /**
   * The whole space, not a hand-picked list. 4 modes × 3 providers = 12 pairs; the
   * 3 supported ones are accepted and the other 9 refused, which covers
   * requirements 27-31 without depending on anyone remembering them.
   */
  it('27-31 — every UNSUPPORTED pair in the whole space is refused', async () => {
    const refused: string[] = [];
    for (const inventoryMode of ALL_MODES) {
      for (const accountingProvider of ALL_PROVIDERS) {
        if (isSupportedProfileCombination(inventoryMode, accountingProvider)) continue;
        await expect(attempt(inventoryMode, accountingProvider)).rejects.toThrow(
          UnsupportedProfileCombinationError,
        );
        refused.push(`${inventoryMode}+${accountingProvider}`);
      }
    }

    expect(refused).toHaveLength(ALL_MODES.length * ALL_PROVIDERS.length - 3);
    // Named explicitly so the PO's numbered requirements are visibly covered.
    expect(refused).toContain('LOCAL+QUICKBOOKS'); // 28
    expect(refused).toContain('DISABLED+QUICKBOOKS'); // 29
    expect(refused).toContain('QUICKBOOKS+NONE'); // 30
    expect(refused).toContain('EXTERNAL+QUICKBOOKS'); // 27
    expect(refused).toContain('EXTERNAL+NONE'); // 27
    expect(refused).toContain('LOCAL+FUTURE_EXTERNAL'); // 31
  });

  it('a refusal writes nothing at all', async () => {
    await expect(attempt(InventoryMode.LOCAL, AccountingProviderKind.QUICKBOOKS)).rejects.toThrow();
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it('32 — a legacy tenant remains valid and resolves to the supported QuickBooks pair', async () => {
    const profile = await profiles.getEffectiveProfile(tile.tenantId);

    expect(profile.source).toBe('LEGACY_DEFAULT');
    expect(isSupportedProfileCombination(profile.inventoryMode, profile.accountingProvider)).toBe(
      true,
    );
    expect(profile.inventoryMode).toBe(InventoryMode.QUICKBOOKS);
    expect(profile.accountingProvider).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('validates the RESULTING pair, not just the fields sent', async () => {
    await profiles.updateProfile(
      other.tenantId,
      dto(UpdateBusinessProfileDto, {
        inventoryMode: 'LOCAL',
        accountingProvider: 'NONE',
      }),
    );

    // Changing only accounting would leave LOCAL + QUICKBOOKS behind.
    await expect(
      profiles.updateProfile(
        other.tenantId,
        dto(UpdateBusinessProfileDto, { accountingProvider: 'QUICKBOOKS' }),
      ),
    ).rejects.toThrow(UnsupportedProfileCombinationError);

    expect((await profiles.getEffectiveProfile(other.tenantId)).accountingProvider).toBe(
      AccountingProviderKind.NONE,
    );
  });

  it('a write that changes neither field is still allowed', async () => {
    await profiles.updateProfile(
      other.tenantId,
      dto(UpdateBusinessProfileDto, { inventoryMode: 'LOCAL', accountingProvider: 'NONE' }),
    );

    const next = await profiles.updateProfile(
      other.tenantId,
      dto(UpdateBusinessProfileDto, { businessType: 'CAFE' }),
    );

    expect(next.businessType).toBe(BusinessType.CAFE);
    expect(next.inventoryMode).toBe(InventoryMode.LOCAL);
  });

  it('the error names only modes and providers, never integration detail', async () => {
    try {
      await attempt(InventoryMode.LOCAL, AccountingProviderKind.QUICKBOOKS);
      fail('expected a refusal');
    } catch (err) {
      const e = err as UnsupportedProfileCombinationError;
      expect(e.getStatus()).toBe(400);
      expect(e.code).toBe('PLATFORM_PROFILE_COMBINATION_UNSUPPORTED');
      expect(e.message).toContain('LOCAL');
      expect(e.message).toContain('QUICKBOOKS');
      expect(e.message).toContain('Supported combinations are');
      expect(e.message).not.toMatch(/token|realm|secret|password|localhost|postgres|:\/\//i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 36-41 — security, isolation and runtime provider observation
// ─────────────────────────────────────────────────────────────────────────────

describe('36-41 — isolation and provider observation', () => {
  it('36 — tenant A cannot sync tenant B’s product', async () => {
    const mine = await products.create(tile.tenantId, newProduct());

    await expect(products.syncToQuickBooks(other.tenantId, mine.id)).rejects.toThrow(
      `Product ${mine.id} not found`,
    );
    // POSITIVE CONTROL: the same call works for the owning tenant.
    await expect(products.syncToQuickBooks(tile.tenantId, mine.id)).resolves.toBeDefined();
  });

  it('36 — tenant A cannot update or deactivate tenant B’s product', async () => {
    const mine = await products.create(tile.tenantId, newProduct());

    await expect(
      products.update(other.tenantId, mine.id, dto(UpdateProductDto, { name: 'Hijacked' }), 'OWNER'),
    ).rejects.toThrow(`Product ${mine.id} not found`);
    await expect(products.deactivate(other.tenantId, mine.id)).rejects.toThrow(
      `Product ${mine.id} not found`,
    );

    const row = await prisma.product.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.name).toBe('Catalogue Widget');
    expect(row.isActive).toBe(true);
  });

  it('37/38 — a client cannot override inventoryMode or accountingProvider via the product payload', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);

    const created = await products.create(
      tile.tenantId,
      dto(CreateProductDto, {
        name: 'Forged',
        sku: 'F-1',
        type: 'Inventory',
        unitPrice: 100,
        // Ignored: not declared on the DTO, and `forbidNonWhitelisted` rejects them
        // at the pipe. The provider comes from the authenticated tenant's profile.
        inventoryMode: 'QUICKBOOKS',
        accountingProvider: 'QUICKBOOKS',
        syncStatus: 'SYNCED',
        quickbooksItemId: 'QBO-FORGED',
      } as Record<string, unknown>),
    );

    expect(created.syncStatus).toBe('NOT_SYNCED');
    expect(created.quickbooksItemId).toBeNull();
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('39 — provider resolution uses the authenticated tenant, so two tenants differ', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);

    expect((await catalogFactory.forTenant(tile.tenantId)).name).toBe('No external catalogue');
    // `other` has no profile row → legacy QuickBooks default. Two tenants, two
    // providers, from the same factory in the same process.
    expect((await catalogFactory.forTenant(other.tenantId)).name).toBe('QuickBooks catalogue');
  });

  it('39 — one tenant on LOCAL does not stop the other enqueuing', async () => {
    // `other` gets LOCAL; `tile` stays on the legacy QuickBooks default AND is the
    // tenant with a connected QuickBooks company, which is what makes an enqueue
    // succeed. (`seedSecondTenant` has no connection, so it could never enqueue —
    // testing it the other way round would have proved nothing.)
    await giveProfile(other, InventoryMode.LOCAL, AccountingProviderKind.NONE);

    const localProduct = await products.create(other.tenantId, newProduct('Local', 'L-9'));
    const qbProduct = await products.create(tile.tenantId, newProduct('QB', 'Q-9'));

    expect(await productJobs(localProduct.id)).toHaveLength(0);
    expect(await productJobs(qbProduct.id)).toHaveLength(1);
  });

  it('40 — a failed enqueue preserves existing QuickBooks behaviour: product kept, status untouched', async () => {
    const catalog = await catalogFactory.forTenant(tile.tenantId);
    jest
      .spyOn(catalog, 'productCreated')
      .mockResolvedValue({ disposition: 'NOT_CONNECTED', provider: 'QUICKBOOKS' });
    jest.spyOn(catalogFactory, 'forTenant').mockResolvedValue(catalog);

    const created = await products.create(tile.tenantId, newProduct());

    expect(created.id).toBeTruthy();
    expect(created.syncStatus).toBe('NOT_SYNCED');
  });

  it('41 — NoCatalogSyncProvider has no injected dependency, so it cannot make a call', async () => {
    await giveProfile(tile, InventoryMode.DISABLED, AccountingProviderKind.NONE);
    const catalog = await catalogFactory.forTenant(tile.tenantId);

    const injected = Object.values(catalog as unknown as Record<string, unknown>).filter(
      (v) => v && typeof v === 'object',
    );
    expect(injected).toEqual([]);
    // POSITIVE CONTROL: the QuickBooks provider DOES have one, so the probe works.
    const quickbooks = await catalogFactory.forTenant(other.tenantId);
    expect(
      Object.values(quickbooks as unknown as Record<string, unknown>).filter(
        (v) => v && typeof v === 'object',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('the provider is genuinely invoked on create, update and deactivate', async () => {
    const catalog = await catalogFactory.forTenant(tile.tenantId);
    const created$ = jest.spyOn(catalog, 'productCreated');
    const updated$ = jest.spyOn(catalog, 'productUpdated');
    const deactivated$ = jest.spyOn(catalog, 'productDeactivated');
    jest.spyOn(catalogFactory, 'forTenant').mockResolvedValue(catalog);

    const created = await products.create(tile.tenantId, newProduct());
    await products.update(tile.tenantId, created.id, dto(UpdateProductDto, { name: 'N' }), 'OWNER');
    await products.deactivate(tile.tenantId, created.id);

    expect(created$).toHaveBeenCalledTimes(1);
    expect(updated$).toHaveBeenCalledTimes(1);
    expect(deactivated$).toHaveBeenCalledTimes(1);

    // The context comes from the authenticated tenant, and the shape is narrowed —
    // no quantity, no image, no category reaches the catalogue layer.
    expect(created$.mock.calls[0][0]).toEqual({ tenantId: tile.tenantId, branchId: null });
    expect(Object.keys(created$.mock.calls[0][1]).sort()).toEqual([
      'costPrice',
      'description',
      'externalItemId',
      'id',
      'isActive',
      'name',
      'purchaseDescription',
      'sku',
      'type',
      'unitPrice',
    ]);
  });

  it('the update hook receives BOTH rows, which is what the mirrored-field rule needs', async () => {
    const created = await products.create(tile.tenantId, newProduct());
    const catalog = await catalogFactory.forTenant(tile.tenantId);
    const spy = jest.spyOn(catalog, 'productUpdated');
    jest.spyOn(catalogFactory, 'forTenant').mockResolvedValue(catalog);

    await products.update(
      tile.tenantId,
      created.id,
      dto(UpdateProductDto, { name: 'After' }),
      'OWNER',
    );

    const [, before, after] = spy.mock.calls[0];
    expect(before.name).toBe('Catalogue Widget');
    expect(after.name).toBe('After');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 42-47 — scope control
// ─────────────────────────────────────────────────────────────────────────────

describe('42-47 — Slice 6C-B changed nothing outside the product catalogue', () => {
  it('42 — sale inventory adoption is unchanged', async () => {
    const before = await prisma.product
      .findUniqueOrThrow({ where: { id: tile.productAId } })
      .then((p) => Number(p.quantityOnHand));

    await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: tile.productAId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 2000 }],
    });

    const after = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(after.quantityOnHand)).toBe(before - 2);
  });

  it('44/45 — no BranchInventory and no Restaurant model exists', () => {
    const client = prisma as unknown as Record<string, unknown>;
    for (const model of [
      'branchInventory',
      'inventoryMovement',
      'restaurantOrder',
      'menu',
      'menuItem',
      'kitchenTicket',
      'diningArea',
    ]) {
      expect(client[model]).toBeUndefined();
    }
    // POSITIVE CONTROL: the probe finds the models that do exist.
    expect(typeof client.product).toBe('object');
    expect(typeof client.tenantBusinessProfile).toBe('object');
  });

  it('46 — Product.syncStatus still uses its existing values, unredefined', async () => {
    const values = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `select e.enumlabel from pg_enum e
        join pg_type t on t.oid = e.enumtypid
        where t.typname = 'SyncStatus' order by e.enumsortorder`,
    );
    expect(values.map((v) => v.enumlabel)).toEqual([
      'NOT_SYNCED',
      'PENDING',
      'SYNCING',
      'SYNCED',
      'FAILED',
    ]);
  });
});
