/**
 * Integration fixtures.
 *
 * Deliberately independent of `packages/database/prisma/seed.ts`: that is demo
 * data owned by the product and will drift, and a regression baseline must not
 * move underneath the tests that depend on it.
 *
 * Ids are deterministic and prefixed per tenant so failures name the row they
 * came from, and two tenants can coexist without collision — which is what the
 * cross-tenant negative tests need.
 */

import * as bcrypt from 'bcryptjs';

import type { Prisma, PrismaClient } from '@hardware-pos/database';

export interface SeededTenant {
  tenantId: string;
  branchId: string;
  registerId: string;
  ownerId: string;
  managerId: string;
  cashierId: string;
  /** Inventory-tracked product, 100 on hand @ 1000.00. */
  productAId: string;
  /** Inventory-tracked product, 50 on hand @ 250.50. */
  productBId: string;
  /** Non-inventory (Service) product @ 500.00 — stock must never move. */
  serviceProductId: string;
  /** Credit-approved customer, limit 50 000.00. */
  creditCustomerId: string;
  /** Customer with credit explicitly disallowed. */
  cashOnlyCustomerId: string;
}

/**
 * PINs are DISTINCT per role on purpose.
 *
 * `AuthService.findByPin` loads every active PIN user in the tenant and
 * bcrypt-compares in a loop, returning the FIRST match — so if two fixture users
 * shared a PIN, "approve as the manager" would resolve to whichever row PostgreSQL
 * happened to return first and the spec would be flaky. (That first-match-wins
 * behaviour is a real defect, recorded in docs/restaurant-pos/phase-00-audit.md;
 * these fixtures route around it rather than depending on it.)
 */
export const MANAGER_PIN = '1234';
export const CASHIER_PIN = '5678';

/** Cost 4: bcrypt's cost dominates fixture setup time, and nothing here tests it. */
const BCRYPT_COST = 4;

function hashPin(pin: string): string {
  return bcrypt.hashSync(pin, BCRYPT_COST);
}

interface SeedOptions {
  /** Short, unique-per-tenant id prefix, e.g. "tile" or "rest". */
  prefix: string;
  name: string;
  slug: string;
}

/**
 * Create one fully-formed tenant: branch, register, three users, three products,
 * two customers. No `TenantBusinessProfile` row — that model does not exist yet,
 * and its absence is the backward-compatibility contract Phase 1 must preserve.
 */
export async function seedTenant(
  prisma: PrismaClient,
  { prefix, name, slug }: SeedOptions,
): Promise<SeededTenant> {
  const id = (suffix: string) => `${prefix}-${suffix}`;

  const tenantId = id('tenant');
  await prisma.tenant.create({ data: { id: tenantId, name, slug } });

  const branchId = id('branch');
  await prisma.branch.create({
    data: { id: branchId, tenantId, name: 'Main Branch', code: 'MAIN' },
  });

  const registerId = id('register');
  await prisma.register.create({
    data: { id: registerId, tenantId, branchId, name: 'Register 1', code: 'REG1' },
  });

  const users: Prisma.UserCreateManyInput[] = [
    {
      // No PIN: the owner signs in with email + password in production.
      id: id('owner'),
      tenantId,
      branchId,
      role: 'OWNER',
      name: 'Fixture Owner',
      email: `owner@${slug}.test`,
    },
    {
      id: id('manager'),
      tenantId,
      branchId,
      role: 'MANAGER',
      name: 'Fixture Manager',
      email: `manager@${slug}.test`,
      pinHash: hashPin(MANAGER_PIN),
    },
    {
      id: id('cashier'),
      tenantId,
      branchId,
      role: 'CASHIER',
      name: 'Fixture Cashier',
      email: `cashier@${slug}.test`,
      pinHash: hashPin(CASHIER_PIN),
    },
  ];
  await prisma.user.createMany({ data: users });

  const products: Prisma.ProductCreateManyInput[] = [
    {
      id: id('product-a'),
      tenantId,
      name: 'Fixture Product A',
      type: 'Inventory',
      sku: `${prefix}-SKU-A`,
      unitPrice: '1000.00',
      costPrice: '600.00',
      quantityOnHand: '100.000',
    },
    {
      id: id('product-b'),
      tenantId,
      name: 'Fixture Product B',
      type: 'Inventory',
      sku: `${prefix}-SKU-B`,
      unitPrice: '250.50',
      costPrice: '150.00',
      quantityOnHand: '50.000',
    },
    {
      id: id('product-service'),
      tenantId,
      name: 'Fixture Service',
      type: 'Service',
      sku: `${prefix}-SKU-SVC`,
      unitPrice: '500.00',
      quantityOnHand: '0.000',
    },
  ];
  await prisma.product.createMany({ data: products });

  const customers: Prisma.CustomerCreateManyInput[] = [
    {
      id: id('customer-credit'),
      tenantId,
      name: 'Fixture Credit Customer',
      customerType: 'CREDIT',
      creditAllowed: true,
      creditLimit: '50000.00',
    },
    {
      id: id('customer-cash'),
      tenantId,
      name: 'Fixture Cash Customer',
      customerType: 'RETAIL',
      creditAllowed: false,
    },
  ];
  await prisma.customer.createMany({ data: customers });

  return {
    tenantId,
    branchId,
    registerId,
    ownerId: id('owner'),
    managerId: id('manager'),
    cashierId: id('cashier'),
    productAId: id('product-a'),
    productBId: id('product-b'),
    serviceProductId: id('product-service'),
    creditCustomerId: id('customer-credit'),
    cashOnlyCustomerId: id('customer-cash'),
  };
}

/**
 * The QuickBooks retail baseline — the tenant every Tile Shop regression assertion
 * is made against. Has an active QuickBooksConnection so the accounting path is the
 * connected one.
 *
 * Token columns hold opaque placeholders: nothing in these specs decrypts them, and
 * no spec may ever reach Intuit.
 */
export async function seedTileShopWithQuickBooks(prisma: PrismaClient): Promise<SeededTenant> {
  const tenant = await seedTenant(prisma, {
    prefix: 'tile',
    name: 'Fixture Tile Shop',
    slug: 'fixture-tile-shop',
  });

  await prisma.quickBooksConnection.create({
    data: {
      tenantId: tenant.tenantId,
      realmId: '9999999999999999999',
      accessToken: 'fixture-encrypted-access-token',
      refreshToken: 'fixture-encrypted-refresh-token',
      environment: 'sandbox',
      isActive: true,
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000),
    },
  });

  return tenant;
}

/**
 * A second retail tenant with no QuickBooks connection — the cross-tenant negative
 * subject, and (once Phase 1 Slice 4 lands) the tenant that will carry a
 * RESTAURANT / LOCAL / NONE business profile.
 */
export function seedSecondTenant(prisma: PrismaClient): Promise<SeededTenant> {
  return seedTenant(prisma, {
    prefix: 'rest',
    name: 'Fixture Restaurant',
    slug: 'fixture-restaurant',
  });
}

/** Persist tenant settings (the service reads the `branchId: null` row). */
export async function setTenantSettings(
  prisma: PrismaClient,
  tenantId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await prisma.tenantSettings.create({
    data: { tenantId, branchId: null, data: data as Prisma.InputJsonValue },
  });
}
