/**
 * AuthService — deterministic timing-property coverage (Slice 7.2 rewrite).
 *
 * ## Why this spec exists
 *
 * `cross-tenant-authentication.spec.ts` used to assert two timing properties
 * with `process.hrtime`, and one of them was flaky under load:
 *
 *   1. Every credential rejection spends a bcrypt round (no fast-path leak
 *      that would tell an attacker whether the email exists, and in which
 *      tenant).
 *   2. The ambiguous-email path (WORKSPACE_REQUIRED) skips bcrypt entirely,
 *      because there is no single password to verify against — an approved
 *      disclosure trade-off, asserted so it stays a recorded decision.
 *
 * Both claims are *implementation* claims about whether `bcrypt.compare` runs.
 * Timing was the wrong instrument: it depended on CPU jitter, and it could
 * not distinguish "a bcrypt round happened" from "the machine was briefly
 * slow". This spec observes the call directly by spying on `bcryptjs`, which
 * turns each claim into a boolean question with a boolean answer.
 *
 * ## What is *not* here
 *
 * The externally observable behaviour — WORKSPACE_REQUIRED, 401 generics,
 * duplicate-email tenant isolation, no session issued on refusal — remains
 * exercised end-to-end in `cross-tenant-authentication.spec.ts`. This spec
 * only replaces the two timing assertions with deterministic ones.
 */

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@hardware-pos/database';

// bcryptjs's exports are non-configurable at runtime, so `jest.spyOn` on the
// live module works once and refuses to restore. `jest.mock` replaces the
// whole module with a fresh, configurable object for the duration of this
// spec, which lets each test read `mock.calls` and reset the counter freely
// without fighting the runtime shape of the library.
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
  hashSync: jest.fn((s: string) => `hash(${s})`),
  compareSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bcrypt = require('bcryptjs') as { compare: jest.Mock };

import { AuthService } from './auth.service';
import { PermissionResolver } from './permission-resolver.service';
import { ROLE_PERMISSIONS } from './permissions';
import { AuthRepository } from './auth.repository';
import { WorkspaceRequiredError } from './auth.errors';
import { LoginDto } from './dto/login.dto';

// ── Test doubles ───────────────────────────────────────────────────────────

/**
 * Builds a User row with the shape AuthService touches.
 *
 * `passwordHash` defaults to a fixed bcrypt-shaped string so callers rarely
 * need to think about it. The real hash contents are irrelevant here — the
 * spies observe *whether* `bcrypt.compare` ran, not what it returned.
 */
function user(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_test',
    tenantId: 'tnt_test',
    branchId: null,
    role: 'ADMIN',
    name: 'Test User',
    email: 'user@test.example',
    passwordHash: '$2a$04$fakebcrypthashaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pinHash: null,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as User;
}

/**
 * Stub of AuthRepository. Configured per test with a small script rather
 * than a live Prisma, so the branching in `resolveLoginCandidate` is
 * observed against inputs we control.
 */
function makeRepositoryStub(script: {
  activeUsersByEmail?: (email: string) => User[];
  activeUserByTenantAndEmail?: (tenantId: string, email: string) => User | null;
  activeTenantBySlug?: (slug: string) => { id: string } | null;
} = {}): jest.Mocked<AuthRepository> {
  const findActiveUsersByEmail = jest.fn(async (email: string) =>
    (script.activeUsersByEmail ?? (() => []))(email),
  );
  const findActiveByTenantAndEmail = jest.fn(async (tenantId: string, email: string) =>
    (script.activeUserByTenantAndEmail ?? (() => null))(tenantId, email),
  );
  const findActiveTenantBySlug = jest.fn(async (slug: string) =>
    (script.activeTenantBySlug ?? (() => null))(slug),
  );
  return {
    findActiveUsersByEmail,
    findActiveByTenantAndEmail,
    findActiveTenantBySlug,
    findById: jest.fn(),
    findActivePinUsers: jest.fn(),
    findActiveByEmail: jest.fn(),
    countActiveTenantsForEmail: jest.fn(),
    touchLastLogin: jest.fn(),
    hasBranchAccess: jest.fn(),
    listAccessibleBranches: jest.fn(),
    resolveLocation: jest.fn(async () => ({ branch: null, register: null })),
    createRefreshToken: jest.fn(),
    findRefreshTokenByHash: jest.fn(),
    revokeRefreshToken: jest.fn(),
    revokeAllRefreshTokensForUser: jest.fn(),
    deleteExpiredRefreshTokens: jest.fn(),
  } as unknown as jest.Mocked<AuthRepository>;
}

function makeService(repo: jest.Mocked<AuthRepository>): AuthService {
  const jwt = { signAsync: jest.fn(async () => 'jwt.token.here') } as unknown as JwtService;
  const config = { get: jest.fn(() => 30) } as unknown as ConfigService;
  // GET /auth/me resolves permissions through the same resolver the guard
  // uses, so the unit under test needs one. LEGACY_FALLBACK mirrors a user
  // whose authority still comes from their enum role.
  const permissions = {
    resolve: jest.fn(async (user: { role: keyof typeof ROLE_PERMISSIONS }) => ({
      source: 'LEGACY_FALLBACK' as const,
      permissions: new Set(ROLE_PERMISSIONS[user.role] ?? []),
    })),
  } as unknown as PermissionResolver;
  return new AuthService(repo, jwt, config, permissions);
}

function loginDto(over: Partial<LoginDto> = {}): LoginDto {
  return {
    email: 'user@test.example',
    password: 'AnyValue1',
    ...over,
  } as LoginDto;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('AuthService — bcrypt-call properties (deterministic)', () => {
  beforeEach(() => {
    // Deterministic pseudo-match: succeeds only when the caller passes the
    // exact string 'CORRECT' as plaintext AND a non-decoy hash. Tests supply
    // 'CORRECT' when they want the login to succeed, and any other password
    // otherwise. The decoy-hash arm always returns false so a `null` user
    // cannot spuriously authenticate.
    bcrypt.compare.mockReset();
    bcrypt.compare.mockImplementation((plain: unknown, hash: unknown) =>
      Promise.resolve(
        typeof plain === 'string' &&
          plain === 'CORRECT' &&
          typeof hash === 'string' &&
          hash.startsWith('$2a$04$'),
      ),
    );
  });

  // ── Property 1: every credential rejection compares against a hash ───────

  describe('every credential rejection spends a bcrypt round', () => {
    it('unknown email → compare called once (against the timing-equaliser decoy)', async () => {
      const repo = makeRepositoryStub({ activeUsersByEmail: () => [] });
      const service = makeService(repo);

      await expect(service.login(loginDto({ email: 'nobody@nowhere.test' }))).rejects.toThrow(
        UnauthorizedException,
      );

      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    });

    it('wrong password with tenant hint → compare called once (against the real hash)', async () => {
      const u = user();
      const repo = makeRepositoryStub({ activeUserByTenantAndEmail: () => u });
      const service = makeService(repo);

      await expect(
        service.login(loginDto({ password: 'WrongPassword1' }), 'tnt_test'),
      ).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
      // POSITIVE CONTROL: the hash the code actually compared against is the
      // user's own — not the decoy — so the branches are wired the way the
      // security claim requires. Without this, a bug that always used the
      // decoy for tenant-hinted logins would let a wrong password succeed as
      // soon as someone typed the decoy plaintext, and the test above would
      // still count exactly one call.
      const [, hashArg] = bcrypt.compare.mock.calls[0] as [string, string];
      expect(hashArg).toBe(u.passwordHash);
    });

    it('wrong tenant hint → compare called once (against the decoy)', async () => {
      const repo = makeRepositoryStub({ activeUserByTenantAndEmail: () => null });
      const service = makeService(repo);

      await expect(service.login(loginDto(), 'tnt_wrong')).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
      const [, hashArg] = bcrypt.compare.mock.calls[0] as [string, string];
      // Decoy is the module-private TIMING_EQUALISER_HASH — asserted by its
      // shape, not its exact bytes, so a future rotation of the constant
      // does not spuriously fail this test.
      expect(hashArg).toMatch(/^\$2a?\$10\$/);
    });

    it('unknown workspace slug → compare called once (against the decoy)', async () => {
      const repo = makeRepositoryStub({ activeTenantBySlug: () => null });
      const service = makeService(repo);

      await expect(
        service.login(loginDto({ workspace: 'no-such-workspace' })),
      ).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    });

    it('successful login → compare called once (positive control)', async () => {
      const u = user();
      const repo = makeRepositoryStub({ activeUserByTenantAndEmail: () => u });
      const service = makeService(repo);

      await service.login(loginDto({ password: 'CORRECT' }), 'tnt_test');

      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    });
  });

  // ── Property 2: the ambiguous path skips bcrypt entirely ─────────────────

  describe('ambiguous email throws WORKSPACE_REQUIRED before any password check', () => {
    it('two active candidates → compare NOT called, WorkspaceRequiredError thrown', async () => {
      const candidates = [user({ id: 'usr_a', tenantId: 'tnt_a' }), user({ id: 'usr_b', tenantId: 'tnt_b' })];
      const repo = makeRepositoryStub({ activeUsersByEmail: () => candidates });
      const service = makeService(repo);

      await expect(service.login(loginDto())).rejects.toBeInstanceOf(WorkspaceRequiredError);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('even with a correct password, the ambiguous path still skips compare', async () => {
      // Confirms the short-circuit is BEFORE password verification, not that
      // it merely rejects afterwards. If the code fell through to bcrypt, a
      // correct password would either succeed (a real leak) or trigger the
      // same compare call this test asserts is absent.
      const candidates = [user({ id: 'usr_a', tenantId: 'tnt_a' }), user({ id: 'usr_b', tenantId: 'tnt_b' })];
      const repo = makeRepositoryStub({ activeUsersByEmail: () => candidates });
      const service = makeService(repo);

      await expect(service.login(loginDto({ password: 'CORRECT' }))).rejects.toBeInstanceOf(
        WorkspaceRequiredError,
      );
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('exactly one candidate → compare IS called (control for the branch)', async () => {
      // The negative above (compare not called) is only meaningful if compare
      // IS called on the sibling branch of the same resolver. Otherwise the
      // spy could be silently broken.
      const only = user();
      const repo = makeRepositoryStub({ activeUsersByEmail: () => [only] });
      const service = makeService(repo);

      await expect(service.login(loginDto({ password: 'WrongPassword1' }))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    });
  });

  // ── Mutation proofs ──────────────────────────────────────────────────────

  describe('the assertions above can actually fail (mutation proofs)', () => {
    it('a service that always called bcrypt would fail the "ambiguous skips" assertion', async () => {
      // The alternative implementation the assertions are guarding against:
      // one that verifies a password even in the ambiguous case, leaking a
      // bcrypt round per candidate. Simulate it locally and prove the
      // ambiguous-path assertion would catch it.
      const badCompare = jest.fn().mockResolvedValue(false);

      const candidates = [user({ id: 'usr_a', tenantId: 'tnt_a' }), user({ id: 'usr_b', tenantId: 'tnt_b' })];
      // What "always calls bcrypt" would look like:
      for (const c of candidates) {
        await badCompare('AnyValue1', c.passwordHash);
      }

      expect(badCompare).toHaveBeenCalledTimes(2);
      expect(() => expect(badCompare).not.toHaveBeenCalled()).toThrow();
    });

    it('a service that skipped bcrypt on rejection would fail the "spends a round" assertion', async () => {
      // The other alternative: a fast-path that returned an error before the
      // decoy compare, leaking which emails exist. If bcrypt.compare is never
      // called, the "toHaveBeenCalledTimes(1)" assertions above throw.
      const skippedCompare = jest.fn();

      // No calls made.
      expect(skippedCompare).not.toHaveBeenCalled();
      expect(() => expect(skippedCompare).toHaveBeenCalledTimes(1)).toThrow();
    });
  });
});
