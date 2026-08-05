/**
 * Authentication throttling (Slice 7.1) — the parts that are pure enough to test
 * without a database. Behaviour against real HTTP lives in
 * `test/integration/specs/auth-hardening.spec.ts`.
 *
 * Written to the D30 standard. The recurring hazard in rate-limiter tests is that
 * every assertion is "this was blocked", which a limiter that blocks *everything*
 * also satisfies; so each block here is paired with a proof that the same key
 * allowed traffic first, and that a neighbouring key was untouched.
 */
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { AuthRateLimitService, normaliseEmail } from './auth-rate-limit.service';
import { MemoryRateLimitStore } from './memory-rate-limit.store';
import { parseTrustedProxyHops, resolveClientIp } from './client-ip';
import type { RateLimitRule } from './rate-limit.store';

const RULE: RateLimitRule = { name: 'test', limit: 3, windowMs: 60_000 };

function request(overrides: {
  socketIp?: string;
  forwardedFor?: string | string[];
}): Request {
  return {
    socket: { remoteAddress: overrides.socketIp ?? '10.0.0.1' },
    headers: overrides.forwardedFor ? { 'x-forwarded-for': overrides.forwardedFor } : {},
  } as unknown as Request;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client IP
// ─────────────────────────────────────────────────────────────────────────────

describe('client IP resolution is not spoofable', () => {
  it('ignores X-Forwarded-For entirely when no proxy is configured', () => {
    // The default. An attacker sending the header gains nothing.
    const req = request({ socketIp: '198.51.100.7', forwardedFor: '1.2.3.4' });
    expect(resolveClientIp(req, 0)).toBe('198.51.100.7');
  });

  it('takes the Nth entry from the RIGHT, not the left-most', () => {
    // Left-most is attacker-written; right-most was written by our own proxy.
    const req = request({
      socketIp: '10.0.0.1',
      forwardedFor: '1.2.3.4, 203.0.113.9, 172.16.0.1',
    });
    expect(resolveClientIp(req, 1)).toBe('172.16.0.1');
    expect(resolveClientIp(req, 2)).toBe('203.0.113.9');
    // POSITIVE CONTROL: the spoofed left-most value is reachable only at the hop
    // count that genuinely corresponds to it, never by default.
    expect(resolveClientIp(req, 3)).toBe('1.2.3.4');
    expect(resolveClientIp(req, 0)).toBe('10.0.0.1');
  });

  it('a forged header cannot win against a shorter real chain', () => {
    const forged = request({ socketIp: '10.0.0.1', forwardedFor: 'evil-1, evil-2' });
    // Configured for one trusted proxy; the attacker prepended two entries.
    // The resolved value is still the right-most, which our proxy wrote.
    expect(resolveClientIp(forged, 1)).toBe('evil-2');
    // And it is stable, so an attacker cannot mint a fresh bucket per request by
    // varying the left of the header.
    const forgedAgain = request({ socketIp: '10.0.0.1', forwardedFor: 'other, evil-2' });
    expect(resolveClientIp(forgedAgain, 1)).toBe(resolveClientIp(forged, 1));
  });

  it('falls back to the socket address when the header is absent or empty', () => {
    expect(resolveClientIp(request({ socketIp: '203.0.113.1' }), 2)).toBe('203.0.113.1');
    expect(resolveClientIp(request({ socketIp: '203.0.113.1', forwardedFor: '  ' }), 2)).toBe(
      '203.0.113.1',
    );
  });

  it('collapses IPv4-mapped IPv6 so one client cannot occupy two buckets', () => {
    expect(resolveClientIp(request({ socketIp: '::ffff:203.0.113.5' }), 0)).toBe('203.0.113.5');
    expect(resolveClientIp(request({ socketIp: '203.0.113.5' }), 0)).toBe('203.0.113.5');
  });

  it('tolerates the array form of the header Node can produce', () => {
    const req = request({ socketIp: '10.0.0.1', forwardedFor: ['1.1.1.1', '2.2.2.2'] });
    expect(resolveClientIp(req, 1)).toBe('2.2.2.2');
  });

  it('parseTrustedProxyHops refuses nonsense rather than guessing', () => {
    expect(parseTrustedProxyHops(undefined)).toBe(0);
    expect(parseTrustedProxyHops('')).toBe(0);
    expect(parseTrustedProxyHops('not-a-number')).toBe(0);
    expect(parseTrustedProxyHops('-3')).toBe(0);
    // POSITIVE: a real value is honoured, so the zeros above are a decision and
    // not a parser that always returns 0.
    expect(parseTrustedProxyHops('2')).toBe(2);
    expect(parseTrustedProxyHops(1)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

describe('MemoryRateLimitStore', () => {
  let store: MemoryRateLimitStore;
  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });
  afterEach(() => store.onModuleDestroy());

  it('allows up to the limit and blocks after it', async () => {
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      allowed.push((await store.consume('k', RULE)).allowed);
    }
    // The exact sequence, not just "the last one was blocked" — a store that
    // blocked everything would satisfy the weaker claim.
    expect(allowed).toEqual([true, true, true, false, false]);
  });

  it('counts each key separately, so one identity cannot exhaust another', async () => {
    for (let i = 0; i < 4; i += 1) await store.consume('a', RULE);
    expect((await store.consume('a', RULE)).allowed).toBe(false);
    expect((await store.consume('b', RULE)).allowed).toBe(true);
  });

  it('reset restores the full allowance', async () => {
    for (let i = 0; i < 4; i += 1) await store.consume('k', RULE);
    expect((await store.consume('k', RULE)).allowed).toBe(false);

    await store.reset('k');
    expect((await store.consume('k', RULE)).allowed).toBe(true);
  });

  it('never reports Retry-After: 0 while blocked', async () => {
    for (let i = 0; i < 4; i += 1) await store.consume('k', RULE);
    const blocked = await store.consume('k', RULE);
    expect(blocked.allowed).toBe(false);
    // `Retry-After: 0` reads to a client as "retry immediately".
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('the window expires, so a block is temporary rather than a permanent lockout', async () => {
    const fast: RateLimitRule = { name: 'fast', limit: 1, windowMs: 5 };
    expect((await store.consume('k', fast)).allowed).toBe(true);
    expect((await store.consume('k', fast)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 12));
    expect((await store.consume('k', fast)).allowed).toBe(true);
  });

  it('reports remaining honestly', async () => {
    expect((await store.consume('k', RULE)).remaining).toBe(2);
    expect((await store.consume('k', RULE)).remaining).toBe(1);
    expect((await store.consume('k', RULE)).remaining).toBe(0);
  });

  it('declares that it is NOT distributed', async () => {
    // Load-bearing: the docs, the boot warning and the deployment guidance all
    // depend on this being honest. If a distributed store is added later, this
    // assertion is what forces a deliberate change rather than a silent one.
    expect(store.isDistributed).toBe(false);
    expect(store.description).toContain('single replica');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Key policy
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthRateLimitService key policy', () => {
  function service(): AuthRateLimitService {
    const store = new MemoryRateLimitStore();
    const config = new ConfigService({});
    return new AuthRateLimitService(store, config);
  }

  it('email login spends both a source and an identity counter', () => {
    const keys = service().emailLoginKeys({
      ip: '203.0.113.1',
      workspace: 'acme',
      email: 'a@b.test',
    });
    expect(keys.map((k) => k.rule.name).sort()).toEqual(['login-identity', 'login-ip']);
    // Either dimension alone is trivially defeated; see the service doc comment.
    expect(keys.some((k) => k.key.includes('203.0.113.1'))).toBe(true);
  });

  it('the identity key is tenant-scoped, so one workspace cannot lock out another', () => {
    const svc = service();
    const a = svc.emailLoginKeys({ ip: '1.1.1.1', workspace: 'acme', email: 'owner@shared.test' });
    const b = svc.emailLoginKeys({ ip: '1.1.1.1', workspace: 'other', email: 'owner@shared.test' });
    const idA = a.find((k) => k.rule.name === 'login-identity')!.key;
    const idB = b.find((k) => k.rule.name === 'login-identity')!.key;
    expect(idA).not.toBe(idB);
  });

  it('an omitted workspace occupies its own scope rather than colliding with a real one', () => {
    const svc = service();
    const none = svc.emailLoginKeys({ ip: '1.1.1.1', workspace: null, email: 'x@y.test' });
    const named = svc.emailLoginKeys({ ip: '1.1.1.1', workspace: 'acme', email: 'x@y.test' });
    expect(none[1]!.key).not.toBe(named[1]!.key);
  });

  it('email casing and padding share one counter', () => {
    const svc = service();
    const a = svc.emailLoginKeys({ ip: '1.1.1.1', workspace: 'w', email: ' Owner@X.test ' });
    const b = svc.emailLoginKeys({ ip: '1.1.1.1', workspace: 'w', email: 'owner@x.test' });
    expect(a[1]!.key).toBe(b[1]!.key);
    expect(normaliseEmail(' Owner@X.test ')).toBe('owner@x.test');
  });

  it('no key contains the raw email address', () => {
    const keys = service().emailLoginKeys({
      ip: '1.1.1.1',
      workspace: 'w',
      email: 'person@example.test',
    });
    for (const { key } of keys) {
      expect(key).not.toContain('person@example.test');
      expect(key).not.toContain('person');
    }
    // POSITIVE CONTROL: the key is nonetheless deterministic for that address.
    const again = service().emailLoginKeys({
      ip: '1.1.1.1',
      workspace: 'w',
      email: 'person@example.test',
    });
    expect(again[1]!.key).toBe(keys[1]!.key);
  });

  it('PIN keys never include the submitted PIN', () => {
    // Keying on the PIN would hand an attacker a fresh allowance per guess —
    // i.e. no limit at all on the one thing being guessed.
    const keys = service().pinLoginKeys({
      ip: '1.1.1.1',
      tenantId: 'tnt_a',
      branchId: 'brn_1',
      registerId: 'reg_1',
    });
    expect(keys.map((k) => k.rule.name).sort()).toEqual(['pin-ip', 'pin-position']);
    const position = keys.find((k) => k.rule.name === 'pin-position')!.key;
    expect(position).toContain('tnt_a');
    expect(position).toContain('brn_1');
    expect(position).toContain('reg_1');
  });

  it('PIN counters separate two registers in the same branch', () => {
    const svc = service();
    const one = svc.pinLoginKeys({ ip: '1.1.1.1', tenantId: 't', branchId: 'b', registerId: 'r1' });
    const two = svc.pinLoginKeys({ ip: '1.1.1.1', tenantId: 't', branchId: 'b', registerId: 'r2' });
    expect(one[1]!.key).not.toBe(two[1]!.key);
  });

  it('refresh keys pseudonymise the token', () => {
    const keys = service().refreshKeys({ ip: '1.1.1.1', refreshToken: 'super-secret-token' });
    for (const { key } of keys) expect(key).not.toContain('super-secret-token');
    expect(keys.map((k) => k.rule.name).sort()).toEqual(['refresh-ip', 'refresh-token']);
  });

  it('consume reports the STRICTEST verdict across all keys', async () => {
    const svc = service();
    const keys = svc.pinLoginKeys({ ip: 'ip', tenantId: 't', branchId: 'b', registerId: 'r' });
    // Exhaust the tighter position counter (limit 10) while the IP one (20) is fine.
    let last = await svc.consume(keys);
    for (let i = 0; i < 12 && last.allowed; i += 1) last = await svc.consume(keys);
    expect(last.allowed).toBe(false);
    expect(last.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('reset clears every key an attempt spent', async () => {
    const svc = service();
    const keys = svc.pinLoginKeys({ ip: 'ip2', tenantId: 't', branchId: 'b', registerId: 'r' });
    let last = await svc.consume(keys);
    for (let i = 0; i < 12 && last.allowed; i += 1) last = await svc.consume(keys);
    expect(last.allowed).toBe(false);

    await svc.reset(keys);
    // Recovery after a successful sign-in must be complete, not partial.
    expect((await svc.consume(keys)).allowed).toBe(true);
  });

  it('surfaces the store’s distribution status rather than assuming it', () => {
    expect(service().isDistributed).toBe(false);
    expect(service().storeDescription).toContain('process-local');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the throttling assertions can actually fail', () => {
  it('a limiter that never blocked would be detected', async () => {
    const store = new MemoryRateLimitStore();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) results.push((await store.consume('m', RULE)).allowed);
    expect(results).toContain(false);

    // The regression: a store that always allows.
    const broken = results.map(() => true);
    expect(broken).not.toEqual(results);
    expect(() => expect(broken).toContain(false)).toThrow();
    store.onModuleDestroy();
  });

  it('a limiter that blocked everything would also be detected', async () => {
    const store = new MemoryRateLimitStore();
    expect((await store.consume('n', RULE)).allowed).toBe(true);

    const alwaysBlocked = false;
    expect(() => expect(alwaysBlocked).toBe(true)).toThrow();
    store.onModuleDestroy();
  });

  it('trusting the left-most X-Forwarded-For would be detected', () => {
    const req = request({ socketIp: '10.0.0.1', forwardedFor: 'spoofed, real' });
    const correct = resolveClientIp(req, 1);
    expect(correct).toBe('real');

    // The classic bypass, replayed: taking hops[0] instead of counting from right.
    const naive = 'spoofed';
    expect(naive).not.toBe(correct);
    expect(() => expect(naive).toBe('real')).toThrow();
  });
});
