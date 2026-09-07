/**
 * D107 / D107a — exchanges (Phase 7, `7.5`).
 *
 * Every field is REQUIRED on the in-process type, even where the server could
 * conceivably omit one. That is the standing rule from Phase 4: `4.15` and
 * `4.21` were the same defect twice — an optional field dropped by a mapper,
 * invisible to the compiler — and required turns the omission into a compile
 * error at the exact line rather than a blank on a screen.
 */

import { api } from './api';
import type { Session } from './auth';
import type { ReturnItemInput } from './returns';

export interface ExchangeResult {
  id: string;
  exchangeNumber: string;
  /** Value of the goods coming back, refunded on the returning leg. */
  returnedValue: number;
  /** Value of the goods going out. `null` while the replacement is unfinished. */
  replacementValue: number | null;
  /** `replacement − returned`. Positive = customer owes, negative = owed back. */
  netDifference: number | null;
  returnId: string;
  returnNumber: string;
  replacementSaleId: string | null;
  replacementSaleNumber: string | null;
  /**
   * False while the replacement leg has not completed.
   *
   * A real state, not an error (D107): the customer has been refunded and the
   * operator can ring the replacement up as an ordinary sale.
   */
  complete: boolean;
}

export interface ExchangeReplacementInput {
  productId: string;
  productVariantId?: string;
  quantity: number;
}

export interface ExchangePaymentInput {
  method: string;
  amount: number;
  reference?: string;
}

export interface CompleteExchangeInput {
  originalSaleId: string;
  branchId: string;
  registerId?: string;
  customerId?: string;
  returnItems: ReturnItemInput[];
  replacementItems: ExchangeReplacementInput[];
  /**
   * The replacement is paid for IN FULL (D107a). Settlement is gross: the
   * customer is handed the value of what they brought back and pays for what
   * they take away, so the money nets at the drawer rather than in the request.
   */
  payments: ExchangePaymentInput[];
  /** Defaults to CASH server-side — the counter case. */
  refundMethod?: string;
  /** From `approveReturn`, when the returning leg needs a manager. */
  approvalToken?: string;
  notes?: string;
  idempotencyKey?: string;
}

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export function completeExchange(
  session: Session,
  input: CompleteExchangeInput,
): Promise<ExchangeResult> {
  return api.post<ExchangeResult>('/exchanges', input, auth(session));
}

export function fetchExchange(session: Session, id: string): Promise<ExchangeResult> {
  return api.get<ExchangeResult>(`/exchanges/${id}`, auth(session));
}
