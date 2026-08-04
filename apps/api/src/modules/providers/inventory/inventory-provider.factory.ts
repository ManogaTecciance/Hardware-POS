import { Injectable, Logger } from '@nestjs/common';
import { InventoryMode } from '@hardware-pos/database';

import { BusinessProfileService } from '../../platform/business-profile.service';
import { UnsupportedInventoryProviderError } from '../provider.errors';
import { InventoryProvider } from './inventory-provider';
import { LocalInventoryProvider } from './local-inventory.provider';
import { NoInventoryProvider } from './no-inventory.provider';
import { QuickBooksInventoryProvider } from './quickbooks-inventory.provider';

/**
 * Resolves the inventory provider for one tenant.
 *
 * ## Where the mode comes from
 *
 * Exclusively from `BusinessProfileService` — the single authoritative profile
 * service from Slice 4. This factory contains **no fallback logic of its own**: it
 * never checks whether a `TenantBusinessProfile` row exists, and it has no
 * "default to QuickBooks" branch. A legacy tenant with no profile row resolves to
 * QuickBooks because `LEGACY_TENANT_DEFAULTS.inventoryMode` is `QUICKBOOKS` and the
 * profile service applies that, not because this class knows anything about legacy
 * tenants.
 *
 * That matters for more than tidiness: a second copy of the legacy default is a
 * second place for production behaviour to drift, and the two copies would be in
 * files nobody edits together.
 *
 * No caching, following decision D11 — the profile service is the one place a cache
 * could ever live, and switching a tenant's inventory mode must take effect on the
 * next call rather than after a TTL.
 *
 * ## Fail closed
 *
 * `EXTERNAL` has no implementation, so it throws
 * {@link UnsupportedInventoryProviderError}. It does **not** fall back to
 * QuickBooks, Local, or None. Silently substituting a provider would mean stock
 * moving in a system the tenant did not configure — the kind of failure that is
 * discovered during a stocktake, months later.
 *
 * An unrecognised value (a mode added to the enum without an implementation, or a
 * corrupted row) hits the same path via the exhaustiveness `default`.
 */
@Injectable()
export class InventoryProviderFactory {
  private readonly logger = new Logger(InventoryProviderFactory.name);

  constructor(
    private readonly businessProfile: BusinessProfileService,
    private readonly quickBooks: QuickBooksInventoryProvider,
    private readonly local: LocalInventoryProvider,
    private readonly none: NoInventoryProvider,
  ) {}

  /**
   * The provider for this tenant, resolved from its effective business profile.
   *
   * `tenantId` must come from the authenticated server-side context; this factory
   * has no access to a request and cannot obtain one from a client.
   */
  async forTenant(tenantId: string): Promise<InventoryProvider> {
    const profile = await this.businessProfile.getEffectiveProfile(tenantId);
    return this.forMode(profile.inventoryMode);
  }

  /**
   * The provider for an explicit mode.
   *
   * Exposed so tests and future callers that already hold a resolved profile do not
   * have to re-read it. Resolution stays in one place.
   */
  forMode(mode: InventoryMode): InventoryProvider {
    switch (mode) {
      case InventoryMode.QUICKBOOKS:
        return this.quickBooks;
      case InventoryMode.LOCAL:
        return this.local;
      case InventoryMode.DISABLED:
        return this.none;
      case InventoryMode.EXTERNAL:
        // Deliberately not implemented. Fail closed rather than substitute.
        this.logger.error('EXTERNAL inventory has no implementation; refusing.');
        throw new UnsupportedInventoryProviderError(mode);
      default: {
        // Exhaustiveness guard: adding an InventoryMode without handling it here is
        // a compile error, and a corrupted value at runtime still fails closed.
        const unexpected: never = mode;
        this.logger.error(`Unknown inventory mode '${String(unexpected)}'; refusing.`);
        throw new UnsupportedInventoryProviderError(String(unexpected));
      }
    }
  }
}
