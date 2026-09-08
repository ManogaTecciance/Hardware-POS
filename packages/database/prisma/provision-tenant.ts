/**
 * Production tenant provisioning — creates a NEW company (tenant) with a main
 * branch, one register, and its initial users. Unlike the dev seed it creates
 * no catalog or sample data, and it refuses to touch anything that already
 * exists (fresh accounts only — rerunning with the same slug aborts).
 *
 * Run from the repo root (DATABASE_URL comes from packages/database/.env):
 *
 *   pnpm --filter @hardware-pos/database exec tsx prisma/provision-tenant.ts \
 *     --name "Colombawa Plantation Pvt Ltd" \
 *     --slug colombawa \
 *     --business-type RESTAURANT \
 *     --user "Colombawa1:colombawa1@example.com:OWNER:TheirPassword123:9876" \
 *     --user "Colombawa2:colombawa2@example.com:CASHIER::1234"
 *
 * Each --user is "Name:email:ROLE[:password[:pin]]". When the password is
 * omitted (or left empty, as in "ROLE::1234") a random one is generated and
 * printed once at the end — record it immediately. The optional PIN (4–6
 * digits) feeds the in-POS approval prompts: any user whose role carries the
 * approve permission (owner, admin, salesperson, manager) can answer a
 * "manager PIN" request with their own PIN.
 *
 * `--business-type` (Slice 8.9) writes an explicit platform profile, which is what
 * decides the tenant's navigation, its inventory authority and whether QuickBooks
 * exists for it at all. Omitting it writes **no profile row**, exactly as this
 * script did before — such a tenant resolves to the legacy Tile Shop / QuickBooks
 * configuration, which stays the default so provisioning a retail company keeps
 * behaving as it always has. A restaurant must pass it: there is no way to infer
 * "this company serves food" from a name.
 *
 * The business type also decides which ROLES the tenant is seeded with, and a
 * `--user` may only name one of them: a hardware (or no-profile, D57) tenant
 * offers OWNER, SALESPERSON and CASHIER; a food-service one OWNER, WAITER,
 * RESTAURANT_CASHIER and KITCHEN_STAFF; a hotel OWNER, WAITER and RECEPTIONIST.
 * Every user is linked to their role ROW on creation (D108), so nobody
 * provisioned here starts on the legacy enum fallback. The enum column is
 * derived from the row the same way the platform console does it.
 */
import { randomBytes } from 'node:crypto';

import { BusinessType, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { baseUserRoleFor, roleTemplatesForBusinessType } from '@hardware-pos/shared';

import { BUSINESS_PROFILE_PRESETS } from '../src/business-profile-presets';
import { linkUsersToRoles, seedTenantRoles, syncPermissionCatalogue } from '../src/seed-roles';
import { seedClothingPack } from '../src/seed-packs/clothing';

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;
/** Sri Lanka — where the business trades, and the zone its documents are dated in. */
const SHOP_TIME_ZONE = 'Asia/Colombo';

interface UserSpec {
  name: string;
  email: string;
  /** The role ROW's key — a template key of the tenant's business type. */
  roleKey: string;
  /**
   * The enum column underneath, derived by the shared `baseUserRoleFor` — the
   * same function the platform console and the tenant-facing role assignment
   * use: a built-in key is its own enum value, anything else is CASHIER.
   */
  role: UserRole;
  password: string;
  generated: boolean;
  pin: string | null;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  name: string;
  slug: string;
  branch: string;
  businessType: BusinessType | null;
  withSamples: boolean;
  users: UserSpec[];
} {
  let name = '';
  let slug = '';
  let branch = 'Main Branch';
  let businessType: BusinessType | null = null;
  let withSamples = false;
  const users: UserSpec[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value after ${arg}`);
      return v;
    };
    if (arg === '--with-samples') withSamples = true;
    else if (arg === '--name') name = next();
    else if (arg === '--slug') slug = next();
    else if (arg === '--branch') branch = next();
    else if (arg === '--business-type') {
      const raw = next().toUpperCase();
      if (!(raw in BusinessType)) {
        fail(`Unknown business type "${raw}" — use one of ${Object.keys(BusinessType).join(', ')}`);
      }
      businessType = raw as BusinessType;
    } else if (arg === '--user') {
      const raw = next();
      const [userName, email, roleKey, password, pin] = raw.split(':');
      if (!userName || !email || !roleKey) {
        fail(`--user must be "Name:email:ROLE[:password[:pin]]" (got "${raw}")`);
      }
      // Validated against the business type's templates once every argument
      // is parsed — `--business-type` may follow `--user` on the command line.
      if (!email.includes('@')) fail(`"${email}" does not look like an email address`);
      if (pin && !/^\d{4,6}$/.test(pin)) {
        fail(`PIN for ${userName} must be 4–6 digits (got "${pin}")`);
      }
      users.push({
        name: userName,
        email: email.toLowerCase(),
        roleKey: roleKey.toUpperCase(),
        role: baseUserRoleFor(roleKey.toUpperCase()),
        password: password || randomBytes(9).toString('base64url'),
        generated: !password,
        pin: pin || null,
      });
    } else {
      fail(`Unknown argument "${arg}"`);
    }
  }

  if (!name) fail('--name "Company Name" is required');
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    fail('--slug is required (lowercase letters, digits, and dashes, e.g. "colombawa")');
  }
  if (users.length === 0) fail('At least one --user "Name:email:ROLE[:password]" is required');
  const emails = users.map((u) => u.email);
  if (new Set(emails).size !== emails.length) fail('User emails must be distinct');
  // PIN lookups resolve to the first tenant user whose PIN matches, so shared
  // PINs would be ambiguous.
  const pins = users.map((u) => u.pin).filter(Boolean);
  if (new Set(pins).size !== pins.length) fail('User PINs must be distinct');
  // D108 — a role the template does not offer would leave the user with no
  // row to link to, resolving from the enum instead: a SALESPERSON in a
  // restaurant would be an owner-equivalent the template says cannot exist.
  const offered = roleTemplatesForBusinessType(businessType ?? 'HARDWARE').map((t) => t.key);
  for (const user of users) {
    if (!offered.includes(user.roleKey)) {
      fail(
        `Role "${user.roleKey}" for ${user.name} is not one the ${businessType ?? 'HARDWARE'} ` +
          `template offers — use one of ${offered.join(', ')}`,
      );
    }
  }
  return { name, slug, branch, businessType, withSamples, users };
}

async function main(): Promise<void> {
  const { name, slug, branch, businessType, withSamples, users } = parseArgs(process.argv.slice(2));

  // Fresh accounts only — never adopt or modify an existing company.
  const existingTenant = await prisma.tenant.findFirst({
    where: { OR: [{ slug }, { name: { equals: name, mode: 'insensitive' } }] },
  });
  if (existingTenant) {
    fail(`A tenant already exists with that name or slug (${existingTenant.name} / ${existingTenant.slug})`);
  }

  // Login resolves users by email across ALL tenants, so emails must be
  // globally unique.
  for (const user of users) {
    const clash = await prisma.user.findFirst({ where: { email: user.email } });
    if (clash) fail(`The email ${user.email} is already in use by another account`);
  }

  let roleCount = 0;
  let linkedCount = 0;
  let pack: { categories: number; products: number; variants: number } | null = null;
  const tenant = await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.create({ data: { name, slug } });
    // Write the shop timezone rather than leaning on the code default, so a new
    // business is pinned the same way the backfilled ones are. Partial blob: the
    // settings service merges it over defaults, so every other field still
    // tracks its default.
    await tx.tenantSettings.create({
      data: { tenantId: t.id, branchId: null, data: { timezone: SHOP_TIME_ZONE } },
    });
    const b = await tx.branch.create({
      data: { tenantId: t.id, name: branch, code: 'MAIN' },
    });
    await tx.register.create({
      data: { tenantId: t.id, branchId: b.id, name: 'Register 1', code: 'R1' },
    });
    if (businessType) {
      // No `TenantModule` rows: with a profile and no explicit per-module opinion
      // the API resolves the defaults for the business type. Writing them here
      // would freeze today's defaults into every tenant provisioned today.
      await tx.tenantBusinessProfile.create({
        data: { tenantId: t.id, businessType, ...BUSINESS_PROFILE_PRESETS[businessType] },
      });
    }
    // Phase 1.5 (D36): every tenant is created with its own role rows. A tenant
    // with none must fail closed once authorization reads them, so this is part of
    // creating a tenant rather than a follow-up step someone can forget.
    await syncPermissionCatalogue(tx);
    roleCount = (await seedTenantRoles(tx, t.id, businessType ?? 'HARDWARE')).length;

    // D120 (2.6) — the clothing pack, inside this transaction so a failure leaves
    // no half-seeded tenant.
    //
    // Categories always; sample PRODUCTS only when asked. The reasoning is the
    // same one three lines above about TenantModule rows: descriptor data lives
    // in code and a correction reaches everyone, but seeded rows live in the
    // tenant's database and are frozen. A category is cheap to be wrong about —
    // rename or delete it. A starter product carries a variant chain, barcodes
    // and stock rows that a real shop then has to clear out.
    if (businessType === 'RETAIL') {
      pack = await seedClothingPack(tx, t.id, b.id, { withSamples });
    }

    const roleIdByKey = new Map(
      (await tx.role.findMany({ where: { tenantId: t.id }, select: { id: true, key: true } })).map(
        (r) => [r.key as string, r.id] as const,
      ),
    );
    for (const user of users) {
      await tx.user.create({
        data: {
          tenantId: t.id,
          branchId: b.id,
          name: user.name,
          email: user.email,
          role: user.role,
          // Linked to the row directly — validated above to exist — rather than
          // through `linkUsersToRoles`, which can only match a key to an enum
          // value and so could never link a waiter or a receptionist.
          roleId: roleIdByKey.get(user.roleKey) ?? null,
          passwordHash: await bcrypt.hash(user.password, SALT_ROUNDS),
          pinHash: user.pin ? await bcrypt.hash(user.pin, SALT_ROUNDS) : null,
        },
      });
      linkedCount += roleIdByKey.has(user.roleKey) ? 1 : 0;
    }
    // Belt and braces for the built-ins; also what the backfill runs.
    linkedCount += await linkUsersToRoles(tx, t.id);
    return t;
  },
  // The catalogue sync alone is sixty-odd upserts; Prisma's default
  // five-second interactive-transaction budget is for a local database.
  { timeout: 60_000, maxWait: 10_000 });

  console.log('\n✔ Company provisioned — no sample data, ready for first login.\n');
  console.log(`  Tenant   ${tenant.name}  (id: ${tenant.id}, slug: ${tenant.slug})`);
  console.log(`  Branch   ${branch} (MAIN) · Register 1 (R1)`);
  if (businessType) {
    const preset = BUSINESS_PROFILE_PRESETS[businessType];
    console.log(
      `  Profile  ${businessType} · ${preset.inventoryMode} inventory · ${preset.accountingProvider} accounting\n`,
    );
  } else {
    // Stated, not silent: the operator should know they provisioned a QuickBooks
    // retail tenant by omission rather than by choice.
    console.log('  Profile  none — resolves to the legacy HARDWARE / QuickBooks configuration (D57)\n');
  }
  console.log('  Logins (email / password / PIN):');
  for (const user of users) {
    const note = user.generated ? '  ← generated, record it now' : '';
    const pin = user.pin ? ` / PIN ${user.pin}` : '';
    console.log(`    ${user.roleKey.padEnd(18)} ${user.email} / ${user.password}${pin}${note}`);
  }
  console.log(`  Roles    ${roleCount} seeded · ${linkedCount} of ${users.length} users linked to their role row`);
  if (pack) {
    console.log(
      `  Catalog  ${pack.categories} categories, ${pack.products} products, ${pack.variants} variants`,
    );
    if (pack.products === 0) {
      console.log('           (pass --with-samples for starter products)');
    }
  }
  console.log('');
  console.log('\n  Sign in at the web app with the email + password above.');
  console.log('  PINs answer the in-POS approval prompts (discounts, returns).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
