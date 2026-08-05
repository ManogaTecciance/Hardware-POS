import { Injectable, Logger } from '@nestjs/common';
import { InventoryMode } from '@hardware-pos/database';

import { BusinessProfileService } from '../../platform/business-profile.service';
import { UnsupportedInventoryProviderError } from '../provider.errors';
import { CatalogSyncProvider } from './catalog-sync-provider';
import { NoCatalogSyncProvider } from './no-catalog-sync.provider';
import { QuickBooksCatalogSyncProvider } from './quickbooks-catalog-sync.provider';

/**
 * Resolves the catalogue provider for one tenant.
 *
 * Routes on **`InventoryMode`, not `AccountingProviderKind`** (D28): the product
 * catalogue lives wherever inventory is mastered. A tenant whose stock AxloPOS owns
 * has no reason to mirror items into QuickBooks, and one whose stock QuickBooks
 * owns must keep doing so regardless of how its documents are filed.
 *
 * `LOCAL` and `DISABLED` both resolve to {@link NoCatalogSyncProvider}. They differ
 * in whether stock is *tracked*, not in whether an external catalogue exists — and
 * neither has one.
 *
 * `EXTERNAL` fails closed with the same typed error the inventory factory raises,
 * and never falls back. A silent fallback here would either push a tenant's
 * catalogue into a system they did not choose, or quietly stop mirroring a tenant
 * whose accountant is relying on it — both discovered months later.
 *
 * No cache (decision D11).
 */
@Injectable()
export class CatalogSyncProviderFactory {
  private readonly logger = new Logger(CatalogSyncProviderFactory.name);

  constructor(
    private readonly businessProfile: BusinessProfileService,
    private readonly quickBooks: QuickBooksCatalogSyncProvider,
    private readonly none: NoCatalogSyncProvider,
  ) {}

  /**
   * The provider for this tenant, from its effective business profile.
   *
   * `tenantId` must come from the authenticated server-side context; this factory
   * has no access to a request and cannot obtain one from a client.
   */
  async forTenant(tenantId: string): Promise<CatalogSyncProvider> {
    const profile = await this.businessProfile.getEffectiveProfile(tenantId);
    return this.forMode(profile.inventoryMode);
  }

  /** The provider for an explicit mode. */
  forMode(mode: InventoryMode): CatalogSyncProvider {
    switch (mode) {
      case InventoryMode.QUICKBOOKS:
        return this.quickBooks;
      case InventoryMode.LOCAL:
      case InventoryMode.DISABLED:
        return this.none;
      case InventoryMode.EXTERNAL:
        this.logger.error('EXTERNAL inventory has no catalogue implementation; refusing.');
        throw new UnsupportedInventoryProviderError(mode);
      default: {
        // Exhaustiveness guard: a new InventoryMode is a compile error here, and a
        // corrupted value at runtime still fails closed.
        const unexpected: never = mode;
        this.logger.error(`Unknown inventory mode '${String(unexpected)}'; refusing.`);
        throw new UnsupportedInventoryProviderError(String(unexpected));
      }
    }
  }
}
