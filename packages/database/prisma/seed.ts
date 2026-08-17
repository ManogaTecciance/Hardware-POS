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
 * D55 — the platform console's own tenant. It owns no business data; it exists
 * so a cross-tenant operator satisfies `User.tenantId` and reuses the whole
 * auth stack instead of a parallel one. `PlatformBoundaryGuard` refuses their
 * token on every workspace route.
 */
const PLATFORM_TENANT_ID = 'tnt_platform';
const PLATFORM_ADMIN_EMAIL = 'admin@axlopos.test';
const PLATFORM_ADMIN_PASSWORD = 'Platform123!';
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

  /*
   * 2026-08-17: the hardware template staffs an Owner and Cashiers, so the
   * demo does too — the old Manager and Accountant users are gone (and
   * `removeRetiredDemoUsers` below clears them from a re-seeded database, so
   * the console never shows a user whose role no longer exists). The OWNER
   * carries the approval PIN now: in a two-role shop the owner is who answers
   * the in-POS approval prompts (D48: PINs answer prompts, not the login
   * form), and their unlimited discount cap covers everything a manager's did.
   */
  const users = [
    {
      id: 'usr_owner',
      name: 'Owner',
      email: 'owner@hardwarepos.test',
      role: UserRole.OWNER,
      passwordHash: password123 as string | null,
      pinHash: pin2222 as string | null,
      branchId: null as string | null,
    },
    {
      id: 'usr_cashier',
      name: 'Cashier',
      email: 'cashier@hardwarepos.test',
      role: UserRole.CASHIER,
      passwordHash: password123,
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
  const tileRoles = await seedTenantRoles(prisma, tenant.id, 'HARDWARE');

  /*
   * D57: the pilot tenant is classified for real. It ran for months with no
   * profile row, resolving through LEGACY_TENANT_DEFAULTS — verified
   * behaviour-preserving to make explicit, because HARDWARE's default module
   * set is exactly the legacy 13-module list. The seed mirrors what the
   * production backfill script (backfill-pilot-profile.ts) does there.
   */
  await prisma.tenantBusinessProfile.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      businessType: 'HARDWARE',
      ...BUSINESS_PROFILE_PRESETS.HARDWARE,
    },
  });

  const platform = await seedPlatformConsole(await bcrypt.hash(PLATFORM_ADMIN_PASSWORD, SALT_ROUNDS));
  const restaurant = await seedRestaurant(await bcrypt.hash(RESTAURANT_OWNER_PASSWORD, SALT_ROUNDS));
  const restaurantRoles = await seedTenantRoles(prisma, restaurant.id, 'RESTAURANT');

  // Phase 1.5.4: link seeded users to their role rows so a development database
  // exercises DATABASE resolution rather than the legacy fallback. Safe because
  // parity is proven — the rows grant exactly what the enum granted.
  const linked =
    (await linkUsersToRoles(prisma, tenant.id)) + (await linkUsersToRoles(prisma, restaurant.id));

  /*
   * The waiter is the one user whose permissions do NOT come from their enum
   * role. `linkUsersToRoles` only links where the role key matches the enum
   * value, and there is no `UserRole.WAITER` — so a floor waiter would
   * otherwise resolve as a full CASHIER, which carries SALE_READ and would put
   * Sales back in their rail. Link it explicitly.
   */
  const waiterRole = await prisma.role.findFirst({
    where: { tenantId: restaurant.id, key: 'WAITER' },
    select: { id: true },
  });
  if (waiterRole) {
    await prisma.user.update({
      where: { id: 'usr_resto_waiter' },
      data: { roleId: waiterRole.id },
    });
  }

  /*
   * Same reasoning for the restaurant cashier: their enum is CASHIER, but the
   * food-service tenant's cashier row is RESTAURANT_CASHIER (displayed
   * "Cashier"), so `linkUsersToRoles` cannot match it — and an unlinked user
   * shows "Not set" in the platform console.
   */
  const restoCashierRole = await prisma.role.findFirst({
    where: { tenantId: restaurant.id, key: 'RESTAURANT_CASHIER' },
    select: { id: true },
  });
  if (restoCashierRole) {
    await prisma.user.update({
      where: { id: 'usr_resto_cashier' },
      data: { roleId: restoCashierRole.id },
    });
  }

  // 2026-08-17: clear the retired demo users from a database seeded before
  // the role trim. Delete where nothing references them; deactivate where
  // history does — a re-run must converge, not crash.
  for (const id of ['usr_manager', 'usr_accountant']) {
    try {
      await prisma.user.delete({ where: { id } });
    } catch {
      await prisma.user
        .update({ where: { id }, data: { isActive: false } })
        .catch(() => undefined); // absent on a fresh database — nothing to do
    }
  }

  /* eslint-disable no-console */
  console.log('Seeded tenant:', tenant.id);
  console.log(`Seeded ${MOCK_HARDWARE_PRODUCTS.length} products across ${mockCategoryNames().length} categories`);
  console.log('Login users:');
  console.log('  Owner       owner@hardwarepos.test / password123  (approval PIN 2222)');
  console.log('  Cashier     cashier@hardwarepos.test / password123  (approval PIN 1111)');
  console.log('');
  console.log('Seeded tenant:', restaurant.id, '(RESTAURANT · LOCAL inventory · no accounting)');
  console.log('Login users:');
  // The password is deliberately NOT printed. It is a development-only credential
  // documented in docs/restaurant-pos/09-phase-1-acceptance.md; echoing secrets to
  // a terminal is how they end up in scrollback, CI logs and screenshots.
  console.log(`  Owner       ${RESTAURANT_OWNER_EMAIL}   workspace: restaurant-demo`);
  console.log('              password: see docs/restaurant-pos/09-phase-1-acceptance.md');
  console.log('  Cashier     restaurant.cashier@axlopos.test  (approval PIN 3333)');
  console.log('  Waiter      waiter@axlopos.test  (approval PIN 4444) — no Kitchen/Sales/Reports, read-only catalogue');
  console.log('');
  console.log(`\nPlatform console: ${platform.id}`);
  console.log(`  Platform admin  ${PLATFORM_ADMIN_EMAIL} / ${PLATFORM_ADMIN_PASSWORD}`);
  console.log('                  manages workspaces and users; refused every workspace route.\n');

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
/** D55 — the platform console tenant and its first operator. */
async function seedPlatformConsole(passwordHash: string) {
  const tenant = await prisma.tenant.upsert({
    where: { id: PLATFORM_TENANT_ID },
    update: { name: 'Axlo Platform', slug: 'platform' },
    create: { id: PLATFORM_TENANT_ID, name: 'Axlo Platform', slug: 'platform' },
  });
  await prisma.user.upsert({
    where: { id: 'usr_platform_admin' },
    update: {
      name: 'Platform Administrator',
      email: PLATFORM_ADMIN_EMAIL,
      passwordHash,
      isPlatformAdmin: true,
      isActive: true,
    },
    create: {
      id: 'usr_platform_admin',
      tenantId: tenant.id,
      name: 'Platform Administrator',
      email: PLATFORM_ADMIN_EMAIL,
      // The enum role is immaterial — authority comes from `isPlatformAdmin`,
      // and the boundary guard refuses this account every workspace route
      // regardless of what OWNER would otherwise grant.
      role: UserRole.OWNER,
      passwordHash,
      isPlatformAdmin: true,
    },
  });
  return tenant;
}

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
  const pin4444 = await bcrypt.hash('4444', SALT_ROUNDS);
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
    /*
     * A floor waiter. Deliberately created with the CASHIER enum role and then
     * linked to the WAITER custom role below: `linkUsersToRoles` only links a
     * user to a role whose key matches their enum value, and there is no
     * `UserRole.WAITER`, so the link has to be explicit. The WAITER template is
     * what removes Kitchen / Sales / Reports from their rail and makes the
     * catalogue read-only.
     */
    {
      id: 'usr_resto_waiter',
      name: 'Restaurant Waiter',
      email: 'waiter@axlopos.test',
      role: UserRole.CASHIER,
      passwordHash,
      pinHash: pin4444,
      branchId: branch.id,
    },
    // D48: email+password is the only login path; the PIN stays for approvals.
    {
      id: 'usr_resto_cashier',
      name: 'Restaurant Cashier',
      email: 'restaurant.cashier@axlopos.test',
      role: UserRole.CASHIER,
      passwordHash,
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

  // ── The floor ────────────────────────────────────────────────
  //
  // Four areas with genuinely different table shapes, because one area of
  // identical four-tops exercises none of the interesting paths: open tables
  // (D49/D50) need a mix of sizes to join, reservations (D47) need enough
  // tables for a calendar to be legible, and capacity rules need two-tops and
  // ten-tops to differ.
  const areas: Array<{ id: string; name: string; description: string; position: number }> = [
    { id: 'area_resto_main', name: 'Main Hall', description: 'Ground floor, main service', position: 0 },
    { id: 'area_resto_terrace', name: 'Terrace', description: 'Outdoor, weather permitting', position: 1 },
    { id: 'area_resto_bar', name: 'Bar', description: 'High tops and bar rail', position: 2 },
    { id: 'area_resto_private', name: 'Private Room', description: 'Bookable for functions', position: 3 },
  ];
  for (const a of areas) {
    await prisma.diningArea.upsert({
      where: { id: a.id },
      update: { name: a.name, description: a.description, position: a.position, isActive: true },
      create: {
        id: a.id,
        tenantId: tenant.id,
        branchId: branch.id,
        name: a.name,
        description: a.description,
        position: a.position,
        createdByUserId: 'usr_resto_owner',
      },
    });
  }

  const tables: Array<{ id: string; areaId: string; code: string; capacity: number; label?: string }> = [
    // Main Hall — the bulk of the covers, mixed sizes.
    { id: 'tbl_resto_m1', areaId: 'area_resto_main', code: 'M1', capacity: 2 },
    { id: 'tbl_resto_m2', areaId: 'area_resto_main', code: 'M2', capacity: 2 },
    { id: 'tbl_resto_m3', areaId: 'area_resto_main', code: 'M3', capacity: 4 },
    { id: 'tbl_resto_m4', areaId: 'area_resto_main', code: 'M4', capacity: 4 },
    { id: 'tbl_resto_m5', areaId: 'area_resto_main', code: 'M5', capacity: 4 },
    { id: 'tbl_resto_m6', areaId: 'area_resto_main', code: 'M6', capacity: 6 },
    { id: 'tbl_resto_m7', areaId: 'area_resto_main', code: 'M7', capacity: 6 },
    { id: 'tbl_resto_m8', areaId: 'area_resto_main', code: 'M8', capacity: 8, label: 'Long table' },
    // Terrace — smaller, weather-dependent.
    { id: 'tbl_resto_t1', areaId: 'area_resto_terrace', code: 'T1', capacity: 2 },
    { id: 'tbl_resto_t2', areaId: 'area_resto_terrace', code: 'T2', capacity: 2 },
    { id: 'tbl_resto_t3', areaId: 'area_resto_terrace', code: 'T3', capacity: 4 },
    { id: 'tbl_resto_t4', areaId: 'area_resto_terrace', code: 'T4', capacity: 4 },
    { id: 'tbl_resto_t5', areaId: 'area_resto_terrace', code: 'T5', capacity: 6 },
    // Bar — high tops, the natural candidates for joining.
    { id: 'tbl_resto_b1', areaId: 'area_resto_bar', code: 'B1', capacity: 2 },
    { id: 'tbl_resto_b2', areaId: 'area_resto_bar', code: 'B2', capacity: 2 },
    { id: 'tbl_resto_b3', areaId: 'area_resto_bar', code: 'B3', capacity: 3 },
    { id: 'tbl_resto_b4', areaId: 'area_resto_bar', code: 'B4', capacity: 4 },
    // Private room — one big table for functions.
    { id: 'tbl_resto_p1', areaId: 'area_resto_private', code: 'P1', capacity: 10, label: 'Function table' },
    { id: 'tbl_resto_p2', areaId: 'area_resto_private', code: 'P2', capacity: 6 },
  ];
  for (const t of tables) {
    await prisma.restaurantTable.upsert({
      where: { id: t.id },
      update: { code: t.code, capacity: t.capacity, label: t.label ?? null, isActive: true },
      create: {
        id: t.id,
        tenantId: tenant.id,
        branchId: branch.id,
        areaId: t.areaId,
        code: t.code,
        capacity: t.capacity,
        label: t.label ?? null,
        createdByUserId: 'usr_resto_owner',
      },
    });
  }

  // ── Kitchen stations ─────────────────────────────────────────
  const stations = [
    { id: 'kst_resto_kitchen', code: 'KIT', name: 'Main Kitchen', category: 'KITCHEN' },
    { id: 'kst_resto_grill', code: 'GRL', name: 'Grill', category: 'GRILL' },
    { id: 'kst_resto_bar', code: 'BAR', name: 'Bar', category: 'BAR' },
    { id: 'kst_resto_dessert', code: 'DST', name: 'Pastry', category: 'DESSERT' },
  ];
  for (const st of stations) {
    await prisma.kitchenStation.upsert({
      where: { id: st.id },
      update: { name: st.name, category: st.category, isActive: true },
      create: {
        id: st.id,
        tenantId: tenant.id,
        branchId: branch.id,
        code: st.code,
        name: st.name,
        category: st.category,
      },
    });
  }

  // ── The menu ─────────────────────────────────────────────────
  //
  // Products, not MenuItems: D45 made the Product wizard the single authoring
  // surface for a Restaurant tenant, and `GET /restaurant/pos-catalogue` reads
  // Products. `foodType` drives the POS picker's sections, so every row sets
  // one — a catalogue of nulls would collapse into a single "Other" tab.
  const categories = [
    { id: 'cat_resto_starters', name: 'Starters' },
    { id: 'cat_resto_mains', name: 'Mains' },
    { id: 'cat_resto_rice', name: 'Rice & Noodles' },
    { id: 'cat_resto_sides', name: 'Sides' },
    { id: 'cat_resto_desserts', name: 'Desserts' },
    { id: 'cat_resto_hot', name: 'Hot Drinks' },
    { id: 'cat_resto_cold', name: 'Cold Drinks' },
    // Kept: the original id, so re-seeding an existing database does not
    // orphan products that already point at it.
    { id: 'cat_resto_food', name: 'Food' },
  ];
  for (const c of categories) {
    await prisma.productCategory.upsert({
      where: { id: c.id },
      update: { name: c.name, isActive: true },
      create: { id: c.id, tenantId: tenant.id, name: c.name },
    });
  }

  type MenuRow = {
    id: string;
    name: string;
    sku: string;
    price: number;
    cat: string;
    food: 'FOOD' | 'BEVERAGE' | 'DESSERT';
    station: string;
    prep?: number;
    tags?: string[];
  };
  const menu: MenuRow[] = [
    // Starters
    { id: 'prd_resto_10', name: 'Fish Cutlets (4 pc)', sku: 'ST-CUT', price: 650, cat: 'cat_resto_starters', food: 'FOOD', station: 'kst_resto_kitchen', prep: 10 },
    { id: 'prd_resto_11', name: 'Devilled Cashew', sku: 'ST-CSH', price: 850, cat: 'cat_resto_starters', food: 'FOOD', station: 'kst_resto_kitchen', prep: 12, tags: ['Veg'] },
    { id: 'prd_resto_12', name: 'Chicken Wings', sku: 'ST-WNG', price: 1150, cat: 'cat_resto_starters', food: 'FOOD', station: 'kst_resto_grill', prep: 18, tags: ['Spicy'] },
    { id: 'prd_resto_13', name: 'Garlic Bread', sku: 'ST-GRB', price: 450, cat: 'cat_resto_starters', food: 'FOOD', station: 'kst_resto_kitchen', prep: 8, tags: ['Veg'] },
    { id: 'prd_resto_14', name: 'Soup of the Day', sku: 'ST-SOP', price: 550, cat: 'cat_resto_starters', food: 'FOOD', station: 'kst_resto_kitchen', prep: 6, tags: ['Veg'] },
    // Mains
    { id: 'prd_resto_20', name: 'Grilled Seer Fish', sku: 'MN-SEE', price: 2450, cat: 'cat_resto_mains', food: 'FOOD', station: 'kst_resto_grill', prep: 25 },
    { id: 'prd_resto_21', name: 'Chicken Curry', sku: 'MN-CHC', price: 1450, cat: 'cat_resto_mains', food: 'FOOD', station: 'kst_resto_kitchen', prep: 20, tags: ['Spicy'] },
    { id: 'prd_resto_22', name: 'Beef Steak', sku: 'MN-STK', price: 3200, cat: 'cat_resto_mains', food: 'FOOD', station: 'kst_resto_grill', prep: 28 },
    { id: 'prd_resto_23', name: 'Vegetable Curry', sku: 'MN-VEG', price: 1100, cat: 'cat_resto_mains', food: 'FOOD', station: 'kst_resto_kitchen', prep: 18, tags: ['Veg'] },
    { id: 'prd_resto_24', name: 'Prawn Curry', sku: 'MN-PRW', price: 2650, cat: 'cat_resto_mains', food: 'FOOD', station: 'kst_resto_kitchen', prep: 22, tags: ['Spicy'] },
    { id: 'prd_resto_25', name: 'Mixed Grill Platter', sku: 'MN-MGP', price: 3850, cat: 'cat_resto_mains', food: 'FOOD', station: 'kst_resto_grill', prep: 35 },
    // Rice & noodles
    { id: 'prd_resto_1', name: 'Chicken Fried Rice', sku: 'FR-CHK', price: 950, cat: 'cat_resto_rice', food: 'FOOD', station: 'kst_resto_kitchen', prep: 15 },
    { id: 'prd_resto_2', name: 'Kottu Roti', sku: 'KTU-CHK', price: 1100, cat: 'cat_resto_rice', food: 'FOOD', station: 'kst_resto_kitchen', prep: 18, tags: ['Spicy'] },
    { id: 'prd_resto_30', name: 'Seafood Fried Rice', sku: 'FR-SEA', price: 1450, cat: 'cat_resto_rice', food: 'FOOD', station: 'kst_resto_kitchen', prep: 16 },
    { id: 'prd_resto_31', name: 'Vegetable Fried Rice', sku: 'FR-VEG', price: 800, cat: 'cat_resto_rice', food: 'FOOD', station: 'kst_resto_kitchen', prep: 14, tags: ['Veg'] },
    { id: 'prd_resto_32', name: 'Egg Noodles', sku: 'ND-EGG', price: 900, cat: 'cat_resto_rice', food: 'FOOD', station: 'kst_resto_kitchen', prep: 14, tags: ['Egg'] },
    { id: 'prd_resto_33', name: 'Rice & Curry (Chicken)', sku: 'RC-CHK', price: 1250, cat: 'cat_resto_rice', food: 'FOOD', station: 'kst_resto_kitchen', prep: 12, tags: ['Spicy'] },
    // Sides
    { id: 'prd_resto_40', name: 'French Fries', sku: 'SD-FRY', price: 550, cat: 'cat_resto_sides', food: 'FOOD', station: 'kst_resto_kitchen', prep: 8, tags: ['Veg'] },
    { id: 'prd_resto_41', name: 'Papadam (4 pc)', sku: 'SD-PAP', price: 200, cat: 'cat_resto_sides', food: 'FOOD', station: 'kst_resto_kitchen', prep: 4, tags: ['Veg'] },
    { id: 'prd_resto_42', name: 'Garden Salad', sku: 'SD-SAL', price: 650, cat: 'cat_resto_sides', food: 'FOOD', station: 'kst_resto_kitchen', prep: 6, tags: ['Veg', 'Gluten-Free'] },
    { id: 'prd_resto_43', name: 'Steamed Rice', sku: 'SD-RIC', price: 300, cat: 'cat_resto_sides', food: 'FOOD', station: 'kst_resto_kitchen', prep: 5, tags: ['Veg'] },
    // Desserts
    { id: 'prd_resto_50', name: 'Watalappan', sku: 'DS-WAT', price: 600, cat: 'cat_resto_desserts', food: 'DESSERT', station: 'kst_resto_dessert', prep: 5, tags: ['Egg'] },
    { id: 'prd_resto_51', name: 'Chocolate Biscuit Pudding', sku: 'DS-CBP', price: 750, cat: 'cat_resto_desserts', food: 'DESSERT', station: 'kst_resto_dessert', prep: 5 },
    { id: 'prd_resto_52', name: 'Ice Cream (2 scoops)', sku: 'DS-ICE', price: 500, cat: 'cat_resto_desserts', food: 'DESSERT', station: 'kst_resto_dessert', prep: 3 },
    { id: 'prd_resto_53', name: 'Fruit Platter', sku: 'DS-FRT', price: 850, cat: 'cat_resto_desserts', food: 'DESSERT', station: 'kst_resto_dessert', prep: 7, tags: ['Veg', 'Gluten-Free'] },
    // Hot drinks
    { id: 'prd_resto_3', name: 'Plain Tea', sku: 'BEV-TEA', price: 150, cat: 'cat_resto_hot', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 4 },
    { id: 'prd_resto_60', name: 'Milk Tea', sku: 'BEV-MTE', price: 250, cat: 'cat_resto_hot', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 4 },
    { id: 'prd_resto_61', name: 'Black Coffee', sku: 'BEV-COF', price: 300, cat: 'cat_resto_hot', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 4 },
    { id: 'prd_resto_62', name: 'Cappuccino', sku: 'BEV-CAP', price: 550, cat: 'cat_resto_hot', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 6 },
    // Cold drinks
    { id: 'prd_resto_70', name: 'Lime Juice', sku: 'BEV-LIM', price: 350, cat: 'cat_resto_cold', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 5, tags: ['Veg'] },
    { id: 'prd_resto_71', name: 'King Coconut', sku: 'BEV-KCO', price: 400, cat: 'cat_resto_cold', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 3, tags: ['Veg', 'Gluten-Free'] },
    { id: 'prd_resto_72', name: 'Soft Drink (can)', sku: 'BEV-SFT', price: 300, cat: 'cat_resto_cold', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 2 },
    { id: 'prd_resto_73', name: 'Fresh Fruit Juice', sku: 'BEV-FRJ', price: 650, cat: 'cat_resto_cold', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 6, tags: ['Veg'] },
    { id: 'prd_resto_74', name: 'Mineral Water', sku: 'BEV-WAT', price: 150, cat: 'cat_resto_cold', food: 'BEVERAGE', station: 'kst_resto_bar', prep: 1, tags: ['Veg', 'Gluten-Free'] },
  ];

  for (const m of menu) {
    const data = {
      name: m.name,
      sku: m.sku,
      categoryId: m.cat,
      unitPrice: m.price,
      quantityOnHand: 0,
      type: 'NonInventory',
      isActive: true,
      syncStatus: 'NOT_SYNCED' as const,
      foodType: m.food,
      prepMinutes: m.prep ?? null,
      dietaryTags: m.tags ?? [],
    };
    await prisma.product.upsert({
      where: { id: m.id },
      update: data,
      create: { id: m.id, tenantId: tenant.id, ...data },
    });
    // Route every dish to a station. Without this link `generateTicketsForRound`
    // drops the item silently (audit C1), so a seeded menu that looked fine
    // would produce orders the kitchen never sees.
    await prisma.productStationLink.upsert({
      where: { productId_stationId: { productId: m.id, stationId: m.station } },
      update: {},
      create: { productId: m.id, stationId: m.station },
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
