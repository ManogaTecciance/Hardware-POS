/**
 * Development seed — creates two demo tenants, each with a branch/register and the
 * login users described in the docs. Idempotent: safe to run repeatedly.
 *
 * Run with: pnpm db:seed  (from the repo root)
 *
 * ## Two tenants, deliberately unlike each other (Slice 8.9)
 *
 * `tnt_dev` is the hardware store and is left with **no platform profile row**, so
 * a developer's default database exercises the legacy-default path that every
 * existing production tenant is on. `tnt_resto` carries an explicit RESTAURANT
 * profile. Between them, both branches of every profile-dependent screen are
 * reachable without editing the database by hand — which is what made the
 * restaurant navigation testable at all.
 */
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { BUSINESS_PROFILE_PRESETS } from '../src/business-profile-presets';
import { linkUsersToRoles, seedTenantRoles, syncPermissionCatalogue } from '../src/seed-roles';
import { MOCK_HARDWARE_PRODUCTS, mockCategoryId, mockCategoryNames } from '../src/mock-catalog';

const prisma = new PrismaClient();

const TENANT_ID = 'tnt_dev';
const BRANCH_ID = 'brn_dev';
const REGISTER_ID = 'reg_dev';
const SALT_ROUNDS = 10;

const RESTAURANT_TENANT_ID = 'tnt_resto';
/**
 * Development-only credentials for the Restaurant demo tenant.
 *
 * Hashed with the same bcrypt cost as every other seeded user. **Never logged**,
 * and never created outside development: `provision-tenant.ts` is the production
 * path and requires a caller-supplied password or generates a random one.
 */
const RESTAURANT_OWNER_EMAIL = 'restaurant.owner@axlopos.test';
const RESTAURANT_OWNER_PASSWORD = 'Restaurant123!';
const RESTAURANT_BRANCH_ID = 'brn_resto';
const RESTAURANT_REGISTER_ID = 'reg_resto';

async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Demo Hardware Store', slug: 'demo' },
  });

  const branch = await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    update: {},
    create: { id: BRANCH_ID, tenantId: tenant.id, name: 'Main Branch', code: 'MAIN' },
  });

  await prisma.register.upsert({
    where: { id: REGISTER_ID },
    update: {},
    create: { id: REGISTER_ID, tenantId: tenant.id, branchId: branch.id, name: 'Register 1', code: 'R1' },
  });

  const [password123, pin2222, pin1111] = await Promise.all([
    bcrypt.hash('password123', SALT_ROUNDS),
    bcrypt.hash('2222', SALT_ROUNDS),
    bcrypt.hash('1111', SALT_ROUNDS),
  ]);

  const users = [
    {
      id: 'usr_owner',
      name: 'Owner',
      email: 'owner@hardwarepos.test',
      role: UserRole.OWNER,
      passwordHash: password123,
      pinHash: null as string | null,
      branchId: null as string | null,
    },
    {
      id: 'usr_accountant',
      name: 'Accountant',
      email: 'accountant@hardwarepos.test',
      role: UserRole.ACCOUNTANT,
      passwordHash: password123,
      pinHash: null,
      branchId: null,
    },
    {
      id: 'usr_manager',
      name: 'Manager',
      email: null as string | null,
      role: UserRole.MANAGER,
      passwordHash: null as string | null,
      pinHash: pin2222,
      branchId: branch.id,
    },
    {
      id: 'usr_cashier',
      name: 'Cashier',
      email: null,
      role: UserRole.CASHIER,
      passwordHash: null,
      pinHash: pin1111,
      branchId: branch.id,
    },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash,
        branchId: u.branchId,
        isActive: true,
      },
      create: {
        id: u.id,
        tenantId: tenant.id,
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash,
        branchId: u.branchId,
      },
    });
  }

  // Product catalog (mirrors the mock QuickBooks sync so a fresh dev DB has stock).
  for (const name of mockCategoryNames()) {
    const id = mockCategoryId(tenant.id, name);
    await prisma.productCategory.upsert({
      where: { id },
      update: { name, isActive: true },
      create: { id, tenantId: tenant.id, name },
    });
  }

  for (const p of MOCK_HARDWARE_PRODUCTS) {
    const data = {
      name: p.name,
      sku: p.sku,
      categoryId: mockCategoryId(tenant.id, p.category),
      unitPrice: p.unitPrice,
      quantityOnHand: p.quantityOnHand,
      quantityAsOfDate: new Date(),
      type: p.type,
      isActive: true,
      syncStatus: 'SYNCED' as const,
      lastSyncedAt: new Date(),
    };
    await prisma.product.upsert({
      where: { tenantId_quickbooksItemId: { tenantId: tenant.id, quickbooksItemId: p.quickbooksItemId } },
      update: data,
      create: { tenantId: tenant.id, quickbooksItemId: p.quickbooksItemId, ...data },
    });
  }

  // Phase 1.5: the permission catalogue is global; roles are per tenant (D36).
  // Landed inert — nothing resolves authorization from these rows yet.
  const permissionCount = await syncPermissionCatalogue(prisma);
  const tileRoles = await seedTenantRoles(prisma, tenant.id, 'TILE_SHOP');

  const restaurant = await seedRestaurant(await bcrypt.hash(RESTAURANT_OWNER_PASSWORD, SALT_ROUNDS));
  const restaurantRoles = await seedTenantRoles(prisma, restaurant.id, 'RESTAURANT');

  // Phase 1.5.4: link seeded users to their role rows so a development database
  // exercises DATABASE resolution rather than the legacy fallback. Safe because
  // parity is proven — the rows grant exactly what the enum granted.
  const linked =
    (await linkUsersToRoles(prisma, tenant.id)) + (await linkUsersToRoles(prisma, restaurant.id));

  /* eslint-disable no-console */
  console.log('Seeded tenant:', tenant.id);
  console.log(`Seeded ${MOCK_HARDWARE_PRODUCTS.length} products across ${mockCategoryNames().length} categories`);
  console.log('Login users:');
  console.log('  Owner       owner@hardwarepos.test / password123');
  console.log('  Accountant  accountant@hardwarepos.test / password123');
  console.log('  Manager     PIN 2222  (x-tenant-id: ' + tenant.id + ')');
  console.log('  Cashier     PIN 1111  (x-tenant-id: ' + tenant.id + ')');
  console.log('');
  console.log('Seeded tenant:', restaurant.id, '(RESTAURANT · LOCAL inventory · no accounting)');
  console.log('Login users:');
  // The password is deliberately NOT printed. It is a development-only credential
  // documented in docs/restaurant-pos/09-phase-1-acceptance.md; echoing secrets to
  // a terminal is how they end up in scrollback, CI logs and screenshots.
  console.log(`  Owner       ${RESTAURANT_OWNER_EMAIL}   workspace: restaurant-demo`);
  console.log('              password: see docs/restaurant-pos/09-phase-1-acceptance.md');
  console.log('  Cashier     PIN 3333  (x-tenant-id: ' + restaurant.id + ')');
  console.log('');
  console.log(`Permission catalogue: ${permissionCount} keys`);
  console.log(`Roles: ${tileRoles.length} for ${tenant.id}, ${restaurantRoles.length} for ${restaurant.id}`);
  console.log(`Users linked to role rows: ${linked} (these resolve permissions from the database)`);
  /* eslint-enable no-console */
}

/**
 * The restaurant demo tenant.
 *
 * Its products are ordinary catalogue rows with no `quickbooksItemId` and
 * `NOT_SYNCED` status — a LOCAL-inventory tenant has no QuickBooks item to point
 * at, and giving one sample data that looked synced would misrepresent the mode
 * the whole tenant exists to demonstrate. There is no menu, no table and no order:
 * those models do not exist until the Restaurant phases, and the screens say so.
 */
async function seedRestaurant(passwordHash: string) {
  const tenant = await prisma.tenant.upsert({
    where: { id: RESTAURANT_TENANT_ID },
    // The slug IS updated, unlike the Tile Shop's: the Product Owner renamed this
    // workspace after it had already been seeded, and a re-seed that left the old
    // slug in place would make the documented sign-in fail on exactly the machines
    // that had followed the instructions earliest.
    update: { name: 'Axlo Restaurant Demo', slug: 'restaurant-demo' },
    create: { id: RESTAURANT_TENANT_ID, name: 'Axlo Restaurant Demo', slug: 'restaurant-demo' },
  });

  const branch = await prisma.branch.upsert({
    where: { id: RESTAURANT_BRANCH_ID },
    update: {},
    create: { id: RESTAURANT_BRANCH_ID, tenantId: tenant.id, name: 'Main Dining', code: 'MAIN' },
  });

  await prisma.register.upsert({
    where: { id: RESTAURANT_REGISTER_ID },
    update: {},
    create: {
      id: RESTAURANT_REGISTER_ID,
      tenantId: tenant.id,
      branchId: branch.id,
      name: 'Counter 1',
      code: 'C1',
    },
  });

  // The profile is upserted rather than created so re-seeding repairs a
  // hand-edited row; `version` is left to the API, which owns it.
  const profile = { businessType: 'RESTAURANT' as const, ...BUSINESS_PROFILE_PRESETS.RESTAURANT };
  await prisma.tenantBusinessProfile.upsert({
    where: { tenantId: tenant.id },
    update: profile,
    create: { tenantId: tenant.id, ...profile },
  });

  const pin3333 = await bcrypt.hash('3333', SALT_ROUNDS);
  const users = [
    {
      id: 'usr_resto_owner',
      name: 'Restaurant Owner',
      email: RESTAURANT_OWNER_EMAIL as string | null,
      role: UserRole.OWNER,
      passwordHash: passwordHash as string | null,
      pinHash: null as string | null,
      branchId: null as string | null,
    },
    {
      id: 'usr_resto_cashier',
      name: 'Restaurant Cashier',
      email: null,
      role: UserRole.CASHIER,
      passwordHash: null,
      pinHash: pin3333,
      branchId: branch.id,
    },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash,
        branchId: u.branchId,
        isActive: true,
      },
      create: {
        id: u.id,
        tenantId: tenant.id,
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash,
        branchId: u.branchId,
      },
    });
  }

  const category = await prisma.productCategory.upsert({
    where: { id: 'cat_resto_food' },
    update: { name: 'Food', isActive: true },
    create: { id: 'cat_resto_food', tenantId: tenant.id, name: 'Food' },
  });

  const products = [
    { id: 'prd_resto_1', name: 'Chicken Fried Rice', sku: 'FR-CHK', unitPrice: 950 },
    { id: 'prd_resto_2', name: 'Kottu Roti', sku: 'KTU-CHK', unitPrice: 1100 },
    { id: 'prd_resto_3', name: 'Plain Tea', sku: 'BEV-TEA', unitPrice: 150 },
  ];

  for (const p of products) {
    const data = {
      name: p.name,
      sku: p.sku,
      categoryId: category.id,
      unitPrice: p.unitPrice,
      quantityOnHand: 0,
      type: 'NonInventory',
      isActive: true,
      syncStatus: 'NOT_SYNCED' as const,
    };
    await prisma.product.upsert({
      where: { id: p.id },
      update: data,
      create: { id: p.id, tenantId: tenant.id, ...data },
    });
  }

  return tenant;
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
