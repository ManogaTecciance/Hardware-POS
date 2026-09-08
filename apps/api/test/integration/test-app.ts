/**
 * Boots the real Nest providers against the disposable test database.
 *
 * Real modules are used rather than hand-wired classes so DI wiring is exercised
 * too — Phase 1 Slice 6 changes how sales/returns obtain their collaborators, and a
 * hand-wired harness would not notice a broken module graph.
 *
 * The background sync worker is disabled (`SYNC_WORKER_ENABLED=false`, the
 * convention already set out in docs/testing/integration-test-plan.md) so the sync
 * queue is driven deterministically by assertions rather than by a timer.
 */

import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';

import { validateEnv } from '../../src/config/env.validation';
import { StorageModule } from '../../src/common/storage/storage.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AuthService } from '../../src/modules/auth/auth.service';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { BusinessProfileService } from '../../src/modules/platform/business-profile.service';
import { ProductsModule } from '../../src/modules/products/products.module';
import { ProductsService } from '../../src/modules/products/products.service';
import { SyncQueueService } from '../../src/modules/sync/queue/sync-queue.service';
import { ReturnsModule } from '../../src/modules/returns/returns.module';
import { ReturnsRepository } from '../../src/modules/returns/returns.repository';
import { ReturnsService } from '../../src/modules/returns/returns.service';
import { SalesModule } from '../../src/modules/sales/sales.module';
import { SalesRepository } from '../../src/modules/sales/sales.repository';
import { SalesService } from '../../src/modules/sales/sales.service';
import { SettingsService } from '../../src/modules/settings/settings.service';

export interface IntegrationApp {
  module: TestingModule;
  prisma: PrismaService;
  authService: AuthService;
  /** For decoding issued access tokens and asserting their claims. */
  jwtService: JwtService;
  salesService: SalesService;
  salesRepository: SalesRepository;
  returnsService: ReturnsService;
  returnsRepository: ReturnsRepository;
  settingsService: SettingsService;
  productsService: ProductsService;
  /** For asserting the outbox directly, without waiting on the worker. */
  syncQueueService: SyncQueueService;
  businessProfileService: BusinessProfileService;
  close(): Promise<void>;
}

/**
 * Compile and initialise the module graph. `init()` is called so lifecycle hooks
 * run — notably `PrismaService.onModuleInit` ($connect) and
 * `SettingsService.onModuleInit` (settings cache hydration), both of which the
 * production code paths depend on.
 */
export async function createIntegrationApp(): Promise<IntegrationApp> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      // Both @Global() in production and imported by AppModule; the settings and
      // documents controllers reach for StorageService, so the graph needs them.
      StorageModule,
      PrismaModule,
      // @Global() in production too; the module guard and (from Slice 5) the
      // provider factories resolve the tenant profile through it.
      PlatformModule,
      AuthModule,
      SalesModule,
      ReturnsModule,
      ProductsModule,
    ],
  }).compile();

  // Quieter output: the suite asserts on database state, not log lines.
  module.useLogger(false);
  await module.init();

  return {
    module,
    prisma: module.get(PrismaService),
    authService: module.get(AuthService),
    jwtService: module.get(JwtService),
    salesService: module.get(SalesService),
    salesRepository: module.get(SalesRepository),
    returnsService: module.get(ReturnsService),
    returnsRepository: module.get(ReturnsRepository),
    settingsService: module.get(SettingsService),
    productsService: module.get(ProductsService),
    syncQueueService: module.get(SyncQueueService),
    businessProfileService: module.get(BusinessProfileService),
    close: () => module.close(),
  };
}

/**
 * Re-hydrate the settings cache from the database.
 *
 * `SettingsService.getSettings` is synchronous and cache-backed, hydrated once at
 * `onModuleInit`. A spec that writes a `TenantSettings` row after boot must call
 * this, or it will silently assert against code defaults instead of its own
 * settings. (That this is necessary at all is the process-local-cache limitation
 * recorded in docs/restaurant-pos/01-platform-architecture.md.)
 */
export async function reloadSettingsCache(app: IntegrationApp): Promise<void> {
  await app.settingsService.onModuleInit();
}
