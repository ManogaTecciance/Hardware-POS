/**
 * Slice 3.5 — Cross-Tenant Authentication Hardening.
 *
 * ROOT CAUSE this suite exists to close:
 *
 *   AuthRepository.findActiveByEmail(email) was
 *     prisma.user.findFirst({ where: { email, isActive: true } })
 *   with NO tenant predicate, against a table that is only
 *     @@unique([tenantId, email])
 *
 *   So one email may legitimately exist in several tenants, and `findFirst` with
 *   no ORDER BY returned whichever row PostgreSQL produced first. The password was
 *   then checked against THAT row. Consequences:
 *     • non-deterministic tenant assignment — the same credentials could
 *       authenticate into a different tenant's data between attempts;
 *     • intermittent login failure when the two accounts had different passwords.
 *
 * Run against real PostgreSQL because the defect is a query-semantics defect: a
 * mocked Prisma would have happily returned whatever the mock was told to.
 */

import type { PrismaClient } from '@hardware-pos/database';
import * as bcrypt from 'bcryptjs';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { seedTenant } from '../fixtures';
import { createIntegrationApp, type IntegrationApp } from '../test-app';
import { WorkspaceRequiredError } from '../../../src/modules/auth/auth.errors';
import { LoginDto } from '../../../src/modules/auth/dto/login.dto';

let prisma: PrismaClient;
let app: IntegrationApp;

/** The email deliberately shared by two different tenants. */
const SHARED_EMAIL = 'shehan@tecciance.test';
const TILE_PASSWORD = 'TileShopPassword1';
const CAFE_PASSWORD = 'CafePassword2';

let tileTenantId: string;
let cafeTenantId: string;
let tileUserId: string;
let cafeUserId: string;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  app = await createIntegrationApp();
});

afterAll(async () => {
  await app.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const tile = await seedTenant(prisma, {
    prefix: 'tile',
    name: 'Fixture Tile Shop',
    slug: 'fixture-tile-shop',
  });
  const cafe = await seedTenant(prisma, {
    prefix: 'cafe',
    name: 'Fixture Cafe',
    slug: 'fixture-cafe',
  });
  tileTenantId = tile.tenantId;
  cafeTenantId = cafe.tenantId;

  // THE SAME EMAIL IN TWO TENANTS, with different passwords so a wrong-tenant
  // resolution is observable rather than silently "working".
  tileUserId = (
    await prisma.user.create({
      data: {
        tenantId: tileTenantId,
        branchId: tile.branchId,
        role: 'ADMIN',
        name: 'Shehan (Tile Shop)',
        email: SHARED_EMAIL,
        passwordHash: bcrypt.hashSync(TILE_PASSWORD, 4),
      },
    })
  ).id;

  cafeUserId = (
    await prisma.user.create({
      data: {
        tenantId: cafeTenantId,
        branchId: cafe.branchId,
        role: 'ADMIN',
        name: 'Shehan (Cafe)',
        email: SHARED_EMAIL,
        passwordHash: bcrypt.hashSync(CAFE_PASSWORD, 4),
      },
    })
  ).id;
});

function login(email: string, password: string, tenantHint: string | null = null) {
  return app.authService.login(dto(LoginDto, { email, password }), tenantHint);
}

// ─────────────────────────────────────────────────────────────────────────────
// The schema genuinely permits the duplicate — proving the premise, not assuming it
// ─────────────────────────────────────────────────────────────────────────────

describe('premise: one email may exist in several tenants', () => {
  it('stores the same email under two tenants without violating a constraint', async () => {
    const rows = await prisma.user.findMany({ where: { email: SHARED_EMAIL } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([tileTenantId, cafeTenantId]));
  });

  it('still forbids the same email TWICE inside one tenant', async () => {
    await expect(
      prisma.user.create({
        data: { tenantId: tileTenantId, role: 'CASHIER', name: 'Dup', email: SHARED_EMAIL },
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Isolation — each account authenticates ONLY within its own tenant
// ─────────────────────────────────────────────────────────────────────────────

describe('duplicate email is isolated per tenant', () => {
  it('authenticates the Tile Shop account into the Tile Shop tenant', async () => {
    const result = await login(SHARED_EMAIL, TILE_PASSWORD, tileTenantId);

    expect(result.user.id).toBe(tileUserId);
    expect(result.user.tenantId).toBe(tileTenantId);
    expect(result.user.name).toBe('Shehan (Tile Shop)');
  });

  it('authenticates the Cafe account into the Cafe tenant', async () => {
    const result = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);

    expect(result.user.id).toBe(cafeUserId);
    expect(result.user.tenantId).toBe(cafeTenantId);
    expect(result.user.name).toBe('Shehan (Cafe)');
  });

  it('refuses the Cafe password against the Tile Shop tenant', async () => {
    await expect(login(SHARED_EMAIL, CAFE_PASSWORD, tileTenantId)).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('refuses the Tile Shop password against the Cafe tenant', async () => {
    await expect(login(SHARED_EMAIL, TILE_PASSWORD, cafeTenantId)).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('never leaks the other tenant across 30 consecutive resolutions', async () => {
    // The original defect was non-deterministic, so a single pass could pass by
    // luck. Both directions, repeatedly, must land in their own tenant every time.
    for (let i = 0; i < 15; i += 1) {
      const tile = await login(SHARED_EMAIL, TILE_PASSWORD, tileTenantId);
      expect(tile.user.tenantId).toBe(tileTenantId);
      expect(tile.user.id).toBe(tileUserId);

      const cafe = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);
      expect(cafe.user.tenantId).toBe(cafeTenantId);
      expect(cafe.user.id).toBe(cafeUserId);
    }
  });

  it('issues a JWT carrying the resolved tenant, not the other one', async () => {
    const result = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);
    const decoded = app.jwtService.verify<{ sub: string; tenantId: string }>(result.token);

    expect(decoded.tenantId).toBe(cafeTenantId);
    expect(decoded.sub).toBe(cafeUserId);
  });

  it('resolves the session branch inside the resolved tenant', async () => {
    const result = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { id: result.branch?.id ?? '' },
    });
    expect(branch.tenantId).toBe(cafeTenantId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail closed when the tenant is ambiguous
// ─────────────────────────────────────────────────────────────────────────────

describe('ambiguous email with no tenant hint', () => {
  /**
   * UPDATED IN SLICE 7.2, deliberately.
   *
   * Slice 3.5 made this path fail with the same generic `Invalid email or password`
   * as every other rejection. That was the right fix for the defect of the day —
   * never guess a tenant — but it left a legitimate user with no way forward: the
   * response gave them nothing to act on, and their account was simply unusable.
   *
   * Slice 7.2 keeps the refusal and changes only what the caller is told, so they
   * can supply a workspace and proceed. **The security property under test is
   * unchanged and still asserted**: no correct password ever authenticates into an
   * arbitrarily chosen tenant. What changed is the error, not the outcome.
   */
  it('refuses rather than guessing a tenant, even with a CORRECT password', async () => {
    await expect(login(SHARED_EMAIL, TILE_PASSWORD)).rejects.toThrow(WorkspaceRequiredError);
    await expect(login(SHARED_EMAIL, CAFE_PASSWORD)).rejects.toThrow(WorkspaceRequiredError);
  });

  it('is deterministic — 20 attempts, never a single success', async () => {
    for (let i = 0; i < 20; i += 1) {
      await expect(login(SHARED_EMAIL, TILE_PASSWORD)).rejects.toThrow(WorkspaceRequiredError);
    }
  });

  it('the refusal is a refusal — no token, no session, no tenant chosen', async () => {
    // The load-bearing assertion, stated directly rather than inferred from the
    // message. A future change to the error type cannot quietly turn this into a
    // successful login.
    await expect(login(SHARED_EMAIL, TILE_PASSWORD)).rejects.toBeInstanceOf(
      WorkspaceRequiredError,
    );
    const sessions = await prisma.refreshToken.count();
    expect(sessions).toBe(0);
  });

  it('starts working again once the duplicate is deactivated', async () => {
    // Only one ACTIVE candidate remains, so no hint is needed.
    await prisma.user.update({ where: { id: cafeUserId }, data: { isActive: false } });

    const result = await login(SHARED_EMAIL, TILE_PASSWORD);
    expect(result.user.tenantId).toBe(tileTenantId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A client-supplied tenant id must never be trusted on its own
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant hint is a narrowing hint, never an authorisation', () => {
  it('cannot authenticate into a tenant the credentials do not belong to', async () => {
    // Correct Cafe password + Tile Shop tenant: the hint must not override the
    // password check.
    await expect(login(SHARED_EMAIL, CAFE_PASSWORD, tileTenantId)).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('rejects a non-existent tenant id', async () => {
    await expect(login(SHARED_EMAIL, TILE_PASSWORD, 'tenant-does-not-exist')).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('rejects an empty-ish / malformed tenant id without falling back to a guess', async () => {
    for (const bogus of ['   ', 'null', 'undefined', '*', "' OR 1=1 --"]) {
      await expect(login(SHARED_EMAIL, TILE_PASSWORD, bogus)).rejects.toThrow(
        'Invalid email or password',
      );
    }
  });

  it('does not let a hint resurrect an INACTIVE user', async () => {
    // 2026-08-17: still refused — no token is ever issued — but with the
    // honest reason, because the CORRECT password was presented. A wrong
    // password on the same account stays the generic 401 (asserted in
    // auth-hardening.spec.ts), so nothing here is probeable.
    await prisma.user.update({ where: { id: cafeUserId }, data: { isActive: false } });
    await expect(login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId)).rejects.toThrow(
      'This account has been deactivated',
    );
    await expect(login(SHARED_EMAIL, 'wrong-password-1', cafeTenantId)).rejects.toThrow(
      'Invalid email or password',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Enumeration safety
// ─────────────────────────────────────────────────────────────────────────────

describe('account-enumeration safety', () => {
  const CASES: [string, () => Promise<unknown>][] = [
    ['unknown email', () => login('nobody@nowhere.test', 'whatever123')],
    ['known email, wrong password', () => login(SHARED_EMAIL, 'wrongpassword', tileTenantId)],
    // 'known email, ambiguous tenant' moved out of this set in Slice 7.2: it is now
    // WORKSPACE_REQUIRED by design, and its own disclosure limits are asserted
    // separately below and in `auth-hardening.spec.ts`.
    ['known email, wrong tenant', () => login(SHARED_EMAIL, TILE_PASSWORD, cafeTenantId)],
    ['unknown tenant', () => login(SHARED_EMAIL, TILE_PASSWORD, 'tenant-does-not-exist')],
  ];

  it.each(CASES)('returns the identical generic message for: %s', async (_label, attempt) => {
    await expect(attempt()).rejects.toThrow('Invalid email or password');
  });

  it('never reveals a tenant id, tenant name, or user name in the error', async () => {
    expect.assertions(6);
    try {
      // Slice 7.2: this is now the WORKSPACE_REQUIRED path. It is the response that
      // discloses the MOST of any rejection — it admits the address exists in more
      // than one workspace — so it is the right one to hold to this standard.
      await login(SHARED_EMAIL, TILE_PASSWORD);
    } catch (err) {
      const text = JSON.stringify((err as { response?: unknown }).response ?? (err as Error).message);
      // POSITIVE CONTROL (Slice 6C-A.5): there IS a real error payload here. Without
      // this, an empty or undefined body would satisfy every negative below.
      expect(text.length).toBeGreaterThan(10);
      expect(text).toMatch(/workspace/i);

      expect(text).not.toContain(tileTenantId);
      expect(text).not.toContain(cafeTenantId);
      expect(text).not.toContain('Tile Shop');
      expect(text).not.toContain('Cafe');
    }
  });

  it('WORKSPACE_REQUIRED discloses no count of matching workspaces', async () => {
    // Added in Slice 7.2. "Two workspaces hold this address" would be a materially
    // larger leak than "supply a workspace", so the boundary is asserted explicitly
    // rather than left to the wording surviving by luck.
    try {
      await login(SHARED_EMAIL, TILE_PASSWORD);
      fail('expected a refusal');
    } catch (err) {
      // The MESSAGE, not the envelope: the envelope carries the 409 status code,
      // which is not a disclosure about workspaces.
      const response = (err as { response?: { message?: string } }).response;
      const message = response?.message ?? (err as Error).message;
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/\d/);
    }
  });

  /*
   * TWO TIMING ASSERTIONS MOVED OUT of this file — the security properties are
   * the same, but timing was the wrong instrument. They were:
   *
   *   1. "spends a bcrypt round on every credential rejection" — asserted that
   *      unknown-email / wrong-tenant / unknown-tenant paths each cleared a 1ms
   *      floor, so no fast-path revealed which emails exist.
   *   2. "the ambiguous path short-circuits BEFORE any password check" —
   *      asserted that WORKSPACE_REQUIRED runs faster than a real bcrypt
   *      compare, so the recorded trade-off in Slice 7.2 stays a recorded
   *      trade-off (see auth.errors.ts).
   *
   * Both are implementation claims about whether `bcrypt.compare` runs. Timing
   * as evidence depended on CPU jitter and (2) started to fail intermittently
   * under load. Rewritten deterministically in
   * `apps/api/src/modules/auth/auth.service.spec.ts` using `jest.spyOn(bcrypt,
   * 'compare')` — the spy replaces "the ambiguous branch was faster" with
   * "compare was called zero times", which is a boolean question, not a race.
   *
   * The externally observable behaviour (WORKSPACE_REQUIRED, generic 401s,
   * duplicate-email tenant isolation, no session issued on refusal) is still
   * asserted end-to-end by the rest of this file.
   */
});

// ─────────────────────────────────────────────────────────────────────────────
// Refresh tokens must not cross tenants
// ─────────────────────────────────────────────────────────────────────────────

describe('refresh tokens respect the tenant boundary', () => {
  it('stores the refresh token against the resolved tenant', async () => {
    const result = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);

    const rows = await prisma.refreshToken.findMany({ where: { userId: cafeUserId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(cafeTenantId);
    expect(result.user.tenantId).toBe(cafeTenantId);
  });

  it('rotates within the same tenant and never migrates to the other', async () => {
    const first = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);
    const rotated = await app.authService.refresh(first.refreshToken);

    expect(rotated.user.tenantId).toBe(cafeTenantId);
    expect(rotated.user.id).toBe(cafeUserId);

    const decoded = app.jwtService.verify<{ tenantId: string }>(rotated.token);
    expect(decoded.tenantId).toBe(cafeTenantId);
  });

  it('refuses a token whose tenantId disagrees with its user, and kills the sessions', async () => {
    const session = await login(SHARED_EMAIL, CAFE_PASSWORD, cafeTenantId);
    const row = await prisma.refreshToken.findFirstOrThrow({ where: { userId: cafeUserId } });

    // Force the inconsistency the schema cannot prevent: RefreshToken.tenantId and
    // RefreshToken.userId are independent FKs with no composite constraint.
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { tenantId: tileTenantId },
    });

    await expect(app.authService.refresh(session.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );

    // Every session for that user is revoked, not just the offending row.
    const live = await prisma.refreshToken.findMany({
      where: { userId: cafeUserId, revokedAt: null },
    });
    expect(live).toHaveLength(0);
  });

  it('still treats a replayed (revoked) token as a breach and revokes everything', async () => {
    // Pre-existing behaviour — must survive this change.
    const session = await login(SHARED_EMAIL, TILE_PASSWORD, tileTenantId);
    await app.authService.refresh(session.refreshToken);

    await expect(app.authService.refresh(session.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );

    const live = await prisma.refreshToken.findMany({
      where: { userId: tileUserId, revokedAt: null },
    });
    expect(live).toHaveLength(0);
  });

  it('rejects an unknown refresh token', async () => {
    await expect(app.authService.refresh('not-a-real-token')).rejects.toThrow(
      'Invalid refresh token',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The single-tenant path — the Tile Shop's actual production shape
// ─────────────────────────────────────────────────────────────────────────────

describe('single-tenant login is unchanged', () => {
  beforeEach(async () => {
    // Collapse to one tenant holding the email — production today.
    await prisma.user.delete({ where: { id: cafeUserId } });
  });

  it('logs in with NO tenant hint, exactly as before', async () => {
    const result = await login(SHARED_EMAIL, TILE_PASSWORD);
    expect(result.user.id).toBe(tileUserId);
    expect(result.user.tenantId).toBe(tileTenantId);
    expect(result.token).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.branch?.id).toBeTruthy();
    expect(result.register?.id).toBeTruthy();
  });

  it('logs in WITH a correct tenant hint too', async () => {
    const result = await login(SHARED_EMAIL, TILE_PASSWORD, tileTenantId);
    expect(result.user.id).toBe(tileUserId);
  });

  it('still rejects a wrong password', async () => {
    await expect(login(SHARED_EMAIL, 'nope-not-it')).rejects.toThrow('Invalid email or password');
  });

  it('still rejects an inactive user — now with the honest reason (2026-08-17)', async () => {
    await prisma.user.update({ where: { id: tileUserId }, data: { isActive: false } });
    // Refused either way; the deactivated message only ever follows a
    // VERIFIED password, so it discloses nothing to a guesser.
    await expect(login(SHARED_EMAIL, TILE_PASSWORD)).rejects.toThrow(
      'This account has been deactivated',
    );
    await expect(login(SHARED_EMAIL, 'wrong-password-1')).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('still rejects a user with no password hash (PIN-only staff)', async () => {
    await prisma.user.update({ where: { id: tileUserId }, data: { passwordHash: null } });
    await expect(login(SHARED_EMAIL, TILE_PASSWORD)).rejects.toThrow('Invalid email or password');
  });

  it('updates lastLoginAt', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: tileUserId } });
    expect(before.lastLoginAt).toBeNull();

    await login(SHARED_EMAIL, TILE_PASSWORD);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: tileUserId } });
    expect(after.lastLoginAt).not.toBeNull();
  });
});
