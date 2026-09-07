import { api, ApiError } from './api';
import type { Session } from './auth';
import type { DiscountType } from './cart';

/**
 * Sentinel `productId` for order-level (whole-cart) discount approvals. Must match
 * the API's `ORDER_DISCOUNT_KEY` so the minted token verifies at sale completion.
 */
export const ORDER_DISCOUNT_KEY = '__order__';

export interface ApprovalRequest {
  managerPin: string;
  productId: string;
  discountType: DiscountType;
  /** Bound into the approval token, so an approval cannot be re-scoped after the fact. */
  discountBasis?: 'LINE' | 'UNIT';
  discountValue: number;
  reason?: string;
}

export interface ApprovalResult {
  approved: boolean;
  approvedByUserId: string | null;
  approvalToken: string | null;
  reason?: string;
}

/** Request manager approval for an over-limit discount via POST /discounts/approve. */
export async function requestDiscountApproval(
  session: Session,
  input: ApprovalRequest,
): Promise<ApprovalResult> {
  try {
    return await api.post<ApprovalResult>('/discounts/approve', input, {
      token: session.token,
      tenantId: session.user.tenantId,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { approved: false, approvedByUserId: null, approvalToken: null, reason: 'Invalid manager PIN' };
    }
    throw err;
  }
}
