/**
 * Slice 7 — authentication throttling, workspace-first login, and module guards,
 * over real HTTP against real PostgreSQL.
 *
 * These properties cannot be tested any other way. A 429 with `Retry-After` is a
 * property of the interceptor pipeline; a module denial is a property of
 * `APP_GUARD` ordering; and "tenant A's failures do not block tenant B" is a
 * property of the key derivation *and* the database rows together. A mocked
 * harness would prove none of it.
 *
 * ## Rate limits are made small on purpose
 *
 * The production allowances are deliberately generous (20 login attempts per IP
 * per 5 minutes). Exercising those literally would mean 20+ bcrypt rounds per
 * assertion. The env overrides below shrink them so the *behaviour* is tested at
 * speed — the numbers are configuration, the blocking is the behaviour.
 */

import type { PrismaClient } from '@hardware-pos/database';
import * as bcrypt from 'bcryptjs';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';
import { MemoryRateLimitStore } from '../../../src/common/throttling/memory-rate-limit.store';
import { RATE_LIMIT_STORE } from '../../../src/common/throttling/rate-limit.store';

let prisma: PrismaClient;
let http: HttpIntegrationApp;

const SHARED_EMAIL = 'shared.owner@axlo.test';
const TILE_PASSWORD = 'TileShopPassword1';
const CAFE_PASSWORD = 'CafePassword2';
const SOLO_EMAIL = 'solo.owner@axlo.test';
const SOLO_PASSWORD = 'SoloPassword3';
/**
 * Must be at least 6 characters or `LoginDto`'s `@MinLength(6)` rejects it with a
 * 400 before authentication is ever attempted — which would make every "this was
 * a 401" assertion below test the validation pipe instead of the credential check.
 */
const WRONG_PASSWORD = 'definitely-wrong';

let tile: Awaited<ReturnType<typeof seedTenant>>;
let cafe: Awaited<ReturnType<typeof seedTenant>>;

/**
 * Small windows so a test can exhaust an allowance quickly, and a *short* window
 * so the "not permanently locked out" case can actually observe expiry.
 */
const RATE_LIMIT_ENV: Record<string, string> = {
  /*
   * Without this the limiter ignores `X-Forwarded-For` entirely and every request
   * in this file shares one socket address (127.0.0.1) — which is the correct
   * production default (see `client-ip.ts`) but makes per-source assertions
   * impossible. Declaring one trusted hop lets each test use its own source IP,
   * exactly as it would behind a single load balancer.
   */
  TRUSTED_PROXY_HOP_COUNT: '1',
  RATE_LIMIT_LOGIN_IP_LIMIT: '6',
  RATE_LIMIT_LOGIN_IP_WINDOW_MS: '60000',
  RATE_LIMIT_LOGIN_IDENTITY_LIMIT: '3',
  RATE_LIMIT_LOGIN_IDENTITY_WINDOW_MS: '60000',
  RATE_LIMIT_PIN_IP_LIMIT: '6',
  RATE_LIMIT_PIN_IP_WINDOW_MS: '60000',
  RATE_LIMIT_PIN_POSITION_LIMIT: '3',
  RATE_LIMIT_PIN_POSITION_WINDOW_MS: '60000',
  RATE_LIMIT_REFRESH_IP_LIMIT: '6',
  RATE_LIMIT_REFRESH_IP_WINDOW_MS: '60000',
  RATE_LIMIT_REFRESH_TOKEN_LIMIT: '3',
  RATE_LIMIT_REFRESH_TOKEN_WINDOW_MS: '60000',
};

beforeAll(async () => {
  Object.assign(process.env, RATE_LIMIT_ENV);
  prisma = await connectTestPrisma();
  http = await createHttpIntegrationApp();
});

afterAll(async () => {
  await http.close();
  await disconnectTestPrisma();
  for (const key of Object.keys(RATE_LIMIT_ENV)) delete process.env[key];
});

beforeEach(async () => {
  // The store outlives the app under test, and the identity counters are keyed on
  // workspace + email rather than source IP (by design — see the service comment),
  // so without this every case would inherit the spent allowance of the ones
  // before it and the assertions would depend on declaration order.
  http.app.get<MemoryRateLimitStore>(RATE_LIMIT_STORE).clearAllForTests();

  await resetDatabase(prisma);
  tile = await seedTenant(prisma, { prefix: 'tile', name: 'Tile Shop', slug: 'tile-shop' });
  cafe = await seedTenant(prisma, { prefix: 'cafe', name: 'Cafe', slug: 'cafe-demo' });

  // The same address in two workspaces, with different passwords so a wrong-tenant
  // resolution would be observable rather than silently "working".
  await prisma.user.create({
    data: {
      tenantId: tile.tenantId,
      branchId: tile.branchId,
      role: 'ADMIN',
      name: 'Shared (Tile)',
      email: SHARED_EMAIL,
      passwordHash: bcrypt.hashSync(TILE_PASSWORD, 4),
    },
  });
  await prisma.user.create({
    data: {
      tenantId: cafe.tenantId,
      branchId: cafe.branchId,
      role: 'ADMIN',
      name: 'Shared (Cafe)',
      email: SHARED_EMAIL,
      passwordHash: bcrypt.hashSync(CAFE_PASSWORD, 4),
    },
  });
  // An address in exactly one workspace, for the backward-compatibility path.
  await prisma.user.create({
    data: {
      tenantId: tile.tenantId,
      role: 'ADMIN',
      name: 'Solo',
      email: SOLO_EMAIL,
      passwordHash: bcrypt.hashSync(SOLO_PASSWORD, 4),
    },
  });
});

/** Each test gets its own source IP so counters never leak between tests. */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

function login(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return http.request('POST', '/auth/login', { body, headers });
}

/**
 * A header bag carrying a fresh source IP.
 *
 * Every request in this file needs one. The rate-limit store lives for the whole
 * suite, so a request that does not declare a source inherits the shared socket
 * address — and therefore the spent counters of every earlier test, which shows up
 * as a baffling 429 in an unrelated assertion.
 */
function ip(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-forwarded-for': freshIp(), ...extra };
}

/**
 * An error body without its `timestamp`.
 *
 * The global exception filter stamps every response, so two responses milliseconds
 * apart are never byte-identical. Comparing the rest is the property that actually
 * matters: two rejections must be indistinguishable in everything a caller could
 * use to tell them apart.
 */
function comparableError(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const { timestamp: _timestamp, ...rest } = body as Record<string, unknown>;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.2 — workspace-first authentication
// ─────────────────────────────────────────────────────────────────────────────

describe('7.2 — workspace-first login', () => {
  it('a workspace slug authenticates inside that tenant only', async () => {
    const asTile = await login(
      { workspace: 'tile-shop', email: SHARED_EMAIL, password: TILE_PASSWORD },
      ip(),
    );
    expect(asTile.status).toBe(200);
    expect((asTile.data as { user: { tenantId: string } }).user.tenantId).toBe(tile.tenantId);

    const asCafe = await login(
      { workspace: 'cafe-demo', email: SHARED_EMAIL, password: CAFE_PASSWORD },
      ip(),
    );
    expect(asCafe.status).toBe(200);
    expect((asCafe.data as { user: { tenantId: string } }).user.tenantId).toBe(cafe.tenantId);
  });

  it('the tile password does not work against the cafe workspace', async () => {
    // The whole point of the slug: it narrows, and the password is still checked
    // against that tenant's own user.
    const res = await login(
      { workspace: 'cafe-demo', email: SHARED_EMAIL, password: TILE_PASSWORD },
      ip(),
    );
    expect(res.status).toBe(401);
  });

  it('an omitted workspace with several matches returns WORKSPACE_REQUIRED', async () => {
    const res = await login({ email: SHARED_EMAIL, password: TILE_PASSWORD }, ip());
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('AUTH_WORKSPACE_REQUIRED');
  });

  it('WORKSPACE_REQUIRED names no tenant, slug or count', async () => {
    const res = await login({ email: SHARED_EMAIL, password: TILE_PASSWORD }, ip());
    const serialised = JSON.stringify(res.body);
    for (const leak of ['tile-shop', 'cafe-demo', 'Tile Shop', 'Cafe', tile.tenantId, cafe.tenantId]) {
      expect(serialised).not.toContain(leak);
    }
    expect(serialised).not.toMatch(/\b2\b/);
  });

  it('an omitted workspace with ONE match still logs in — backward compatibility', async () => {
    const res = await login({ email: SOLO_EMAIL, password: SOLO_PASSWORD }, ip());
    expect(res.status).toBe(200);
    expect((res.data as { user: { tenantId: string } }).user.tenantId).toBe(tile.tenantId);
  });

  it('the x-tenant-id header still narrows, exactly as before 7.2', async () => {
    const res = await login(
      { email: SHARED_EMAIL, password: CAFE_PASSWORD },
      ip({ 'x-tenant-id': cafe.tenantId }),
    );
    expect(res.status).toBe(200);
    expect((res.data as { user: { tenantId: string } }).user.tenantId).toBe(cafe.tenantId);
  });

  it('an unknown workspace is a generic 401, not a "no such workspace"', async () => {
    // A distinguishable response here would turn the endpoint into a directory of
    // which companies exist.
    const unknown = await login(
      { workspace: 'not-a-real-workspace', email: SHARED_EMAIL, password: TILE_PASSWORD },
      ip(),
    );
    const wrongPassword = await login(
      { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
      ip(),
    );
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(comparableError(unknown.body)).toEqual(comparableError(wrongPassword.body));
  });

  it('an unknown EMAIL is indistinguishable from a wrong password', async () => {
    const unknownEmail = await login(
      { workspace: 'tile-shop', email: 'nobody@axlo.test', password: TILE_PASSWORD },
      ip(),
    );
    const wrongPassword = await login(
      { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
      ip(),
    );
    expect(unknownEmail.status).toBe(401);
    expect(comparableError(unknownEmail.body)).toEqual(comparableError(wrongPassword.body));
  });

  it('a deactivated workspace behaves exactly like one that never existed', async () => {
    await prisma.tenant.update({ where: { id: cafe.tenantId }, data: { isActive: false } });
    const deactivated = await login(
      { workspace: 'cafe-demo', email: SHARED_EMAIL, password: CAFE_PASSWORD },
      ip(),
    );
    const nonexistent = await login(
      { workspace: 'never-existed', email: SHARED_EMAIL, password: CAFE_PASSWORD },
      ip(),
    );
    expect(deactivated.status).toBe(401);
    expect(comparableError(deactivated.body)).toEqual(comparableError(nonexistent.body));
  });

  it('a malformed workspace is rejected by validation, not looked up', async () => {
    const res = await login(
      { workspace: 'not a slug!', email: SHARED_EMAIL, password: TILE_PASSWORD },
      ip(),
    );
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.1 — throttling
// ─────────────────────────────────────────────────────────────────────────────

describe('7.1 — email login throttling', () => {
  it('blocks after repeated failures and returns a generic 429 with Retry-After', async () => {
    const ip = freshIp();
    const attempt = () =>
      login(
        { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
        { 'x-forwarded-for': ip },
      );

    // Identity limit is 3. The first three are ordinary 401s.
    const first = await attempt();
    const second = await attempt();
    const third = await attempt();
    expect([first.status, second.status, third.status]).toEqual([401, 401, 401]);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Generic: it must not say which counter tripped or whether the account exists.
    const text = JSON.stringify(blocked.body).toLowerCase();
    expect(text).not.toContain(SHARED_EMAIL.toLowerCase());
    expect(text).not.toContain('tile-shop');
    expect(text).not.toContain('identity');
  });

  it('a 429 is indistinguishable whether or not the account exists', async () => {
    const realIp = freshIp();
    const fakeIp = freshIp();
    const exhaust = async (ip: string, email: string) => {
      let last;
      for (let i = 0; i < 5; i += 1) {
        last = await login(
          { workspace: 'tile-shop', email, password: WRONG_PASSWORD },
          { 'x-forwarded-for': ip },
        );
      }
      return last!;
    };
    const real = await exhaust(realIp, SHARED_EMAIL);
    const fake = await exhaust(fakeIp, 'ghost@axlo.test');
    expect(real.status).toBe(429);
    expect(fake.status).toBe(429);
    expect(comparableError(real.body)).toEqual(comparableError(fake.body));
  });

  it('tenant A’s failures do not block tenant B for the same email', async () => {
    const ip = freshIp();
    // Exhaust the identity counter for the tile workspace.
    for (let i = 0; i < 4; i += 1) {
      await login(
        { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
        { 'x-forwarded-for': ip },
      );
    }
    const tileBlocked = await login(
      { workspace: 'tile-shop', email: SHARED_EMAIL, password: TILE_PASSWORD },
      { 'x-forwarded-for': ip },
    );
    expect(tileBlocked.status).toBe(429);

    // The SAME address in the other workspace, from a different source, is fine.
    const cafeOk = await login(
      { workspace: 'cafe-demo', email: SHARED_EMAIL, password: CAFE_PASSWORD },
      { 'x-forwarded-for': freshIp() },
    );
    expect(cafeOk.status).toBe(200);
  });

  it('a successful login clears the counters, so users are not left near a lockout', async () => {
    const ip = freshIp();
    // Two failures, then success — the classic "mistyped it twice" case.
    for (let i = 0; i < 2; i += 1) {
      await login(
        { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
        { 'x-forwarded-for': ip },
      );
    }
    const success = await login(
      { workspace: 'tile-shop', email: SHARED_EMAIL, password: TILE_PASSWORD },
      { 'x-forwarded-for': ip },
    );
    expect(success.status).toBe(200);

    // The allowance is fully restored: three more failures are still 401, not 429.
    const after = [];
    for (let i = 0; i < 3; i += 1) {
      after.push(
        (
          await login(
            { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
            { 'x-forwarded-for': ip },
          )
        ).status,
      );
    }
    expect(after).toEqual([401, 401, 401]);
  });

  it('a blocked identity does not block a different identity from the same IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i += 1) {
      await login(
        { workspace: 'tile-shop', email: SHARED_EMAIL, password: WRONG_PASSWORD },
        { 'x-forwarded-for': ip },
      );
    }
    // The IP allowance is 6 and four are spent; a different account still gets in.
    const other = await login(
      { workspace: 'tile-shop', email: SOLO_EMAIL, password: SOLO_PASSWORD },
      { 'x-forwarded-for': ip },
    );
    expect(other.status).toBe(200);
  });

  it('the IP dimension blocks a spray across many accounts', async () => {
    const ip = freshIp();
    // Each attempt uses a different email, so the identity counter never trips —
    // only the source counter can catch this, which is why both dimensions exist.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push(
        (
          await login(
            { workspace: 'tile-shop', email: `victim${i}@axlo.test`, password: WRONG_PASSWORD },
            { 'x-forwarded-for': ip },
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe('7.1 — refresh-token throttling and isolation', () => {
  it('a refresh token issued to tenant A cannot be used to reach tenant B', async () => {
    const res = await login(
      { workspace: 'tile-shop', email: SHARED_EMAIL, password: TILE_PASSWORD },
      ip(),
    );
    expect(res.status).toBe(200);
    const { refreshToken } = res.data as { refreshToken: string };

    const rotated = await http.request('POST', '/auth/refresh', {
      body: { refreshToken },
      headers: { 'x-forwarded-for': freshIp(), 'x-tenant-id': cafe.tenantId },
    });
    // The header is client-supplied and cannot move a session across tenants.
    expect(rotated.status).toBe(200);
    expect((rotated.data as { user: { tenantId: string } }).user.tenantId).toBe(tile.tenantId);
  });

  it('guessing refresh tokens from one IP is throttled', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push(
        (
          await http.request('POST', '/auth/refresh', {
            body: { refreshToken: `guess-${i}` },
            headers: { 'x-forwarded-for': ip },
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.6 — module guards over the wire
// ─────────────────────────────────────────────────────────────────────────────

describe('7.6 — module guards, enforced', () => {
  async function ownerToken(tenantId: string, userId: string): Promise<string> {
    return http.tokenFor({ userId, tenantId, role: 'OWNER' });
  }

  it('a legacy tenant (no profile row) reaches every gated route', async () => {
    // The Tile Shop compatibility guarantee, over the wire.
    const token = await ownerToken(tile.tenantId, `${'tile'}-owner`);
    for (const path of ['/suppliers?page=1&pageSize=1', '/customers?page=1&pageSize=1', '/returns?page=1&pageSize=1', '/sync/status', '/branches', '/users', '/settings']) {
      const res = await http.request('GET', path, { token });
      expect({ path, ok: res.status < 400 }).toEqual({ path, ok: true });
    }
  });

  it('an explicit Restaurant profile is denied the retail-only modules', async () => {
    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: cafe.tenantId,
        businessType: 'RESTAURANT',
        inventoryMode: 'LOCAL',
        accountingProvider: 'NONE',
      },
    });
    const token = await ownerToken(cafe.tenantId, `${'cafe'}-owner`);

    for (const path of ['/suppliers?page=1&pageSize=1', '/returns?page=1&pageSize=1', '/sync/status']) {
      const res = await http.request('GET', path, { token });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }

    // POSITIVE CONTROL: the shared-core modules a restaurant DOES have still work,
    // so the 403s above are the guard discriminating rather than the token failing.
    for (const path of ['/customers?page=1&pageSize=1', '/branches', '/settings']) {
      const res = await http.request('GET', path, { token });
      expect({ path, ok: res.status < 400 }).toEqual({ path, ok: true });
    }
  });

  it('the module denial says nothing about which modules the tenant has', async () => {
    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: cafe.tenantId,
        businessType: 'RESTAURANT',
        inventoryMode: 'LOCAL',
        accountingProvider: 'NONE',
      },
    });
    const token = await ownerToken(cafe.tenantId, `${'cafe'}-owner`);
    const res = await http.request('GET', '/suppliers?page=1&pageSize=1', { token });
    expect(res.status).toBe(403);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SUPPLIERS');
    expect(text).not.toContain('MENU_MANAGEMENT');
  });

  it('the QuickBooks OAuth callback stays reachable without a session', async () => {
    // A class-level guard here would have broken the handshake for every tenant.
    const res = await http.request('GET', '/quickbooks/callback?code=x&state=y&realmId=z');
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('hiding a control in the UI is not what protects the route', async () => {
    // Slice 6C-B.5 hides QuickBooks actions for LOCAL tenants. This proves the
    // server refuses them regardless of what the browser chose to render.
    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: cafe.tenantId,
        businessType: 'RESTAURANT',
        inventoryMode: 'LOCAL',
        accountingProvider: 'NONE',
      },
    });
    const token = await ownerToken(cafe.tenantId, `${'cafe'}-owner`);
    const res = await http.request('POST', '/quickbooks/sync', { token });
    expect(res.status).toBe(403);
  });
});
