import { Injectable, Logger } from '@nestjs/common';

import { queryVendorById, queryVendors } from './quickbooks.api';
import { QuickBooksConfig } from './quickbooks.config';
import { QuickBooksRepository } from './quickbooks.repository';
import { QuickBooksService } from './quickbooks.service';

export interface QbVendorOption {
  id: string;
  name: string;
  balance: number | null;
}

/**
 * Read-only QuickBooks Vendor lookups for supplier mapping. When QuickBooks is
 * not connected the lookups return empty results — the mapping UI shows its
 * "connect QuickBooks" empty state rather than fabricated vendors.
 */
@Injectable()
export class QuickBooksVendorsService {
  private readonly logger = new Logger(QuickBooksVendorsService.name);

  constructor(
    private readonly oauth: QuickBooksService,
    private readonly connections: QuickBooksRepository,
    private readonly config: QuickBooksConfig,
  ) {}

  private async params(tenantId: string): Promise<{
    apiBase: string;
    realmId: string;
    accessToken: string;
  } | null> {
    const connection = await this.connections.find(tenantId);
    if (!connection || !connection.isActive) return null;
    const accessToken = await this.oauth.getValidAccessToken(tenantId);
    const { apiBase } = this.config.resolve();
    return { apiBase, realmId: connection.realmId, accessToken };
  }

  async searchVendors(tenantId: string, term: string): Promise<QbVendorOption[]> {
    try {
      const params = await this.params(tenantId);
      if (!params) return [];
      const vendors = await queryVendors(params, term.trim());
      return vendors.map((v) => ({
        id: v.Id,
        name: v.DisplayName,
        balance: v.Balance ?? null,
      }));
    } catch (err) {
      // Includes expired/revoked refresh tokens — treat as "not connected".
      this.logger.warn(`Vendor search failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async findVendor(tenantId: string, vendorId: string): Promise<QbVendorOption | null> {
    const params = await this.params(tenantId);
    if (!params) return null;
    const vendor = await queryVendorById(params, vendorId);
    if (!vendor) return null;
    return { id: vendor.Id, name: vendor.DisplayName, balance: vendor.Balance ?? null };
  }
}
