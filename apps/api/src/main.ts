import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { API_VERSION } from '@hardware-pos/shared';

import { AppModule } from './app.module';
import { StorageService } from './common/storage/storage.service';
import { UPLOAD_URL_PREFIX } from './common/storage/storage.util';
import { uploadsHandler } from './common/storage/uploads.handler';
import { parseWebOrigins } from './common/web-origins';
import { RATE_LIMIT_STORE, RateLimitStore } from './common/throttling/rate-limit.store';
import { assertReplicaSafetyOrExit } from './common/throttling/replica-safety';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);

  // Phase 1.5.10 — refuse to boot in a multi-replica deployment when the
  // rate-limit store is process-local. Otherwise an attacker gets N times the
  // configured budget across N replicas, silently, and the "protection" is a
  // fiction. Exits 78 (EX_CONFIG) with a clear reason.
  assertReplicaSafetyOrExit({
    replicaCount: Number(config.get<string>('APP_REPLICA_COUNT') ?? '1'),
    store: app.get<RateLimitStore>(RATE_LIMIT_STORE),
    logger: new Logger('Bootstrap'),
  });

  app.setGlobalPrefix(API_VERSION);
  // D64 — Express 5 dropped the `extended` (qs) query parser this API started
  // on. Restore it: `attr[bedCount]=2` must parse into a nested `attr` object
  // so the sellable listing's attribute filters can pass the whitelist pipe as
  // ONE declared key. Plain `?a=b` queries are unaffected.
  app.set('query parser', 'extended');
  // Serve uploaded product images (outside the versioned API prefix), e.g.
  // /uploads/<key>. Mounted as middleware rather than a controller so the path
  // stays clear of the version prefix; the handler streams from disk or
  // redirects to a freshly signed S3 URL depending on STORAGE_PROVIDER.
  app.use(UPLOAD_URL_PREFIX, uploadsHandler(app.get(StorageService)));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableCors({
    // WEB_ORIGIN may list several allowed origins, comma-separated (e.g. apex +
    // www). cors reflects whichever matches the request's Origin header.
    origin: parseWebOrigins(config.get<string>('WEB_ORIGIN')),
    credentials: true,
    // Lets the browser read the filename of exported reports.
    exposedHeaders: ['Content-Disposition'],
  });

  const port = config.get<number>('API_PORT', 4000);
  await app.listen(port);

  Logger.log(`Hardware POS API listening on http://localhost:${port}/${API_VERSION}`, 'Bootstrap');
}

void bootstrap();
