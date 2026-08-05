import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { RateLimitDecision, RateLimitRule, RateLimitStore } from './rate-limit.store';

/** One fixed window's state. */
interface Bucket {
  count: number;
  /** Epoch ms at which the window ends and the count resets. */
  resetAt: number;
}

/**
 * Process-local fixed-window counters.
 *
 * **Development, test, and single-replica deployments only.** `isDistributed` is
 * `false` and everything downstream is expected to respect that; see
 * `rate-limit.store.ts` for why the limitation is modelled rather than hidden.
 *
 * ## Fixed window, not sliding
 *
 * A fixed window lets an attacker send `2 × limit` attempts across a window
 * boundary. For credential stuffing that is an acceptable constant factor — the
 * goal is to turn "millions of guesses" into "tens", and a 2× on tens is still
 * tens. A sliding-log window would be exact but stores every timestamp, which is
 * unbounded memory for an attacker-controlled key space. The bounded, predictable
 * memory of a fixed window is worth more here than the precision.
 *
 * ## Memory safety
 *
 * Keys are attacker-influenced (they contain IPs and submitted emails), so expired
 * buckets are swept on a timer as well as lazily on read. Without the sweep, a
 * spray across many addresses would grow the map until the process died — a rate
 * limiter that can be turned into an OOM is worse than none.
 */
@Injectable()
export class MemoryRateLimitStore implements RateLimitStore, OnModuleDestroy {
  readonly isDistributed = false;
  readonly description = 'in-memory (process-local, single replica only)';

  private readonly logger = new Logger(MemoryRateLimitStore.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Do not hold the event loop open: a test process or a CLI run must still exit.
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const now = Date.now();
    const existing = this.buckets.get(key);

    // A window that has elapsed is indistinguishable from one that never existed.
    const bucket =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + rule.windowMs };

    bucket.count += 1;
    this.buckets.set(key, bucket);

    const allowed = bucket.count <= rule.limit;
    return Promise.resolve({
      allowed,
      remaining: Math.max(0, rule.limit - bucket.count),
      // Ceil, and never below 1: `Retry-After: 0` reads as "retry immediately",
      // which would invite exactly the hammering the limit is there to stop.
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    });
  }

  reset(key: string): Promise<void> {
    this.buckets.delete(key);
    return Promise.resolve();
  }

  /** Test seam: how many live buckets are held. Not part of the interface. */
  size(): number {
    return this.buckets.size;
  }

  /**
   * Test seam: forget every bucket.
   *
   * Deliberately NOT on {@link RateLimitStore} — no production code should be able
   * to wipe the limiter. Integration specs need it because the store outlives the
   * app under test: without it the identity counters (which are keyed on workspace
   * and email, *not* on source IP, by design) carry over between cases and every
   * assertion becomes order-dependent.
   */
  clearAllForTests(): void {
    this.buckets.clear();
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Swept ${removed} expired rate-limit bucket(s)`);
    }
  }
}

const SWEEP_INTERVAL_MS = 60_000;
