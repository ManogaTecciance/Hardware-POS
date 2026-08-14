import { Injectable } from '@nestjs/common';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
  Prisma,
  TenantBusinessProfile,
  TenantModule,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/** Values a profile write may set. Absent keys are left as they are. */
export interface ProfileWrite {
  businessType?: BusinessType;
  inventoryMode?: InventoryMode;
  accountingProvider?: AccountingProviderKind;
}

/** A tenant's persisted profile row plus its module rows, or nulls/empties. */
export interface PersistedProfile {
  profile: TenantBusinessProfile | null;
  modules: TenantModule[];
}

/**
 * Data access for the platform business profile.
 *
 * Every method takes `tenantId` as its first argument and scopes every query by
 * it. There is no unscoped read: a tenant id is never optional and never derived
 * from anything a client sent (callers get it from the authenticated session).
 *
 * This class is also the single seam where a cross-request cache could ever be
 * introduced. It deliberately has none — the profile is an authorization input,
 * and a stale cache on a module revocation would fail open on every replica for
 * the whole TTL (decision D11).
 */
@Injectable()
export class BusinessProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load the profile row and module rows for one tenant.
   *
   * Two queries rather than a nested include: `TenantModule` is read on its own
   * by the module guard, and keeping the shapes separate means the guard is not
   * forced through a join it does not need.
   */
  async findByTenant(tenantId: string): Promise<PersistedProfile> {
    const [profile, modules] = await Promise.all([
      this.prisma.tenantBusinessProfile.findUnique({ where: { tenantId } }),
      this.prisma.tenantModule.findMany({
        where: { tenantId },
        orderBy: { moduleKey: 'asc' },
      }),
    ]);
    return { profile, modules };
  }

  /**
   * How many transactions have already moved stock for this tenant.
   *
   * Used to decide whether an inventory-authority change is still safe (D29). A
   * `DRAFT` sale is excluded because it has not decremented anything; `COMPLETED`
   * and `REFUNDED` have. Every `Return` has restocked or deliberately not, which
   * is a decision made under the old authority either way.
   */
  async countInventoryAffectingTransactions(
    tenantId: string,
  ): Promise<{ sales: number; returns: number }> {
    const [sales, returns] = await this.prisma.$transaction([
      this.prisma.sale.count({
        where: { tenantId, status: { in: ['COMPLETED', 'REFUNDED'] } },
      }),
      this.prisma.return.count({ where: { tenantId } }),
    ]);
    return { sales, returns };
  }

  /**
   * Create or update the tenant's profile and replace its module configuration,
   * atomically.
   *
   * The whole write is one interactive transaction: a rejected module key or a
   * unique-constraint violation rolls the profile change back too, so a failed
   * request can never leave a tenant with a new business type but the old module
   * set (or half a module set). `enabledModules` is authoritative when supplied —
   * modules not listed are recorded as explicitly disabled rather than deleted,
   * so a revocation survives as a stated fact rather than becoming "no opinion".
   */
  async upsertProfile(
    tenantId: string,
    write: ProfileWrite,
    enabledModules: ModuleKey[] | undefined,
    defaultsFor: (businessType: BusinessType) => readonly ModuleKey[],
  ): Promise<PersistedProfile> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenantBusinessProfile.findUnique({ where: { tenantId } });

      // A first-time write needs a complete row, so anything the caller left out
      // falls back to the tenant's currently effective (legacy) configuration.
      const profile = existing
        ? await tx.tenantBusinessProfile.update({
            where: { tenantId },
            data: {
              ...definedOnly(write),
              // Optimistic-concurrency token: every write is a new version.
              version: { increment: 1 },
            },
          })
        : await tx.tenantBusinessProfile.create({
            data: {
              tenantId,
              // D57: TILE_SHOP was removed; HARDWARE is the legacy-compatible default.
              businessType: write.businessType ?? BusinessType.HARDWARE,
              inventoryMode: write.inventoryMode ?? InventoryMode.QUICKBOOKS,
              accountingProvider: write.accountingProvider ?? AccountingProviderKind.QUICKBOOKS,
            },
          });

      if (enabledModules !== undefined) {
        await this.replaceModules(tx, tenantId, enabledModules, defaultsFor(profile.businessType));
      }

      const modules = await tx.tenantModule.findMany({
        where: { tenantId },
        orderBy: { moduleKey: 'asc' },
      });
      return { profile, modules };
    });
  }

  /**
   * Write one row per module the tenant has an opinion about, inside the caller's
   * transaction.
   *
   * Rows are upserted rather than deleted-and-recreated so `createdAt` survives a
   * module being toggled off and on again. The upsert also means the
   * `(tenantId, moduleKey)` unique constraint can never be violated by a request
   * that lists the same module twice — the second write updates the first row.
   */
  private async replaceModules(
    tx: Prisma.TransactionClient,
    tenantId: string,
    enabled: ModuleKey[],
    defaults: readonly ModuleKey[],
  ): Promise<void> {
    const wanted = new Set(enabled);

    // Anything the tenant already has a row for, plus the defaults for its
    // business type, must end up stated one way or the other — otherwise turning
    // a default-on module off would silently fall back to "on".
    const existingKeys = (
      await tx.tenantModule.findMany({ where: { tenantId }, select: { moduleKey: true } })
    ).map((row) => row.moduleKey);
    const toWrite = new Set<ModuleKey>([...wanted, ...defaults, ...existingKeys]);

    for (const moduleKey of toWrite) {
      const isEnabled = wanted.has(moduleKey);
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey } },
        create: { tenantId, moduleKey, isEnabled },
        update: { isEnabled },
      });
    }
  }
}

/** Strip `undefined` values so a partial update never nulls an untouched column. */
function definedOnly<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
