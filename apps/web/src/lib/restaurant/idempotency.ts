/**
 * A fresh idempotency key per attempt. Reusing one would replay the previous
 * request; the server keys the write on it (round submission, D153's
 * send-to-cashier), so a retry after a timeout lands once.
 *
 * Shared by the table bill sheet and the Orders queue's "Proceed to pay" —
 * one function, so the two cannot disagree on what "fresh" means.
 */
export function freshIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k_${Math.random().toString(36).slice(2)}`;
}
