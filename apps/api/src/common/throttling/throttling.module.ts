import { Global, Module } from '@nestjs/common';

import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthThrottleInterceptor } from './auth-throttle.interceptor';
import { MemoryRateLimitStore } from './memory-rate-limit.store';
import { RATE_LIMIT_STORE } from './rate-limit.store';

/**
 * Authentication throttling (Slice 7.1).
 *
 * `RATE_LIMIT_STORE` is bound to {@link MemoryRateLimitStore} because that is the
 * only implementation that exists — AxloPOS has no Redis (open decision O2). The
 * binding is the **one line** a production deployment changes: swapping in a Redis
 * store needs no change to the policy, the interceptor, or any route.
 *
 * Global so the interceptor can be attached to `AuthController` without that module
 * importing plumbing it does not otherwise care about.
 */
@Global()
@Module({
  providers: [
    { provide: RATE_LIMIT_STORE, useClass: MemoryRateLimitStore },
    AuthRateLimitService,
    AuthThrottleInterceptor,
  ],
  exports: [RATE_LIMIT_STORE, AuthRateLimitService, AuthThrottleInterceptor],
})
export class ThrottlingModule {}
