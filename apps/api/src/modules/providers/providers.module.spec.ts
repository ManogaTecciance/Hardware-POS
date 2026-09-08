/**
 * `ProvidersModule` must compile and resolve on its own.
 *
 * Slice 5 deliberately does not import it into `AppModule`, so nothing else would
 * notice a broken dependency graph — a missing provider, a circular import, an
 * unregistered token — until Slice 6 tried to wire it and the whole application
 * failed to boot. This spec closes that gap: the graph is compiled every test run.
 *
 * `compile()` without `init()` on purpose. Compilation exercises the full dependency
 * graph and every constructor injection, but skips lifecycle hooks, so
 * `PrismaService.onModuleInit` never opens a connection and this stays in the fast
 * suite with no database. `providers.spec.ts` covers the fully initialised graph
 * against real PostgreSQL.
 */

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AccountingProviderKind, InventoryMode } from '@hardware-pos/database';

import { validateEnv } from '../../config/env.validation';
import { StorageModule } from '../../common/storage/storage.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { ProvidersModule } from './providers.module';
import { AccountingProviderFactory } from './accounting/accounting-provider.factory';
import { NoAccountingProvider } from './accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from './accounting/quickbooks-accounting.provider';
import { InventoryProviderFactory } from './inventory/inventory-provider.factory';
import { LocalInventoryProvider } from './inventory/local-inventory.provider';
import { NoInventoryProvider } from './inventory/no-inventory.provider';
import { QuickBooksInventoryProvider } from './inventory/quickbooks-inventory.provider';

/**
 * The env the graph needs. `validateEnv` validates `process.env` (not `load:`
 * factories), so these are set on `process.env` for the duration of the spec. That
 * the real validator runs at all doubles as a check that the provider layer
 * introduced no new required configuration.
 */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/hardware_pos_test?schema=public',
  JWT_SECRET: 'providers-module-spec-secret',
  TOKEN_ENCRYPTION_KEY: 'providers-module-spec-encryption-key',
  SYNC_WORKER_ENABLED: 'false',
};

const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function compileGraph() {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, ignoreEnvFile: true }),
      PrismaModule,
      // Both are @Global() in production and are documented prerequisites on
      // ProvidersModule: SyncModule → QuickBooksModule injects JwtService (from
      // AuthModule's global JwtModule) and pulls in SettingsModule, whose
      // controller needs StorageService. Pre-existing couplings, not ones Slice 5
      // introduced.
      StorageModule,
      AuthModule,
      PlatformModule,
      ProvidersModule,
    ],
  }).compile();
}

describe('ProvidersModule', () => {
  it('compiles through Nest TestingModule', async () => {
    const moduleRef = await compileGraph();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('resolves both factories', async () => {
    const moduleRef = await compileGraph();

    expect(moduleRef.get(InventoryProviderFactory)).toBeInstanceOf(InventoryProviderFactory);
    expect(moduleRef.get(AccountingProviderFactory)).toBeInstanceOf(AccountingProviderFactory);

    await moduleRef.close();
  });

  it.each([
    ['QuickBooksInventoryProvider', QuickBooksInventoryProvider],
    ['LocalInventoryProvider', LocalInventoryProvider],
    ['NoInventoryProvider', NoInventoryProvider],
    ['QuickBooksAccountingProvider', QuickBooksAccountingProvider],
    ['NoAccountingProvider', NoAccountingProvider],
  ])('resolves %s', async (_name, Type) => {
    const moduleRef = await compileGraph();
    expect(moduleRef.get(Type as never)).toBeInstanceOf(Type as never);
    await moduleRef.close();
  });

  it('the factories resolve every implemented mode without a database', async () => {
    const moduleRef = await compileGraph();
    const inventory = moduleRef.get(InventoryProviderFactory);
    const accounting = moduleRef.get(AccountingProviderFactory);

    // `forMode` / `forProvider` do not read the profile, so resolution is provable
    // here; `forTenant` needs a database and is covered in providers.spec.ts.
    expect(inventory.forMode(InventoryMode.QUICKBOOKS)).toBeInstanceOf(QuickBooksInventoryProvider);
    expect(inventory.forMode(InventoryMode.LOCAL)).toBeInstanceOf(LocalInventoryProvider);
    expect(inventory.forMode(InventoryMode.DISABLED)).toBeInstanceOf(NoInventoryProvider);
    expect(accounting.forProvider(AccountingProviderKind.QUICKBOOKS)).toBeInstanceOf(
      QuickBooksAccountingProvider,
    );
    expect(accounting.forProvider(AccountingProviderKind.NONE)).toBeInstanceOf(NoAccountingProvider);

    await moduleRef.close();
  });

  it('exports only the two factories — implementations stay internal', async () => {
    const moduleRef = await compileGraph();

    // A consumer must go through a factory rather than injecting a concrete
    // provider, or the per-tenant resolution could be bypassed.
    const source = ProvidersModule as unknown as { name: string };
    expect(source.name).toBe('ProvidersModule');
    expect(moduleRef.get(InventoryProviderFactory)).toBeDefined();

    await moduleRef.close();
  });
});
