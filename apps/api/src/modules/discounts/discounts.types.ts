import { DiscountBasis, DiscountType, UserRole } from '@hardware-pos/database';

/** Signed inside the short-lived approval token. */
export interface DiscountApprovalTokenPayload {
  typ: 'discount-approval';
  tenantId: string;
  productId: string;
  discountType: DiscountType;
  /**
   * What the approved amount was measured against. Bound into the token because
   * a manager approving "Rs. 100 off this line" has not approved "Rs. 100 off
   * each of twenty units" — same type, same value, twenty times the money.
   */
  discountBasis: DiscountBasis;
  discountValue: number;
  approvedByUserId: string;
  approverRole: UserRole;
}

/** Response of POST /discounts/approve. */
export interface DiscountApprovalResult {
  approved: boolean;
  approvedByUserId: string | null;
  approvalToken: string | null;
  reason?: string;
}
