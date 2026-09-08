import { UserRole } from '@hardware-pos/database';

/**
 * Maximum manual discount (as a percentage of the line) a role may apply without
 * manager approval. `null` = unlimited. Discounts above a user's limit require an
 * approval token from someone whose limit covers it.
 */
export const ROLE_DISCOUNT_LIMIT_PERCENT: Record<UserRole, number | null> = {
  CASHIER: 0,
  ACCOUNTANT: 0,
  MANAGER: 15,
  ADMIN: null,
  OWNER: null,
  SALESPERSON: null,
};

export function getRoleDiscountLimit(role: UserRole): number | null {
  return ROLE_DISCOUNT_LIMIT_PERCENT[role];
}

/** True when `limit` (null = unlimited) permits a discount of `percent`. */
export function limitCovers(limit: number | null, percent: number): boolean {
  return limit === null || percent <= limit + 1e-9;
}
