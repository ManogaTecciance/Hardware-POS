import { Injectable, Logger } from '@nestjs/common';
import { AccountingProviderKind } from '@hardware-pos/database';

import { BusinessProfileService } from '../../platform/business-profile.service';
import { UnsupportedAccountingProviderError } from '../provider.errors';
import { AccountingProvider } from './accounting-provider';
import {
  ReturnAccountingFacts,
  SaleAccountingFacts,
  returnAccountingProvenance,
  saleAccountingProvenance,
} from './accounting-provenance';
import { NoAccountingProvider } from './no-accounting.provider';
import { QuickBooksAccountingProvider } from './quickbooks-accounting.provider';

/**
 * Resolves the accounting provider for one tenant.
 *
 * Same design as `InventoryProviderFactory`, for the same reasons:
 *
 *  • the provider kind comes **only** from `BusinessProfileService`, so there is no
 *    duplicated legacy-default logic here — a legacy tenant resolves to QuickBooks
 *    because `LEGACY_TENANT_DEFAULTS.accountingProvider` says so;
 *  • no cache (decision D11);
 *  • `FUTURE_EXTERNAL` **fails closed** with a typed error and never falls back.
 *
 * The fallback point deserves emphasis for accounting specifically. Silently
 * substituting `NoAccountingProvider` for an unimplemented one would mean a tenant's
 * sales quietly never reaching their books — a financial reporting gap that looks
 * exactly like normal operation until someone reconciles. Substituting QuickBooks
 * would push a tenant's financial documents into a system they did not choose.
 * Both are worse than a 501.
 */
@Injectable()
export class AccountingProviderFactory {
  private readonly logger = new Logger(AccountingProviderFactory.name);

  constructor(
    private readonly businessProfile: BusinessProfileService,
    private readonly quickBooks: QuickBooksAccountingProvider,
    private readonly none: NoAccountingProvider,
  ) {}

  /**
   * The provider for this tenant, resolved from its effective business profile.
   *
   * `tenantId` must come from the authenticated server-side context.
   */
  async forTenant(tenantId: string): Promise<AccountingProvider> {
    const profile = await this.businessProfile.getEffectiveProfile(tenantId);
    return this.forProvider(profile.accountingProvider);
  }

  /**
   * The provider a **completed sale** was filed under, for operations that reverse
   * or amend it.
   *
   * Deliberately does not consult `TenantBusinessProfile`. A tenant that switches
   * accounting providers still has sales sitting in the old one, and a return has
   * to go back to where the money was booked. See `accounting-provenance.ts`.
   */
  forSale(sale: SaleAccountingFacts): AccountingProvider {
    return this.forProvider(saleAccountingProvenance(sale));
  }

  /**
   * The provider a **persisted return** was filed under — for retrying or
   * inspecting a return without re-loading its original sale.
   */
  forReturn(ret: ReturnAccountingFacts): AccountingProvider {
    return this.forProvider(returnAccountingProvenance(ret));
  }

  /** The provider for an explicit kind. */
  forProvider(provider: AccountingProviderKind): AccountingProvider {
    switch (provider) {
      case AccountingProviderKind.QUICKBOOKS:
        return this.quickBooks;
      case AccountingProviderKind.NONE:
        return this.none;
      case AccountingProviderKind.FUTURE_EXTERNAL:
        this.logger.error('FUTURE_EXTERNAL accounting has no implementation; refusing.');
        throw new UnsupportedAccountingProviderError(provider);
      default: {
        const unexpected: never = provider;
        this.logger.error(`Unknown accounting provider '${String(unexpected)}'; refusing.`);
        throw new UnsupportedAccountingProviderError(String(unexpected));
      }
    }
  }
}
