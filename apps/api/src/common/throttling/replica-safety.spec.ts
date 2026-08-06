/**
 * Phase 1.5.10 — the boot-time replica-safety refusal.
 *
 * Non-vacuous per D30: every "should exit" assertion is paired with "and did
 * NOT exit" for the safe case, so a helper that always exits (or never does)
 * cannot pass.
 */
import { Logger } from '@nestjs/common';

import { EX_CONFIG, assertReplicaSafetyOrExit } from './replica-safety';
import { RateLimitStore } from './rate-limit.store';

const processLocal: RateLimitStore = {
  isDistributed: false,
  description: 'in-memory (test)',
  consume: jest.fn(),
  reset: jest.fn(),
};

const distributed: RateLimitStore = {
  isDistributed: true,
  description: 'distributed (test)',
  consume: jest.fn(),
  reset: jest.fn(),
};

function loggerSpy() {
  const spy: Partial<Logger> = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return spy as Logger;
}

describe('assertReplicaSafetyOrExit', () => {
  it('exits when the operator declares several replicas without a distributed store', () => {
    const exit = jest.fn() as unknown as (code: number) => never;
    const logger = loggerSpy();
    assertReplicaSafetyOrExit({ replicaCount: 3, store: processLocal, logger, exit });
    expect(exit).toHaveBeenCalledWith(EX_CONFIG);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Refusing to boot'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('3x the configured allowance'));
  });

  it('does not exit when the store is distributed', () => {
    const exit = jest.fn() as unknown as (code: number) => never;
    assertReplicaSafetyOrExit({
      replicaCount: 3,
      store: distributed,
      logger: loggerSpy(),
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not exit for a single-replica deployment with a process-local store', () => {
    const exit = jest.fn() as unknown as (code: number) => never;
    const logger = loggerSpy();
    assertReplicaSafetyOrExit({ replicaCount: 1, store: processLocal, logger, exit });
    expect(exit).not.toHaveBeenCalled();
    // The safety notice logs even when nothing is refused, so an operator
    // sees why boot succeeded and what would need to change for scale-out.
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Single-replica'));
  });

  it('exits when APP_REPLICA_COUNT is not a positive integer', () => {
    const exit = jest.fn() as unknown as (code: number) => never;
    assertReplicaSafetyOrExit({
      replicaCount: NaN,
      store: distributed,
      logger: loggerSpy(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(EX_CONFIG);
  });

  it('exits when APP_REPLICA_COUNT is zero', () => {
    const exit = jest.fn() as unknown as (code: number) => never;
    assertReplicaSafetyOrExit({
      replicaCount: 0,
      store: distributed,
      logger: loggerSpy(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(EX_CONFIG);
  });
});
