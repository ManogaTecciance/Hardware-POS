import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DiscountBasis, DiscountType, UserRole } from '@hardware-pos/database';

import { AuthService } from '../auth/auth.service';
import { Permission, roleHasPermission } from '../auth/permissions';
import { getRoleDiscountLimit, limitCovers } from './discount-limits';
import { DiscountApprovalResult, DiscountApprovalTokenPayload } from './discounts.types';
import { ApproveDiscountRequestDto } from './dto/approve-discount-request.dto';

const APPROVAL_TOKEN_TTL = '15m';

/**
 * Sentinel `productId` used for order-level (whole-cart) discount approvals, which
 * are not tied to a single product. Reuses the same token mechanism as line
 * discounts.
 */
export const ORDER_DISCOUNT_KEY = '__order__';

export interface ResolveApprovalInput {
  tenantId: string;
  actorRole: UserRole;
  productId: string;
  discountType: DiscountType;
  /** Whether the amount is per unit or for the line; part of what was approved. */
  discountBasis: DiscountBasis;
  discountValue: number;
  /** Effective discount as a percentage of the line subtotal. */
  effectivePercent: number;
  /** Fresh token from POST /discounts/approve (one-shot completion). */
  approvalToken?: string | null;
  /** Approver already recorded on a draft line (completing a draft). */
  existingApproverId?: string | null;
}

@Injectable()
export class DiscountsService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  /** Verify a manager PIN and, if they may approve this discount, mint a token. */
  async approve(tenantId: string, dto: ApproveDiscountRequestDto): Promise<DiscountApprovalResult> {
    const approver = await this.authService.findUserByPin(tenantId, dto.managerPin);
    if (!approver) {
      throw new UnauthorizedException('Invalid manager PIN');
    }

    if (!roleHasPermission(approver.role, Permission.DISCOUNT_APPROVE)) {
      return this.rejected(approver.id, 'This user is not allowed to approve discounts');
    }

    // For a percentage discount we can check the approver's limit now. For a fixed
    // amount the exact percentage depends on the line total, so it is enforced at
    // sale completion against the real line.
    if (
      dto.discountType === 'PERCENTAGE' &&
      !limitCovers(getRoleDiscountLimit(approver.role), dto.discountValue)
    ) {
      return this.rejected(approver.id, 'Discount exceeds this approver’s limit');
    }

    const payload: DiscountApprovalTokenPayload = {
      typ: 'discount-approval',
      tenantId,
      productId: dto.productId,
      discountType: dto.discountType,
      discountBasis: dto.discountBasis ?? 'LINE',
      discountValue: dto.discountValue,
      approvedByUserId: approver.id,
      approverRole: approver.role,
    };
    const approvalToken = await this.jwtService.signAsync(payload, { expiresIn: APPROVAL_TOKEN_TTL });

    return { approved: true, approvedByUserId: approver.id, approvalToken };
  }

  /**
   * Decide the approver (if any) for a discounted line, or throw a machine-readable
   * "approval required" error. Returns the approvedByUserId to store, or null when
   * the discount is within the actor's own limit.
   */
  async resolveApproval(input: ResolveApprovalInput): Promise<string | null> {
    if (input.effectivePercent <= 0) {
      return null;
    }
    if (limitCovers(getRoleDiscountLimit(input.actorRole), input.effectivePercent)) {
      return null;
    }

    // Over the actor's limit — a covering approval is required.
    if (input.approvalToken) {
      const payload = this.verifyToken(input.approvalToken);
      const matches =
        payload.tenantId === input.tenantId &&
        payload.productId === input.productId &&
        payload.discountType === input.discountType &&
        // Without this, an approval for a whole-line amount could be spent on a
        // per-unit one: every other field still matches, and for a role with no
        // limit the percentage re-check below waves it through.
        (payload.discountBasis ?? 'LINE') === input.discountBasis &&
        Number(payload.discountValue) === Number(input.discountValue);
      if (matches && limitCovers(getRoleDiscountLimit(payload.approverRole), input.effectivePercent)) {
        return payload.approvedByUserId;
      }
    } else if (input.existingApproverId) {
      const approver = await this.authService.findUserById(input.existingApproverId);
      if (approver && limitCovers(getRoleDiscountLimit(approver.role), input.effectivePercent)) {
        return input.existingApproverId;
      }
    }

    throw this.approvalRequired(input.productId, input.effectivePercent);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private verifyToken(token: string): DiscountApprovalTokenPayload {
    try {
      const payload = this.jwtService.verify<DiscountApprovalTokenPayload>(token);
      if (payload.typ !== 'discount-approval') {
        throw new Error('wrong token type');
      }
      return payload;
    } catch {
      // An invalid/expired token is treated the same as "no approval".
      throw this.approvalRequired();
    }
  }

  private rejected(approvedByUserId: string, reason: string): DiscountApprovalResult {
    return { approved: false, approvedByUserId, approvalToken: null, reason };
  }

  private approvalRequired(productId?: string, requiredPercent?: number): ForbiddenException {
    return new ForbiddenException({
      error: 'DiscountApprovalRequired',
      message: 'This discount exceeds your limit and requires manager approval',
      requiresApproval: true,
      ...(productId ? { productId } : {}),
      ...(requiredPercent != null ? { requiredPercent: Math.round(requiredPercent * 100) / 100 } : {}),
    });
  }
}
