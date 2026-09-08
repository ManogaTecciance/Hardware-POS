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
 *     --user "Colombawa1:colombawa1@example.com:OWNER:TheirPassword123:9876" \
 *     --user "Colombawa2:colombawa2@example.com:CASHIER::1234"
 *
 * Each --user is "Name:email:ROLE[:password[:pin]]". When the password is
 * omitted (or left empty, as in "ROLE::1234") a random one is generated and
 * printed once at the end — record it immediately. The optional PIN (4–6
 * digits) feeds the in-POS approval prompts: any user whose role carries the
 * approve permission (owner, admin, salesperson, manager) can answer a
 * "manager PIN" request with their own PIN.
 */
import { randomBytes } from 'node:crypto';

import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;
/** Sri Lanka — where the business trades, and the zone its documents are dated in. */
const SHOP_TIME_ZONE = 'Asia/Colombo';

interface UserSpec {
  name: string;
  email: string;
  role: UserRole;
  password: string;
  generated: boolean;
  pin: string | null;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { name: string; slug: string; branch: string; users: UserSpec[] } {
  let name = '';
  let slug = '';
  let branch = 'Main Branch';
  const users: UserSpec[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value after ${arg}`);
      return v;
    };
    if (arg === '--name') name = next();
    else if (arg === '--slug') slug = next();
    else if (arg === '--branch') branch = next();
    else if (arg === '--user') {
      const raw = next();
      const [userName, email, role, password, pin] = raw.split(':');
      if (!userName || !email || !role) {
        fail(`--user must be "Name:email:ROLE[:password[:pin]]" (got "${raw}")`);
      }
      if (!(role in UserRole)) {
        fail(`Unknown role "${role}" — use one of ${Object.keys(UserRole).join(', ')}`);
      }
      if (!email.includes('@')) fail(`"${email}" does not look like an email address`);
      if (pin && !/^\d{4,6}$/.test(pin)) {
        fail(`PIN for ${userName} must be 4–6 digits (got "${pin}")`);
      }
      users.push({
        name: userName,
        email: email.toLowerCase(),
        role: role as UserRole,
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
  return { name, slug, branch, users };
}

async function main(): Promise<void> {
  const { name, slug, branch, users } = parseArgs(process.argv.slice(2));

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
    for (const user of users) {
      await tx.user.create({
        data: {
          tenantId: t.id,
          branchId: b.id,
          name: user.name,
          email: user.email,
          role: user.role,
          passwordHash: await bcrypt.hash(user.password, SALT_ROUNDS),
          pinHash: user.pin ? await bcrypt.hash(user.pin, SALT_ROUNDS) : null,
        },
      });
    }
    return t;
  });

  console.log('\n✔ Company provisioned — no sample data, ready for first login.\n');
  console.log(`  Tenant   ${tenant.name}  (id: ${tenant.id}, slug: ${tenant.slug})`);
  console.log(`  Branch   ${branch} (MAIN) · Register 1 (R1)\n`);
  console.log('  Logins (email / password / PIN):');
  for (const user of users) {
    const note = user.generated ? '  ← generated, record it now' : '';
    const pin = user.pin ? ` / PIN ${user.pin}` : '';
    console.log(`    ${user.role.padEnd(10)} ${user.email} / ${user.password}${pin}${note}`);
  }
  console.log('\n  Sign in at the web app with the email + password above.');
  console.log('  PINs answer the in-POS approval prompts (discounts, returns).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
