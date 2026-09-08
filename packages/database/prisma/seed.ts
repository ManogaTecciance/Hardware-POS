/**
 * Development seed — creates a demo tenant, a branch/register, and the login
 * users described in the docs. Idempotent: safe to run repeatedly.
 *
 * Run with: pnpm db:seed  (from the repo root)
 */
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { MOCK_HARDWARE_PRODUCTS, mockCategoryId, mockCategoryNames } from '../src/mock-catalog';

const prisma = new PrismaClient();

const TENANT_ID = 'tnt_dev';
const BRANCH_ID = 'brn_dev';
const REGISTER_ID = 'reg_dev';
const SALT_ROUNDS = 10;

async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Demo Hardware Store', slug: 'demo' },
  });

  // Pin the shop timezone explicitly, matching what provisioning and the
  // backfill migration do, so a seeded tenant is not the odd one out.
  const existingSettings = await prisma.tenantSettings.findFirst({
    where: { tenantId: tenant.id, branchId: null },
    select: { id: true },
  });
  if (!existingSettings) {
    await prisma.tenantSettings.create({
      data: { tenantId: tenant.id, branchId: null, data: { timezone: 'Asia/Colombo' } },
    });
  }

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
      // Owner-equivalent role, so it mirrors the owner's credentials exactly:
      // email + password, no PIN. A 4-digit PIN is a weak credential for an
      // account holding every permission, and `POST /auth/pin-login` is public.
      id: 'usr_salesperson',
      name: 'Salesperson',
      email: 'salesperson@hardwarepos.test',
      role: UserRole.SALESPERSON,
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

  /* eslint-disable no-console */
  console.log('Seeded tenant:', tenant.id);
  console.log(`Seeded ${MOCK_HARDWARE_PRODUCTS.length} products across ${mockCategoryNames().length} categories`);
  console.log('Login users:');
  console.log('  Owner       owner@hardwarepos.test / password123');
  console.log('  Accountant  accountant@hardwarepos.test / password123');
  console.log('  Salesperson salesperson@hardwarepos.test / password123');
  console.log('  Manager     PIN 2222  (x-tenant-id: ' + tenant.id + ')');
  console.log('  Cashier     PIN 1111  (x-tenant-id: ' + tenant.id + ')');
  /* eslint-enable no-console */
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
