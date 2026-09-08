import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_LEVEL_ROLES, ALL_USER_ROLES, UserRole } from '@hardware-pos/shared';

import { BranchScopeGuard } from './branch-scope.guard';
import { BRANCH_SCOPE_METADATA, BranchScopeKind } from '../decorators/branch-scope.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../modules/auth/auth.types';

/**
 * The guard's cross-branch contract, in isolation from HTTP and the database.
 *
 * The branch-scope integration spec drives the same guard over real routes
 * against a real database. This spec exists for one question that is awkward
 * to ask over the wire and easy to get silently wrong in code: WHICH roles the
 * guard lets into a branch with no grant at all. D108 widened that from
 * `role === 'OWNER' || role === 'ADMIN'` to `isAdminLevelRole`, so the set is
 * asserted as an exact set derived from the one authority (`ADMIN_LEVEL_ROLES`)
 * over the whole enum (`ALL_USER_ROLES`) — a role added to either without the
 * other fails here by name — and the table lookups are runtime spies (D30.4),
 * not a reading of the guard's source.
 */
describe('BranchScopeGuard', () => {
  const TENANT = 'tnt_a';
  const BRANCH = 'brn_1';

  type ScopedRequest = { user?: AuthenticatedUser; effectiveBranchId?: string };

  function context(request: ScopedRequest): ExecutionContext {
    return {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  interface Fixture {
    role: UserRole;
    /** The token's `activeBranchId` claim. `null` is a tenant-wide session. */
    activeBranchId?: string | null;
    /** `User.branchId` — the default branch. `null` for a user with none. */
    homeBranchId?: string | null;
    /** The `BranchAccess` row for (user, candidate). `null` is no grant. */
    grant?: { id: string } | null;
    /** The candidate branch row. `null` is foreign, deleted or inactive. */
    branch?: { id: string } | null;
    /** `false` simulates a user deactivated since the token was minted. */
    activeUser?: boolean;
    scope?: BranchScopeKind;
    isPublic?: boolean;
  }

  /** `Guard` is only ever overridden by the runtime mutation proof at the end. */
  function build(fixture: Fixture, Guard: typeof BranchScopeGuard = BranchScopeGuard) {
    const user: AuthenticatedUser = {
      id: `usr_${fixture.role.toLowerCase()}`,
      tenantId: TENANT,
      role: fixture.role,
      activeBranchId: fixture.activeBranchId === undefined ? BRANCH : fixture.activeBranchId,
    };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return fixture.isPublic ?? false;
        if (key === BRANCH_SCOPE_METADATA) return fixture.scope ?? BranchScopeKind.BRANCH_SCOPED;
        return undefined;
      }),
    } as unknown as Reflector;
    const userFindFirst = jest.fn().mockResolvedValue(
      fixture.activeUser === false
        ? null
        : { id: user.id, role: fixture.role, branchId: fixture.homeBranchId ?? null },
    );
    const branchFindFirst = jest
      .fn()
      .mockResolvedValue(fixture.branch === undefined ? { id: BRANCH } : fixture.branch);
    const branchAccessFindUnique = jest.fn().mockResolvedValue(fixture.grant ?? null);
    const prisma = {
      user: { findFirst: userFindFirst },
      branch: { findFirst: branchFindFirst },
      branchAccess: { findUnique: branchAccessFindUnique },
    } as unknown as PrismaService;
    return {
      guard: new Guard(reflector, prisma),
      user,
      userFindFirst,
      branchFindFirst,
      branchAccessFindUnique,
    };
  }

  /** Runs the guard once and reports the outcome without throwing. */
  async function attempt(fixture: Fixture, Guard?: typeof BranchScopeGuard) {
    const built = build(fixture, Guard);
    const request: ScopedRequest = { user: built.user };
    let passed = false;
    let error: unknown = null;
    try {
      passed = await built.guard.canActivate(context(request));
    } catch (e) {
      error = e;
    }
    return { ...built, role: fixture.role, request, passed, error };
  }

  /** The fixture that isolates the role: no grant, no default branch, a live branch. */
  const noGrant = { homeBranchId: null, grant: null } as const;

  const ownerLevel = [...ADMIN_LEVEL_ROLES].sort();
  const notOwnerLevel = ALL_USER_ROLES.filter((r) => !ADMIN_LEVEL_ROLES.includes(r)).sort();

  describe('who reaches a branch with no grant at all', () => {
    it('exactly the owner-level roles pass; every other role is refused as stale', async () => {
      const outcomes = await Promise.all(
        ALL_USER_ROLES.map((role) => attempt({ role, ...noGrant })),
      );
      const passed = outcomes.filter((o) => o.passed).map((o) => o.role).sort();
      const refused = outcomes.filter((o) => !o.passed).map((o) => o.role).sort();

      expect(passed).toEqual(ownerLevel);
      expect(refused).toEqual(notOwnerLevel);
      // Positive controls, by name, so neither exact set is satisfied by an
      // enum that has quietly shrunk: the D108 widening is in, the till is out.
      expect(passed).toContain('SALESPERSON');
      expect(passed).toContain('OWNER');
      expect(refused).toContain('CASHIER');
      expect(passed.length + refused.length).toBe(ALL_USER_ROLES.length);

      for (const o of outcomes.filter((x) => x.passed)) {
        expect({ role: o.role, effectiveBranchId: o.request.effectiveBranchId }).toEqual({
          role: o.role,
          effectiveBranchId: BRANCH,
        });
      }
      for (const o of outcomes.filter((x) => !x.passed)) {
        expect({ role: o.role, error: o.error }).toEqual({
          role: o.role,
          error: expect.any(ForbiddenException),
        });
        expect((o.error as ForbiddenException).message).toBe(
          'Access to this branch has been removed',
        );
        expect(o.request.effectiveBranchId).toBeUndefined();
      }
    });

    it('never consults BranchAccess for an owner-level role, and always does for the rest', async () => {
      const outcomes = await Promise.all(
        ALL_USER_ROLES.map((role) => attempt({ role, ...noGrant })),
      );
      const skipped = outcomes
        .filter((o) => o.branchAccessFindUnique.mock.calls.length === 0)
        .map((o) => o.role)
        .sort();
      const consulted = outcomes
        .filter((o) => o.branchAccessFindUnique.mock.calls.length > 0)
        .map((o) => o.role)
        .sort();

      expect(skipped).toEqual(ownerLevel);
      expect(consulted).toEqual(notOwnerLevel);

      // The lookup is keyed on THIS user and THIS branch, once.
      for (const o of outcomes.filter((x) => consulted.includes(x.role))) {
        expect(o.branchAccessFindUnique).toHaveBeenCalledTimes(1);
        expect(o.branchAccessFindUnique).toHaveBeenCalledWith({
          where: { userId_branchId: { userId: o.user.id, branchId: BRANCH } },
          select: { id: true },
        });
      }
      // The short-circuit is on the GRANT only. Every role — owner-level
      // included — was re-read from the database and had its branch resolved.
      for (const o of outcomes) {
        expect(o.userFindFirst).toHaveBeenCalledTimes(1);
        expect(o.userFindFirst).toHaveBeenCalledWith({
          where: { id: o.user.id, tenantId: TENANT, isActive: true },
          select: { id: true, role: true, branchId: true },
        });
        expect(o.branchFindFirst).toHaveBeenCalledTimes(1);
        expect(o.branchFindFirst).toHaveBeenCalledWith({
          where: { id: BRANCH, tenantId: TENANT, isActive: true },
          select: { id: true },
        });
      }
    });
  });

  describe('a role below owner level reaches a branch through a grant', () => {
    it('a CASHIER with a BranchAccess row passes, and the request carries the branch', async () => {
      const o = await attempt({ role: 'CASHIER', homeBranchId: null, grant: { id: 'ba_1' } });
      expect(o.error).toBeNull();
      expect(o.passed).toBe(true);
      expect(o.request.effectiveBranchId).toBe(BRANCH);
      expect(o.branchAccessFindUnique).toHaveBeenCalledTimes(1);
    });

    it('a CASHIER whose default branch is the candidate passes without a lookup', async () => {
      const o = await attempt({ role: 'CASHIER', homeBranchId: BRANCH, grant: null });
      expect(o.error).toBeNull();
      expect(o.passed).toBe(true);
      expect(o.request.effectiveBranchId).toBe(BRANCH);
      expect(o.branchAccessFindUnique).not.toHaveBeenCalled();
    });

    it('a CASHIER whose default branch is ANOTHER branch, with no grant, is refused', async () => {
      // Negative control for the two positives: the default-branch shortcut
      // is equality with the candidate, not "has a branch at all".
      const o = await attempt({ role: 'CASHIER', homeBranchId: 'brn_other', grant: null });
      expect(o.passed).toBe(false);
      expect(o.error).toBeInstanceOf(ForbiddenException);
      expect(o.branchAccessFindUnique).toHaveBeenCalledTimes(1);
      expect(o.request.effectiveBranchId).toBeUndefined();
    });

    it('the token claim wins over the default branch when both are present', async () => {
      const o = await attempt({
        role: 'CASHIER',
        activeBranchId: 'brn_chosen',
        homeBranchId: BRANCH,
        branch: { id: 'brn_chosen' },
        grant: { id: 'ba_2' },
      });
      expect(o.passed).toBe(true);
      expect(o.request.effectiveBranchId).toBe('brn_chosen');
      expect(o.branchAccessFindUnique).toHaveBeenCalledWith({
        where: { userId_branchId: { userId: o.user.id, branchId: 'brn_chosen' } },
        select: { id: true },
      });
    });
  });

  describe('fails closed before the role is consulted', () => {
    it('a foreign, deleted or inactive branch is 404 for every role — owner-level included', async () => {
      // The owner-level shortcut sits AFTER the branch lookup: it widens which
      // branches a role may enter, not whether a branch exists. A 403 here
      // would be a cross-tenant existence oracle (D38).
      const outcomes = await Promise.all(
        ALL_USER_ROLES.map((role) => attempt({ role, ...noGrant, branch: null })),
      );
      expect(outcomes.map((o) => o.role).sort()).toEqual([...ALL_USER_ROLES].sort());
      for (const o of outcomes) {
        expect({ role: o.role, error: o.error }).toEqual({
          role: o.role,
          error: expect.any(NotFoundException),
        });
        expect((o.error as NotFoundException).message).toBe('Branch not found');
        expect(o.branchAccessFindUnique).not.toHaveBeenCalled();
      }
    });

    it('a session with neither a claim nor a default branch is refused, even for the owner', async () => {
      const o = await attempt({ role: 'OWNER', activeBranchId: null, homeBranchId: null });
      expect(o.error).toBeInstanceOf(ForbiddenException);
      expect((o.error as ForbiddenException).message).toBe(
        'This request requires an active branch',
      );
      expect(o.branchFindFirst).not.toHaveBeenCalled();
    });

    it('a user deactivated since the token was minted is refused, even as owner', async () => {
      const o = await attempt({ role: 'OWNER', activeUser: false });
      expect(o.error).toBeInstanceOf(ForbiddenException);
      expect((o.error as ForbiddenException).message).toBe('User is no longer active');
      expect(o.branchFindFirst).not.toHaveBeenCalled();
    });

    it('a request with no authenticated user is refused', async () => {
      const { guard, userFindFirst } = build({ role: 'CASHIER' });
      await expect(guard.canActivate(context({}))).rejects.toThrow(
        'Branch scope requires an authenticated user',
      );
      expect(userFindFirst).not.toHaveBeenCalled();
    });

    it('TENANT_SCOPED, GLOBAL_PLATFORM and @Public() routes never touch the database', async () => {
      for (const fixture of [
        { role: 'CASHIER', scope: BranchScopeKind.TENANT_SCOPED },
        { role: 'CASHIER', scope: BranchScopeKind.GLOBAL_PLATFORM },
        { role: 'CASHIER', isPublic: true },
      ] as const) {
        const o = await attempt({ ...fixture, ...noGrant });
        expect(o.passed).toBe(true);
        expect(o.userFindFirst).not.toHaveBeenCalled();
        expect(o.branchAccessFindUnique).not.toHaveBeenCalled();
      }
      // Positive control: the same CASHIER on a BRANCH_SCOPED route IS refused,
      // so the no-ops above are the scope's doing, not a stub that always says yes.
      const scoped = await attempt({ role: 'CASHIER', ...noGrant });
      expect(scoped.passed).toBe(false);
      expect(scoped.userFindFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('mutation proofs', () => {
    it('MUTATION PROOF — a regression to the pre-D108 check (OWNER || ADMIN) is red', async () => {
      // The legacy predicate, evaluated over the same enum the guard is tested
      // against. Were `isAdminLevelRole` in the guard replaced by this line,
      // the passing set in the first test would become `legacy`, and the exact
      // set assertion there would throw — shown here on the same comparison.
      // Annotated: TypeScript infers a type predicate from the comparison and
      // would otherwise narrow `legacy` to the pair, hiding the very
      // comparison this proof makes.
      const legacy: readonly UserRole[] = ALL_USER_ROLES.filter(
        (role) => role === 'OWNER' || role === 'ADMIN',
      ).sort();

      expect(legacy).not.toEqual(ownerLevel);
      expect(() => expect(legacy).toEqual(ownerLevel)).toThrow();
      // What the old check misses is exactly the role D108 added.
      expect(ownerLevel.filter((role) => !legacy.includes(role))).toEqual(['SALESPERSON']);

      // And the guard as built today does not produce the legacy set — so the
      // first test is not green because both sides happen to be the old pair.
      const outcomes = await Promise.all(
        ALL_USER_ROLES.map((role) => attempt({ role, ...noGrant })),
      );
      const passed = outcomes.filter((o) => o.passed).map((o) => o.role).sort();
      expect(passed).not.toEqual(legacy);
      expect(passed).toEqual(ownerLevel);
    });

    it('MUTATION PROOF — the real guard with isAdminLevelRole reverted to OWNER || ADMIN is red', async () => {
      // The strongest form of the proof above: not a predicate evaluated
      // beside the guard, but the guard itself, loaded in an isolated module
      // registry with its one authority mocked back to the pre-D108 line.
      // Runtime behaviour, not source text (D30.4) — and no production file
      // is edited to show it.
      let Mutated!: typeof BranchScopeGuard;
      jest.isolateModules(() => {
        jest.doMock('../../modules/auth/permissions', () => ({
          ...jest.requireActual('../../modules/auth/permissions'),
          isAdminLevelRole: (role: string) => role === 'OWNER' || role === 'ADMIN',
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        Mutated = (require('./branch-scope.guard') as { BranchScopeGuard: typeof BranchScopeGuard })
          .BranchScopeGuard;
      });
      jest.dontMock('../../modules/auth/permissions');
      // The mutation took: this is a different class from the one the other
      // tests exercise, so the red below is the mutant's and not a fluke.
      expect(Mutated).not.toBe(BranchScopeGuard);

      const outcomes = await Promise.all(
        ALL_USER_ROLES.map((role) => attempt({ role, ...noGrant }, Mutated)),
      );
      const passed = outcomes.filter((o) => o.passed).map((o) => o.role).sort();
      expect(passed).toEqual(['ADMIN', 'OWNER']);
      expect(passed).not.toContain('SALESPERSON');
      expect(() => expect(passed).toEqual(ownerLevel)).toThrow();
      // The salesperson under the mutant is refused with the stale-token
      // message — the exact regression D108 closed. Matched by name and
      // message rather than `instanceof`: the isolated registry loaded its
      // own copy of `@nestjs/common`, so the mutant's ForbiddenException is a
      // different class object from the one imported at the top of this file.
      const salesperson = outcomes.find((o) => o.role === 'SALESPERSON')!;
      expect((salesperson.error as Error).constructor.name).toBe('ForbiddenException');
      expect((salesperson.error as Error).message).toBe('Access to this branch has been removed');
      expect(salesperson.branchAccessFindUnique).toHaveBeenCalledTimes(1);
    });

    it('MUTATION PROOF — a guard that let every role in would be red', async () => {
      // Run the real guard under a mutated fixture: a grant for everyone. Every
      // role now passes, and the exact-set assertion the first test makes
      // throws — so that assertion is discriminating, not merely green.
      const outcomes = await Promise.all(
        ALL_USER_ROLES.map((role) => attempt({ role, homeBranchId: null, grant: { id: 'ba_x' } })),
      );
      const passed = outcomes.filter((o) => o.passed).map((o) => o.role).sort();
      expect(passed).toEqual([...ALL_USER_ROLES].sort());
      expect(() => expect(passed).toEqual(ownerLevel)).toThrow();
    });
  });
});
