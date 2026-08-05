import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { AuthRateLimitService, RateLimitKey } from './auth-rate-limit.service';
import { TRUSTED_PROXY_HOP_COUNT_ENV, parseTrustedProxyHops, resolveClientIp } from './client-ip';
import { AUTH_THROTTLE_KEY, AuthThrottlePolicy } from './auth-throttle.decorator';

/**
 * Enforces authentication throttling on routes marked `@AuthThrottle(...)`.
 *
 * ## Why an interceptor and not a guard
 *
 * A guard can only see the request. This needs the *outcome* too, because a
 * successful authentication must clear the counters it just spent — otherwise
 * someone who mistypes their password four times and then succeeds is left one
 * mistake from a lockout, and the limiter becomes a way for users to lock
 * themselves out of their own POS mid-shift.
 *
 * ## The response
 *
 * A single generic 429 with `Retry-After`. It says nothing about which counter
 * tripped, whether the account exists, or which tenant it might be in — a limiter
 * that answers "too many attempts for this account" is an account-existence oracle
 * that happens to also slow you down.
 *
 * ## Ordering
 *
 * Registered on the controller, so it runs after the global `JwtAuthGuard` has let
 * the `@Public()` auth routes through and before the handler. The limit is spent on
 * the *attempt*, not on the failure, so an attacker cannot avoid it by timing out.
 */
@Injectable()
export class AuthThrottleInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuthThrottleInterceptor.name);
  private readonly trustedProxyHops: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: AuthRateLimitService,
    config: ConfigService,
  ) {
    this.trustedProxyHops = parseTrustedProxyHops(config.get(TRUSTED_PROXY_HOP_COUNT_ENV));
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const policy = this.reflector.getAllAndOverride<AuthThrottlePolicy>(AUTH_THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const ip = resolveClientIp(request, this.trustedProxyHops);
    const keys = this.keysFor(policy, request, ip);

    // A policy that produced no keys would silently disable the limit, so treat it
    // as a configuration error rather than letting the request through unmetered.
    if (keys.length === 0) {
      this.logger.error(`Throttle policy '${policy}' produced no keys — refusing the request.`);
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const decision = await this.rateLimit.consume(keys);
    if (!decision.allowed) {
      const response = http.getResponse<Response>();
      response.setHeader?.('Retry-After', String(decision.retryAfterSeconds));
      // No identity in the log line — the point is to avoid an oracle, and a log
      // that records which account was targeted rebuilds one internally.
      this.logger.warn(`Throttled ${policy} attempt from ${ip}`);
      // The wait is carried by the `Retry-After` header only. Putting it in the
      // body too made two rejections differ by a second, which is both useless to
      // a client and a field an attacker could try to correlate with something.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many attempts. Please try again later.',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return next.handle().pipe(
      tap({
        next: () => {
          // Success only. A thrown 401 skips this, so failures keep accumulating.
          void this.rateLimit.reset(keys).catch((err: unknown) => {
            this.logger.warn(`Could not reset rate-limit keys: ${(err as Error).message}`);
          });
        },
      }),
    );
  }

  /** Build the counter keys for this policy from the request body and source IP. */
  private keysFor(policy: AuthThrottlePolicy, request: Request, ip: string): RateLimitKey[] {
    const body = (request.body ?? {}) as Record<string, unknown>;

    switch (policy) {
      case 'email-login':
        return this.rateLimit.emailLoginKeys({
          ip,
          workspace: stringOrNull(body.workspace) ?? headerString(request, 'x-tenant-id'),
          email: stringOrNull(body.email) ?? '',
        });

      case 'pin-login':
        return this.rateLimit.pinLoginKeys({
          ip,
          // Unverified client input, deliberately: it only narrows a counter, so a
          // caller who lies gets their own bucket rather than someone else's budget.
          tenantId: headerString(request, 'x-tenant-id') ?? '-',
          branchId: headerString(request, 'x-branch-id'),
          registerId: headerString(request, 'x-register-id'),
        });

      case 'refresh':
        return this.rateLimit.refreshKeys({
          ip,
          refreshToken: stringOrNull(body.refreshToken) ?? '',
        });

      default: {
        const unexpected: never = policy;
        this.logger.error(`Unknown throttle policy '${String(unexpected)}'.`);
        return [];
      }
    }
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function headerString(request: Request, name: string): string | null {
  const raw = request.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
