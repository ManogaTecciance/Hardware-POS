import { Injectable } from '@nestjs/common';
import { FulfilmentKind } from '@hardware-pos/database';
import { domainFor } from '@hardware-pos/shared';

import { BusinessProfileService } from '../../platform/business-profile.service';
import type { FulfilmentProvider } from './fulfilment-provider';
import { ImmediateFulfilmentProvider } from './immediate-fulfilment.provider';
import { TableServiceFulfilmentProvider } from './table-service-fulfilment.provider';

/**
 * D61 — resolve a tenant's fulfilment provider, the same shape as
 * `InventoryProviderFactory` (D28): capability in, provider out, no fallback.
 *
 * The kind comes from the domain registry via the tenant's effective profile
 * — a page hides controls on the same capability, this factory is where the
 * SERVER answers, and both read one declaration (D56).
 */
@Injectable()
export class FulfilmentProviderFactory {
  /** Total over the enum: a new FulfilmentKind fails the build here. */
  private readonly byKind: Record<FulfilmentKind, FulfilmentProvider>;

  constructor(
    private readonly profiles: BusinessProfileService,
    immediate: ImmediateFulfilmentProvider,
    tableService: TableServiceFulfilmentProvider,
  ) {
    this.byKind = {
      [FulfilmentKind.IMMEDIATE]: immediate,
      [FulfilmentKind.TABLE_SERVICE]: tableService,
    };
  }

  async forTenant(tenantId: string): Promise<FulfilmentProvider> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    const kind = domainFor(profile.businessType).capabilities.fulfilment.kind as FulfilmentKind;
    return this.byKind[kind];
  }

  forKind(kind: FulfilmentKind): FulfilmentProvider {
    return this.byKind[kind];
  }
}
