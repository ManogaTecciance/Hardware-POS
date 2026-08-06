/**
 * Boot-time replica-safety check (Phase 1.5.10, D39).
 *
 * A process-local rate-limit store cannot correctly enforce a shared budget
 * across replicas — with N replicas an attacker gets N times the allowance.
 * Rather than silently ship a "protection" that isn't one, refuse to start
 * when the operator has declared several replicas without providing a
 * distributed store.
 *
 * Exits 78 (`EX_CONFIG`, "configuration error") with a clear message that
 * names both the offending values and the fix. Logs and exits — does not
 * throw — because a thrown error at bootstrap is silently swallowed by some
 * process supervisors and this must be conspicuous.
 */
import { Logger } from '@nestjs/common';

import { RateLimitStore } from './rate-limit.store';

export interface ReplicaSafetyInput {
  /** Value from `APP_REPLICA_COUNT`; defaults to 1 when unset. */
  replicaCount: number;
  store: RateLimitStore;
  logger: Logger;
  /** Injectable for tests — production uses `process.exit`. */
  exit?: (code: number) => never;
}

export const EX_CONFIG = 78;

export function assertReplicaSafetyOrExit(input: ReplicaSafetyInput): void {
  const { replicaCount, store, logger } = input;
  const exit = input.exit ?? ((code: number): never => process.exit(code));

  // Not a positive integer → treat as misconfiguration.
  if (!Number.isFinite(replicaCount) || replicaCount < 1) {
    logger.error(
      `Refusing to boot: APP_REPLICA_COUNT is ${replicaCount}, which is not a positive integer.`,
    );
    exit(EX_CONFIG);
    return;
  }

  if (replicaCount > 1 && !store.isDistributed) {
    logger.error(
      `Refusing to boot: APP_REPLICA_COUNT=${replicaCount} but the rate-limit store ` +
        `is process-local (${store.description}). This deployment cannot enforce ` +
        'a shared budget across replicas — an attacker would get ' +
        `${replicaCount}x the configured allowance. Either configure a distributed ` +
        'rate-limit store or set APP_REPLICA_COUNT=1.',
    );
    exit(EX_CONFIG);
    return;
  }

  if (replicaCount === 1) {
    // Single replica: process-local store is correct by design. Emit the same
    // warning the store's own boot log emits so operators see it in one place.
    logger.log(
      `Rate-limit store: ${store.description} (isDistributed=${store.isDistributed}). ` +
        'Single-replica deployment — this is safe. Adding replicas requires a ' +
        'distributed store; boot will refuse until one is configured.',
    );
  }
}
