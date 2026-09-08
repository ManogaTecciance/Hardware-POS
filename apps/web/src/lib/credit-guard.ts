import type { CustomerCredit } from './customers-api';

import { round2 } from './utils';

/** A customer's credit position, tagged with who it was fetched for. */
export type FetchedCredit = CustomerCredit & { customerId: string };

export interface CreditCheck {
  /** Whether a credit rule applies at all: money is left owing to a named customer. */
  applies: boolean;
  /** The customer is not approved for credit; only full payment completes this sale. */
  refused: boolean;
  /** This sale would take them past their limit. */
  overLimit: boolean;
  /** Headroom to show, clamped at zero — an over-drawn account has none, not a negative amount. */
  available: number;
  /** The figures used, or null when none apply to this customer yet. */
  credit: CustomerCredit | null;
}

const NOT_APPLICABLE: CreditCheck = {
  applies: false,
  refused: false,
  overLimit: false,
  available: 0,
  credit: null,
};

/**
 * Whether the sale being rung would breach the customer's credit, decided
 * exactly as the server decides it at completion.
 *
 * The three rules worth stating, because each has an obvious wrong version:
 *
 *  · It only applies when the sale leaves a balance AND a customer is attached.
 *    A customer barred from credit can still buy anything they pay for in full,
 *    so gating on "is a customer selected" would block ordinary cash sales.
 *
 *  · A null limit means unlimited, not zero. `available ?? 0` would turn every
 *    deliberately-unlimited account into a zero-credit one; `!creditLimit` would
 *    make a real limit of zero look unlimited. Only an explicit null check does.
 *
 *  · The comparison is strictly greater-than. A sale landing exactly on the
 *    limit is allowed, so `>=` would refuse a sale the server accepts.
 *
 * Never blocks on missing data: with nothing fetched the check simply does not
 * apply, and the server — which enforces this for real — decides on completion.
 */
export function checkCredit(
  balance: number,
  customerId: string,
  fetched: FetchedCredit | null,
): CreditCheck {
  if (balance <= 0 || !customerId) return NOT_APPLICABLE;
  // A response for a customer who has since been changed says nothing about
  // this one.
  if (!fetched || fetched.customerId !== customerId) {
    return { ...NOT_APPLICABLE, applies: true };
  }

  const available = Math.max(0, fetched.available ?? 0);
  if (!fetched.creditAllowed) {
    return { applies: true, refused: true, overLimit: false, available, credit: fetched };
  }

  const overLimit =
    fetched.creditLimit != null && round2(fetched.outstanding + balance) > fetched.creditLimit;
  return { applies: true, refused: false, overLimit, available, credit: fetched };
}
