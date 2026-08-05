import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  RATE_LIMIT_STORE,
  RateLimitDecision,
  RateLimitRule,
  RateLimitStore,
} from './rate-limit.store';

/**
 * Which counters each authentication attempt spends (Slice 7.1).
 *
 * ## Two dimensions, both required
 *
 * Every attempt is counted against **both** a source dimension and an identity
 * dimension, and the strictest verdict wins. Either alone is trivially defeated:
 *
 *  • **Identity only** — one attacker with a botnet spreads across addresses but
 *    hammers a single account. Counting per account catches that.
 *  • **Source only** — one attacker from one address sprays one guess across ten
 *    thousand accounts (credential stuffing). Counting per address catches that.
 *
 * ## Why the identity key is tenant-scoped
 *
 * `User` is `@@unique([tenantId, email])`, so the same address legitimately exists
 * in several tenants. Keying on the email alone would let a failed campaign against
 * `owner@acme.test` in tenant A lock out the unrelated `owner@acme.test` in tenant
 * B — one tenant denying service to another through nothing but a shared address.
 * The key therefore always carries the workspace scope, and an attempt with no
 * workspace occupies its own `-` scope rather than colliding with a real one.
 *
 * ## Why identities are hashed
 *
 * Keys reach logs and, in a future Redis store, another system's storage. An email
 * address is personal data, so only a truncated SHA-256 goes in the key. It is a
 * stable pseudonym — equal inputs give equal keys, which is all a counter needs.
 *
 * ## Reset on success
 *
 * A successful authentication clears that attempt's keys. Four typos followed by
 * the right password must not leave someone one mistake from a lockout: a limiter
 * that punishes recovery becomes a self-inflicted outage.
 */
@Injectable()
export class AuthRateLimitService {
  private readonly logger = new Logger(AuthRateLimitService.name);

  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    private readonly config: ConfigService,
  ) {
    if (!this.store.isDistributed) {
      // Said once, loudly, at boot. A limitation recorded only in a comment is a
      // limitation the person deploying this will never see.
      this.logger.warn(
        `Authentication throttling uses a ${this.store.description} store. ` +
          'This protects a single API replica only — with several replicas behind a ' +
          'load balancer each holds its own counters, multiplying the effective ' +
          'allowance. Provide a distributed RateLimitStore or an edge rate limiter ' +
          'before running more than one replica.',
      );
    }
  }

  /**
   * Email + password login.
   *
   * `workspace` is the tenant slug when the client supplied one, or `null`. It is
   * client-supplied and unverified at this point, which is fine: it only *narrows*
   * a counter. A caller who lies about it gets their own bucket rather than access
   * to someone else's allowance.
   */
  emailLoginKeys(input: { ip: string; workspace: string | null; email: string }): RateLimitKey[] {
    const scope = normaliseScope(input.workspace);
    return [
      { rule: this.rule('login-ip', DEFAULTS.loginIp), key: `login:ip:${input.ip}` },
      {
        rule: this.rule('login-identity', DEFAULTS.loginIdentity),
        key: `login:id:${scope}:${pseudonym(normaliseEmail(input.email))}`,
      },
    ];
  }

  /**
   * PIN login.
   *
   * PINs are four digits, so the identity keyspace is tiny and the allowance is
   * correspondingly tighter than for passwords. The identity dimension is the
   * physical position — tenant, branch, register — because that is what a PIN
   * actually authenticates against, and because the *submitted PIN* must not be
   * part of any key: keying on it would give an attacker a fresh allowance for
   * every guess, which is precisely the attack.
   */
  pinLoginKeys(input: {
    ip: string;
    tenantId: string;
    branchId: string | null;
    registerId: string | null;
  }): RateLimitKey[] {
    const position = `${input.tenantId}:${input.branchId ?? '-'}:${input.registerId ?? '-'}`;
    return [
      { rule: this.rule('pin-ip', DEFAULTS.pinIp), key: `pin:ip:${input.ip}` },
      { rule: this.rule('pin-position', DEFAULTS.pinPosition), key: `pin:pos:${position}` },
    ];
  }

  /**
   * Refresh-token exchange.
   *
   * Rotation already revokes every session on replay, so this is not the primary
   * defence — it exists to stop a token-guessing loop being free. Keyed on source
   * and on the presented token's hash, never the token itself.
   */
  refreshKeys(input: { ip: string; refreshToken: string }): RateLimitKey[] {
    return [
      { rule: this.rule('refresh-ip', DEFAULTS.refreshIp), key: `refresh:ip:${input.ip}` },
      {
        rule: this.rule('refresh-token', DEFAULTS.refreshToken),
        key: `refresh:tok:${pseudonym(input.refreshToken)}`,
      },
    ];
  }

  /**
   * Count one attempt against every key, and report the strictest verdict.
   *
   * All keys are consumed even once one has failed, so a blocked attacker keeps
   * extending the window they are blocked for rather than getting the other
   * counters back for free.
   */
  async consume(keys: RateLimitKey[]): Promise<RateLimitDecision> {
    const decisions = await Promise.all(keys.map(({ key, rule }) => this.store.consume(key, rule)));
    const blocked = decisions.filter((d) => !d.allowed);
    if (blocked.length === 0) {
      return {
        allowed: true,
        remaining: Math.min(...decisions.map((d) => d.remaining)),
        retryAfterSeconds: 0,
      };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(...blocked.map((d) => d.retryAfterSeconds)),
    };
  }

  /** Forget these keys after a successful authentication. */
  async reset(keys: RateLimitKey[]): Promise<void> {
    await Promise.all(keys.map(({ key }) => this.store.reset(key)));
  }

  /** Is the configured store safe for more than one API replica? */
  get isDistributed(): boolean {
    return this.store.isDistributed;
  }

  get storeDescription(): string {
    return this.store.description;
  }

  /**
   * Rules are env-overridable so a deployment can tighten them and a test can use a
   * small window without waiting.
   *
   * `ConfigService` returns environment variables as **strings**, and the generic
   * parameter does not convert them. Reading `windowMs` straight through therefore
   * gave the store a string, and `Date.now() + '60000'` concatenates rather than
   * adds — producing a window roughly five thousand years long, i.e. a permanent
   * lockout for anyone who ever tripped the limit. The defaults are numeric
   * literals so this only bit a deployment that actually set the variable, which
   * is exactly the kind of bug that reaches production. Coerced explicitly, with a
   * fallback for anything non-numeric.
   */
  private rule(name: string, fallback: { limit: number; windowMs: number }): RateLimitRule {
    const envName = `RATE_LIMIT_${name.toUpperCase().replace(/-/g, '_')}`;
    return {
      name,
      limit: positiveNumber(this.config.get(`${envName}_LIMIT`), fallback.limit),
      windowMs: positiveNumber(this.config.get(`${envName}_WINDOW_MS`), fallback.windowMs),
    };
  }
}

export interface RateLimitKey {
  rule: RateLimitRule;
  key: string;
}

/**
 * Default allowances.
 *
 * Chosen to sit far above real human error and far below anything useful to an
 * attacker. A cashier who fumbles a PIN twice a shift never notices; 10 PIN guesses
 * per 5 minutes against one register is 0.1% of the 4-digit space per hour.
 */
const DEFAULTS = {
  loginIp: { limit: 20, windowMs: 5 * 60_000 },
  loginIdentity: { limit: 8, windowMs: 15 * 60_000 },
  pinIp: { limit: 20, windowMs: 5 * 60_000 },
  pinPosition: { limit: 10, windowMs: 5 * 60_000 },
  refreshIp: { limit: 60, windowMs: 5 * 60_000 },
  refreshToken: { limit: 10, windowMs: 5 * 60_000 },
} as const;

/** Coerce a config value to a positive number, falling back rather than guessing. */
function positiveNumber(raw: unknown, fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Lower-case and trim, so `Owner@X.test ` and `owner@x.test` share a counter. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lower-case the workspace slug; `null` becomes its own scope, never a real one. */
function normaliseScope(workspace: string | null): string {
  const trimmed = workspace?.trim().toLowerCase() ?? '';
  return trimmed.length > 0 ? trimmed : '-';
}

/** A stable, non-reversible stand-in for personal data inside a storage key. */
function pseudonym(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
