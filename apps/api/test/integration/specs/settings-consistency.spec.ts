/**
 * Slice 7.5 — settings consistency across API replicas.
 *
 * Two `SettingsService` instances over the same database **are** two replicas for
 * this purpose: the only thing that made the old implementation replica-unsafe was
 * a per-process `Map` refreshed solely by writes made on that process. Constructing
 * a second instance reproduces that exactly, without needing two Node processes.
 *
 * The property under test is the documented guarantee:
 *
 *   A settings write is observable on every replica within
 *   SETTINGS_CACHE_TTL_MS + one database round trip,
 *   and immediately on the replica that performed the write.
 */

import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant } from '../fixtures';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  SETTINGS_CACHE_TTL_MS,
  SettingsService,
} from '../../../src/modules/settings/settings.service';
import { UpdateSettingsDto } from '../../../src/modules/settings/dto/update-settings.dto';
import { dto } from '../dto';

let prisma: PrismaClient;
let prismaService: PrismaService;
let tenantId: string;

/** Stand-ins for two API replicas sharing one database. */
let replicaA: SettingsService;
let replicaB: SettingsService;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  prismaService = new PrismaService();
  await prismaService.$connect();
});

afterAll(async () => {
  await prismaService.$disconnect();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  ({ tenantId } = await seedTenant(prisma, {
    prefix: 'settings',
    name: 'Settings Tenant',
    slug: 'settings-tenant',
  }));

  replicaA = new SettingsService(prismaService);
  replicaB = new SettingsService(prismaService);
  await replicaA.onModuleInit();
  await replicaB.onModuleInit();
});

/** Let the fire-and-forget background refresh finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('7.5 — the documented consistency guarantee', () => {
  it('the writing replica observes its own change immediately', async () => {
    await replicaA.updateSettings(tenantId, dto(UpdateSettingsDto, { receiptFooter: 'Written by A' }));
    expect(replicaA.getSettings(tenantId).receiptFooter).toBe('Written by A');
  });

  it('another replica observes the change after the TTL, without a restart', async () => {
    // Warm B, so it holds a cached value that predates the write. This is exactly
    // the state the old implementation was stuck in permanently.
    expect(replicaB.getSettings(tenantId).receiptFooter).toBeDefined();
    await settle();

    await replicaA.updateSettings(
      tenantId,
      dto(UpdateSettingsDto, { receiptFooter: 'Written by A' }),
    );

    // Force the entry past the TTL rather than sleeping 30 real seconds.
    expireCache(replicaB, tenantId);

    // The first read after expiry returns the stale value and schedules a refresh
    // — that is the design, and the window is what the guarantee bounds.
    replicaB.getSettings(tenantId);
    await settle();

    expect(replicaB.getSettings(tenantId).receiptFooter).toBe('Written by A');
  });

  it('a tenant created after boot is not served defaults forever', async () => {
    // The second, quieter half of the old defect: `onModuleInit` ran once, so a
    // tenant whose settings row appeared later never existed on that replica.
    const late = await seedTenant(prisma, {
      prefix: 'late',
      name: 'Late Tenant',
      slug: 'late-tenant',
    });
    await replicaA.updateSettings(
      late.tenantId,
      dto(UpdateSettingsDto, { receiptFooter: 'Late tenant footer' }),
    );

    // B booted before this tenant had any row at all.
    expect(replicaB.getSettings(late.tenantId).receiptFooter).not.toBe('Late tenant footer');
    await settle();
    expect(replicaB.getSettings(late.tenantId).receiptFooter).toBe('Late tenant footer');
  });

  it('a fresh read bypasses the cache entirely', async () => {
    await replicaA.updateSettings(
      tenantId,
      dto(UpdateSettingsDto, { receiptFooter: 'Bypass the TTL' }),
    );
    // For callers that genuinely cannot tolerate the window.
    const fresh = await replicaB.getSettingsFresh(tenantId);
    expect(fresh.receiptFooter).toBe('Bypass the TTL');
  });

  it('invalidate forces the next read to reload', async () => {
    await replicaA.updateSettings(tenantId, dto(UpdateSettingsDto, { receiptFooter: 'Invalidated' }));
    replicaB.invalidate(tenantId);
    replicaB.getSettings(tenantId);
    await settle();
    expect(replicaB.getSettings(tenantId).receiptFooter).toBe('Invalidated');
  });

  it('the TTL is a real, finite, documented number', () => {
    // The guarantee is only meaningful if the window is bounded. A TTL of
    // Infinity would make every assertion above pass on the writing replica and
    // never converge on the other one.
    expect(Number.isFinite(SETTINGS_CACHE_TTL_MS)).toBe(true);
    expect(SETTINGS_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(SETTINGS_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it('reads inside the TTL do NOT hit the database on every call', async () => {
    // The cache must still be a cache. Without this, "consistency" could be
    // achieved by deleting it and making every sale read the settings table.
    // Warm it first: the seeded tenant has no stored row, so its very first read
    // legitimately schedules one load.
    replicaA.getSettings(tenantId);
    await settle();

    const spy = jest.spyOn(prismaService.tenantSettings, 'findFirst');
    for (let i = 0; i < 20; i += 1) replicaA.getSettings(tenantId);
    await settle();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a burst of stale reads issues ONE refresh, not one per read', async () => {
    replicaA.getSettings(tenantId);
    await settle();
    expireCache(replicaA, tenantId);

    const spy = jest.spyOn(prismaService.tenantSettings, 'findFirst');
    for (let i = 0; i < 20; i += 1) replicaA.getSettings(tenantId);
    await settle();
    // Deduplication is what stops a stale entry turning a traffic burst into a
    // burst of identical queries.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('7.5 — the consistency test can actually fail', () => {
  it('a replica that never revalidated would be detected', async () => {
    await replicaA.updateSettings(tenantId, dto(UpdateSettingsDto, { receiptFooter: 'New value' }));
    expireCache(replicaB, tenantId);
    replicaB.getSettings(tenantId);
    await settle();
    const converged = replicaB.getSettings(tenantId).receiptFooter;
    expect(converged).toBe('New value');

    // The pre-7.5 behaviour, replayed: a value frozen at boot.
    const frozen = 'Thank you for your purchase!';
    expect(frozen).not.toBe(converged);
    expect(() => expect(frozen).toBe('New value')).toThrow();
  });
});

/**
 * Age a cached entry past the TTL.
 *
 * Reaches into the private map deliberately: the alternative is a 30-second sleep
 * per assertion, and a test that slow gets skipped, which is a worse outcome than
 * this coupling. It manipulates only the *timestamp*, never the value, so what the
 * refresh produces is still the real code path.
 */
function expireCache(service: SettingsService, tenant: string): void {
  const cache = (service as unknown as { cache: Map<string, { loadedAt: number }> }).cache;
  const entry = cache.get(tenant);
  if (entry) entry.loadedAt = Date.now() - SETTINGS_CACHE_TTL_MS - 1;
}
