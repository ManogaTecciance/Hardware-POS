/**
 * Boots the REAL `AppModule` over a real HTTP listener.
 *
 * `test-app.ts` compiles a subset of modules and calls services directly, which is
 * right for characterising business logic. It cannot test guards: `JwtAuthGuard`,
 * `RolesGuard`, `PermissionsGuard`, and `ModuleAccessGuard` are registered as
 * `APP_GUARD` in `AppModule` and only run on an HTTP request. A 403 for a cashier
 * is a property of the wiring, not of a service method, so asserting it means
 * going through the wire.
 *
 * This harness therefore mirrors `main.ts` — same module graph, same global
 * prefix, same `ValidationPipe` flags, same guard order — and speaks to it with
 * `fetch`. No new dependency: Node 20 has `fetch`, and the app listens on an
 * ephemeral port so parallel runs cannot collide.
 *
 * Deliberately NOT mirrored from `main.ts`: CORS (no browser here) and the
 * `/uploads` static middleware (no spec fetches an uploaded image).
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { UserRole } from '@hardware-pos/database';
import { API_VERSION } from '@hardware-pos/shared';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/** JSON response with the status code and the unwrapped `{ data }` envelope. */
export interface HttpResult<T = unknown> {
  status: number;
  /** The payload inside the standard `{ data }` envelope, when there is one. */
  data: T;
  /** The raw parsed body, for asserting on error shapes. */
  body: unknown;
  /**
   * Response headers, lower-cased.
   *
   * Added in Slice 7: a 429 is only useful to a client if it carries `Retry-After`,
   * and asserting on the status alone would not notice the header going missing.
   */
  headers: Record<string, string>;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpIntegrationApp {
  app: INestApplication;
  prisma: PrismaService;
  jwt: JwtService;
  /** Mint an access token exactly as `AuthService.issueToken` does. */
  tokenFor(input: { userId: string; tenantId: string; role: UserRole }): string;
  request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<HttpResult<T>>;
  close(): Promise<void>;
}

export async function createHttpIntegrationApp(): Promise<HttpIntegrationApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(false);
  app.setGlobalPrefix(API_VERSION);
  // Identical flags to main.ts: `forbidNonWhitelisted` is what turns an unexpected
  // body field (a client-supplied `tenantId`, say) into a 400 instead of a silent
  // no-op, so a spec asserting that must use the same configuration.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Port 0 → the OS picks a free port, so this never fights the dev server or a
  // second test process.
  await app.listen(0, '127.0.0.1');
  const baseUrl = `${await app.getUrl()}/${API_VERSION}`.replace('[::1]', '127.0.0.1');

  const jwt = moduleRef.get(JwtService);

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    jwt,
    tokenFor: ({ userId, tenantId, role }) => jwt.sign({ sub: userId, tenantId, role }),
    async request<T>(
      method: string,
      path: string,
      options: RequestOptions = {},
    ): Promise<HttpResult<T>> {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      const data =
        body && typeof body === 'object' && 'data' in body
          ? (body as { data: T }).data
          : (body as T);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: res.status, data, body, headers };
    },
    close: () => app.close(),
  };
}
