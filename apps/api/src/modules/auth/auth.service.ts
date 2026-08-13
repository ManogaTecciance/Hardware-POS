import { createHash, randomBytes } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User, UserRole } from '@hardware-pos/database';
import * as bcrypt from 'bcryptjs';

import { AuthRepository } from './auth.repository';
import { WorkspaceRequiredError } from './auth.errors';
import { AuthenticatedUser, AuthTokenResult, JwtPayload } from './auth.types';
import { Permission, ROLE_PERMISSIONS } from './permissions';
import { PermissionResolver } from './permission-resolver.service';
import { LoginDto } from './dto/login.dto';

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A real bcrypt hash of a value nobody knows, compared against when there is no
 * candidate user, so a failed login costs the same as a successful one.
 *
 * Without it, "no such email" and "email exists in another tenant" return in
 * ~1ms while a genuine wrong-password attempt takes a full bcrypt round
 * (~50-100ms). That difference is comfortably measurable over a network and
 * leaks which emails exist, and in which tenant.
 *
 * A constant (not a hash computed at boot) so startup pays nothing; only the
 * comparison cost is being equalised.
 */
const TIMING_EQUALISER_HASH = '$2a$10$.9GhqWKpXdbLcQJWUrTbqOTcIv3aHdS7YhRxB/D7T5ScuhKqt4klO';

/** Single generic failure for every email-login rejection — never say why. */
const INVALID_CREDENTIALS = 'Invalid email or password';

export interface CurrentUserView {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  role: UserRole;
  branchId: string | null;
  permissions: Permission[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly permissions: PermissionResolver,
  ) {}

  /**
   * Email + password login (owner / admin / accountant).
   *
   * `User` is only `@@unique([tenantId, email])`, so the same email may exist in
   * more than one tenant. Resolution is therefore explicit and deterministic:
   *
   *  • `tenantHint` given  → look up exactly `(tenantId, email)`. The hint is
   *    client-supplied and only NARROWS the search; the password is still verified
   *    against that user's own hash, so a wrong hint can only make a login fail.
   *  • no hint, one candidate  → proceed. This is the existing single-tenant
   *    behaviour, unchanged.
   *  • no hint, several candidates → FAIL CLOSED. Picking one would mean
   *    authenticating someone into an arbitrary tenant's data, which is precisely
   *    the defect being fixed. The client must state which tenant it wants.
   *
   * Every rejection returns the same message after an equal-cost bcrypt
   * comparison, so nothing reveals whether the email exists, or in how many
   * tenants.
   */
  async login(dto: LoginDto, tenantHint: string | null = null): Promise<AuthTokenResult> {
    const user = await this.resolveLoginCandidate(dto, tenantHint);

    // Compare against a decoy when there is no usable candidate, so the timing of
    // "unknown email", "unknown workspace", and "wrong password" are alike.
    const hash = user?.passwordHash ?? TIMING_EQUALISER_HASH;
    const passwordMatches = await bcrypt.compare(dto.password, hash);

    if (!user || !user.passwordHash || !passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issueToken(user);
  }

  /**
   * Pick the one user an email login may authenticate as (Slice 7.2).
   *
   * Three paths, in precedence order:
   *
   *  1. **`workspace` slug supplied** — authenticate only inside that tenant. An
   *     unknown or deactivated slug returns `null`, which the caller turns into the
   *     same generic 401 as a wrong password, so a slug cannot be probed for
   *     existence.
   *  2. **`x-tenant-id` header supplied** — the pre-7.2 narrowing hint, preserved
   *     verbatim so existing clients are unaffected.
   *  3. **Neither** — exactly one active candidate proceeds (today's behaviour, and
   *     every current client); more than one raises `WORKSPACE_REQUIRED`.
   *
   * Returning `null` rather than throwing on every *credential* failure is what
   * keeps the rejection branches indistinguishable; the one deliberate exception is
   * the ambiguity case, whose whole purpose is to be distinguishable.
   */
  private async resolveLoginCandidate(
    dto: LoginDto,
    tenantHint: string | null,
  ): Promise<User | null> {
    const email = dto.email;

    if (dto.workspace) {
      const tenant = await this.authRepository.findActiveTenantBySlug(dto.workspace);
      if (!tenant) return null;
      return this.authRepository.findActiveByTenantAndEmail(tenant.id, email);
    }

    if (tenantHint) {
      return this.authRepository.findActiveByTenantAndEmail(tenantHint, email);
    }

    const candidates = await this.authRepository.findActiveUsersByEmail(email);
    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      // Do not log the email — it would put a user identifier in the logs.
      this.logger.warn(
        `Ambiguous email login refused: ${candidates.length} tenants hold this address. ` +
          'The client must supply a workspace.',
      );
      // The one branch that is intentionally distinguishable. The alternative is a
      // generic 401 that a legitimate user has no way to get past; see
      // `auth.errors.ts` for the disclosure this does and does not make.
      throw new WorkspaceRequiredError();
    }
    return null;
  }

  /** PIN login (cashier / manager), scoped to the given tenant. */
  /**
   * Exchange a live refresh token for a new access + refresh pair.
   * Tokens rotate on every use; presenting an already-rotated (revoked)
   * token is treated as replay and kills every session for that user.
   */
  async refresh(refreshToken: string): Promise<AuthTokenResult> {
    const row = await this.authRepository.findRefreshTokenByHash(hashRefreshToken(refreshToken));
    if (!row || !row.user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.revokedAt) {
      await this.authRepository.revokeAllRefreshTokensForUser(row.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Tenant-boundary invariant. `RefreshToken.tenantId` and `RefreshToken.userId`
    // are two independent foreign keys with no composite constraint tying them
    // together, so nothing in the schema prevents them from disagreeing. The new
    // access token is minted from `row.user.tenantId`; if the token row ever
    // claimed a different tenant (bad backfill, a future bug, a hand-edited row)
    // that mismatch is exactly a token crossing a tenant boundary. Refuse it and
    // kill the user's sessions rather than issue a token from inconsistent state.
    if (row.tenantId !== row.user.tenantId) {
      this.logger.error(
        `Refresh token ${row.id} has tenantId ${row.tenantId} but its user belongs to ` +
          `${row.user.tenantId}; refusing and revoking all sessions for that user.`,
      );
      await this.authRepository.revokeAllRefreshTokensForUser(row.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.authRepository.revokeRefreshToken(row.id);
    await this.authRepository.deleteExpiredRefreshTokens(row.userId);
    return this.issueToken(row.user);
  }

  /** Revoke a refresh token (sign-out). Idempotent — unknown tokens are ignored. */
  async logout(refreshToken: string): Promise<void> {
    const row = await this.authRepository.findRefreshTokenByHash(hashRefreshToken(refreshToken));
    if (row && !row.revokedAt) {
      await this.authRepository.revokeRefreshToken(row.id);
    }
  }

  /** Resolve the full current-user view for GET /auth/me. */
  async getCurrentUser(userId: string): Promise<CurrentUserView> {
    const user = await this.authRepository.findById(userId);
    if (!user || !user.isActive) {
      throw new NotFoundException('User not found');
    }
    return this.toCurrentUserView(user);
  }

  /** Find an active tenant user by PIN (used by discount approval). */
  findUserByPin(tenantId: string, pin: string): Promise<User | null> {
    return this.findByPin(tenantId, pin);
  }

  /** Load a user by id (used to check a recorded approver's discount limit). */
  findUserById(id: string): Promise<User | null> {
    return this.authRepository.findById(id);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async findByPin(tenantId: string, pin: string): Promise<User | null> {
    const candidates = await this.authRepository.findActivePinUsers(tenantId);
    for (const candidate of candidates) {
      if (candidate.pinHash && (await bcrypt.compare(pin, candidate.pinHash))) {
        return candidate;
      }
    }
    return null;
  }

  private async issueToken(user: User, requestedBranchId: string | null = null): Promise<AuthTokenResult> {
    const location = await this.authRepository.resolveLocation(user.tenantId, requestedBranchId ?? user.branchId);
    // The resolved branch is authoritative — `resolveLocation` refuses
    // deactivated branches and cross-tenant ids. If it comes back null the
    // token carries no branch claim, and the caller lands in the tenant-wide
    // view (guarded routes will refuse until the caller picks a branch).
    const activeBranchId = location.branch?.id ?? null;

    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      activeBranchId,
    };
    const token = await this.jwtService.signAsync(payload);

    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 30);
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.authRepository.createRefreshToken(
      user.tenantId,
      user.id,
      hashRefreshToken(refreshToken),
      expiresAt,
    );

    await this.authRepository.touchLastLogin(user.id);

    // Resolved, not derived: the client builds its navigation and every
    // `hasPermission` check from this list, and a user on a custom role has an
    // enum role that says nothing about what they may do.
    const authority = await this.permissions.resolve({
      id: user.id,
      tenantId: user.tenantId,
      role: user.role,
    } as AuthenticatedUser);

    return {
      token,
      refreshToken,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      permissions: [...authority.permissions],
      branch: location.branch,
      register: location.register,
    };
  }

  /**
   * The branches this session may switch into right now, from the database —
   * never from the token.
   */
  async listAccessibleBranches(userId: string): Promise<{ id: string; name: string }[]> {
    const user = await this.authRepository.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }
    return this.authRepository.listAccessibleBranches(user);
  }

  /**
   * Switch the caller's active branch. The server re-validates access every
   * time — a stale token or a branch the user was removed from is refused
   * here just as it would be on any branch-scoped request.
   */
  async switchActiveBranch(userId: string, branchId: string): Promise<AuthTokenResult> {
    const user = await this.authRepository.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }
    const allowed = await this.authRepository.hasBranchAccess(user, branchId);
    if (!allowed) {
      // Never leak whether the branch exists in another tenant.
      throw new NotFoundException('Branch not found');
    }
    return this.issueToken(user, branchId);
  }

  /**
   * The view `GET /auth/me` returns, and therefore the set the web app builds
   * its navigation and its every `hasPermission` check from.
   *
   * The permissions MUST come from the same resolver `PermissionsGuard` uses.
   * They used to be `ROLE_PERMISSIONS[user.role]` — the legacy enum fallback —
   * which is only correct for a user whose authority still comes from their
   * enum role. A user linked to a custom role (a waiter, say) got their enum's
   * permissions here and their role's permissions at the guard, so the rail
   * offered them screens that 403 on arrival.
   */
  private async toCurrentUserView(user: User): Promise<CurrentUserView> {
    const authority = await this.permissions.resolve({
      id: user.id,
      tenantId: user.tenantId,
      role: user.role,
    } as AuthenticatedUser);
    return {
      id: user.id,
      tenantId: user.tenantId,
      name: user.name,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
      permissions: [...authority.permissions],
    };
  }
}
