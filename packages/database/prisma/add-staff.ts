/**
 * Add staff users to an EXISTING tenant.
 *
 * `provision-tenant.ts` creates a company and its first users and then refuses
 * to touch anything that exists, which is right for provisioning and useless on
 * the day a restaurant hires a second waiter. `POST /v1/users` is the eventual
 * home for this and currently throws `NotImplementedException`, so until it
 * lands this script is how a workspace gets another user — and, unlike a hand
 * -written SQL insert, it hashes the password, derives the enum column the same
 * way the platform console does, and links the ROLE ROW (D108) so nobody starts
 * on the legacy enum fallback.
 *
 * Run from the repo root (DATABASE_URL comes from packages/database/.env):
 *
 *   pnpm --filter @hardware-pos/database exec tsx prisma/add-staff.ts \
 *     --tenant axlopos-restaurant \
 *     --user "Nimal Perera:nimal@example.com:WAITER:Password123!:4446" \
 *     --user "Sunil Fernando:sunil@example.com:WAITER::4447"
 *
 * Each --user is "Name:email:ROLE_KEY[:password[:pin]]". An omitted password is
 * generated and printed once at the end. The optional PIN (4-6 digits) answers
 * in-POS approval prompts for roles that carry the approve permission.
 *
 * `--branch CODE|id` picks the user's default branch — the one their token
 * resolves at login (`issueToken` reads `user.branchId`), which for a waiter
 * decides whether the floor opens at all. Omitted, the tenant's only active
 * branch is used; a multi-branch tenant must say which.
 *
 * ROLE_KEY is validated against the tenant's OWN role rows rather than the
 * template catalogue: the rows are what a login resolves permissions through,
 * and a tenant may have custom ones the templates know nothing about.
 *
 * Refuses an email that already exists in the tenant (the `@@unique([tenantId,
 * email])` pair) rather than updating it: re-pointing an existing person's
 * password from a provisioning script is not something to do by accident.
 */
import { randomBytes } from 'node:crypto';

import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { baseUserRoleFor } from '@hardware-pos/shared';

const prisma = new PrismaClient();
/** Same cost factor as the seed and the provisioning script. */
const SALT_ROUNDS = 10;

interface StaffSpec {
  name: string;
  email: string;
  roleKey: string;
  role: UserRole;
  password: string;
  generated: boolean;
  pin: string | null;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { tenant?: string; branch?: string; users: string[] } {
  const out: { tenant?: string; branch?: string; users: string[] } = { users: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--tenant' || arg === '--branch') {
      if (!next) fail(`${arg} needs a value`);
      if (arg === '--tenant') out.tenant = next;
      else out.branch = next;
      i += 1;
    } else if (arg === '--user') {
      if (!next) fail('--user needs a value');
      out.users.push(next);
      i += 1;
    } else {
      fail(`Unknown argument "${arg}"`);
    }
  }
  return out;
}

/**
 * "Name:email:ROLE[:password[:pin]]" — split on ':' but only the first four
 * times, so a generated password containing a colon cannot be misread as a PIN.
 */
function parseUser(spec: string): Omit<StaffSpec, 'role'> {
  const [name, email, roleKey, password, pin, ...rest] = spec.split(':');
  if (rest.length > 0) fail(`Too many ':' fields in --user "${spec}"`);
  if (!name || !email || !roleKey) {
    fail(`--user "${spec}" must be "Name:email:ROLE_KEY[:password[:pin]]"`);
  }
  if (!email.includes('@')) fail(`"${email}" is not an email address`);
  if (pin && !/^\d{4,6}$/.test(pin)) fail(`PIN for ${email} must be 4-6 digits`);
  const generated = !password;
  return {
    name,
    email,
    roleKey: roleKey.toUpperCase(),
    // 12 bytes of base64url, so a printed-once password is not guessable and
    // survives being read aloud across a counter.
    password: password || randomBytes(9).toString('base64url'),
    generated,
    pin: pin || null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant) fail('--tenant <slug|id> is required');
  if (args.users.length === 0) fail('At least one --user is required');

  const tenant = await prisma.tenant.findFirst({
    where: { OR: [{ slug: args.tenant }, { id: args.tenant }] },
    select: { id: true, name: true, slug: true },
  });
  if (!tenant) fail(`No tenant with slug or id "${args.tenant}"`);

  const branches = await prisma.branch.findMany({
    where: { tenantId: tenant.id, isActive: true },
    select: { id: true, name: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (branches.length === 0) fail(`Tenant ${tenant.slug} has no active branch`);
  const branch = args.branch
    ? branches.find((b) => b.code === args.branch || b.id === args.branch)
    : branches.length === 1
      ? branches[0]
      : undefined;
  if (!branch) {
    fail(
      args.branch
        ? `No active branch "${args.branch}" in ${tenant.slug}`
        : `${tenant.slug} has ${branches.length} active branches — pass --branch ` +
          `(${branches.map((b) => b.code).join(', ')})`,
    );
  }

  const roles = await prisma.role.findMany({
    where: { tenantId: tenant.id, isActive: true },
    select: { id: true, key: true, name: true },
  });
  const roleByKey = new Map(roles.map((r) => [r.key ?? '', r] as const));

  const specs: StaffSpec[] = args.users.map((raw) => {
    const parsed = parseUser(raw);
    if (!roleByKey.has(parsed.roleKey)) {
      fail(
        `${tenant.slug} has no role "${parsed.roleKey}". Available: ` +
          `${[...roleByKey.keys()].filter(Boolean).sort().join(', ')}`,
      );
    }
    return {
      ...parsed,
      // The enum column under the row, derived the one way the whole codebase
      // derives it: a built-in key is its own enum value, anything else CASHIER.
      role: baseUserRoleFor(parsed.roleKey),
    };
  });

  const emails = specs.map((s) => s.email);
  const duplicate = emails.find((e, i) => emails.indexOf(e) !== i);
  if (duplicate) fail(`--user repeats the email ${duplicate}`);
  const clashes = await prisma.user.findMany({
    where: { tenantId: tenant.id, email: { in: emails } },
    select: { email: true },
  });
  if (clashes.length > 0) {
    fail(`Already in ${tenant.slug}: ${clashes.map((c) => c.email).join(', ')}`);
  }

  for (const spec of specs) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: spec.name,
        email: spec.email,
        role: spec.role,
        roleId: roleByKey.get(spec.roleKey)!.id,
        passwordHash: await bcrypt.hash(spec.password, SALT_ROUNDS),
        pinHash: spec.pin ? await bcrypt.hash(spec.pin, SALT_ROUNDS) : null,
      },
    });
  }

  console.log(`\n✔ Added ${specs.length} user(s) to ${tenant.name} (${tenant.slug})`);
  console.log(`  Branch  ${branch.name} (${branch.code})\n`);
  for (const spec of specs) {
    const role = roleByKey.get(spec.roleKey)!;
    console.log(`  ${spec.name}`);
    console.log(`    email     ${spec.email}`);
    console.log(`    password  ${spec.password}${spec.generated ? '   (generated — record it now)' : ''}`);
    console.log(`    role      ${role.name} (${role.key})`);
    if (spec.pin) console.log(`    pin       ${spec.pin}`);
    console.log('');
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
