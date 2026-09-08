import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { ADMIN_LEVEL_ROLES, Permission } from '../auth/permissions';
import { QuickBooksCallbackQuery, QuickBooksConnectionStatus } from './quickbooks.interfaces';
import { QuickBooksService } from './quickbooks.service';
import { QuickBooksSyncService, type SyncProductsSummary } from './quickbooks-sync.service';
import {
  QuickBooksSalesSyncService,
  type SaleSyncResult,
} from './quickbooks-sales-sync.service';
import {
  QuickBooksPartiesSyncService,
  type CustomerSyncSummary,
  type PartySyncStatus,
  type VendorSyncSummary,
} from './quickbooks-parties-sync.service';
import { QuickBooksVendorsService, type QbVendorOption } from './quickbooks-vendors.service';

/** Everything the combined "Sync with QuickBooks" action reconciles. */
export interface SyncAllSummary {
  products: SyncProductsSummary;
  customers: CustomerSyncSummary;
  vendors: VendorSyncSummary;
}

@Controller('quickbooks')
export class QuickBooksController {
  constructor(
    private readonly quickBooksService: QuickBooksService,
    private readonly quickBooksSyncService: QuickBooksSyncService,
    private readonly quickBooksSalesSyncService: QuickBooksSalesSyncService,
    private readonly quickBooksVendorsService: QuickBooksVendorsService,
    private readonly quickBooksPartiesSyncService: QuickBooksPartiesSyncService,
  ) {}

  /** Customer / vendor mapping counts for the overview cards. */
  @Get('party-sync-status')
  @RequirePermissions(Permission.QUICKBOOKS_READ)
  partySyncStatus(@TenantId() tenantId: string): Promise<PartySyncStatus> {
    return this.quickBooksPartiesSyncService.partyStatus(tenantId);
  }

  /**
   * Full sync with the QuickBooks company: pull the product catalog, then
   * reconcile customer and vendor mappings. Products remain QuickBooks-owned;
   * party syncs maintain linkage without overwriting local field edits.
   */
  @Post('sync')
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  async syncAll(@TenantId() tenantId: string): Promise<SyncAllSummary> {
    const products = await this.quickBooksSyncService.syncProducts(tenantId);
    const customers = await this.quickBooksPartiesSyncService.syncCustomers(tenantId);
    const vendors = await this.quickBooksPartiesSyncService.syncVendors(tenantId);
    return { products, customers, vendors };
  }

  /** Search QuickBooks vendors for supplier mapping (empty when not connected). */
  @Get('vendors')
  @RequirePermissions(Permission.SUPPLIER_QB_MAP)
  vendors(
    @TenantId() tenantId: string,
    @Query('search') search?: string,
  ): Promise<QbVendorOption[]> {
    return this.quickBooksVendorsService.searchVendors(tenantId, search ?? '');
  }

  /**
   * The Intuit authorization URL for the frontend to navigate to. Returned as
   * JSON (not a redirect) because the route needs the Bearer header, which a
   * plain browser navigation cannot send. Owner-level roles only.
   */
  @Get('connect')
  @Roles(...ADMIN_LEVEL_ROLES)
  async connect(@TenantId() tenantId: string): Promise<{ url: string }> {
    return { url: await this.quickBooksService.getAuthorizationUrl(tenantId) };
  }

  /** OAuth redirect target from QuickBooks — public (no session on the redirect). */
  @Public()
  @Get('callback')
  async callback(
    @Query() query: QuickBooksCallbackQuery,
    @Res() res: Response,
  ): Promise<void> {
    const redirectTo = await this.quickBooksService.handleCallback(query);
    res.redirect(redirectTo);
  }

  /** Disconnect the company: revoke the token and remove the stored connection. */
  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @Roles(...ADMIN_LEVEL_ROLES)
  disconnect(@TenantId() tenantId: string): Promise<{ disconnected: boolean }> {
    return this.quickBooksService.disconnect(tenantId);
  }

  /** Connection status — never exposes tokens. */
  @Get('status')
  @RequirePermissions(Permission.QUICKBOOKS_READ)
  status(@TenantId() tenantId: string): Promise<QuickBooksConnectionStatus> {
    return this.quickBooksService.getConnectionStatus(tenantId);
  }

  /** Pull inventory + non-inventory items from QuickBooks into the local cache. */
  @Post('sync-products')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  syncProducts(@TenantId() tenantId: string): Promise<SyncProductsSummary> {
    return this.quickBooksSyncService.syncProducts(tenantId);
  }

  /**
   * Push a completed sale to QuickBooks (Sales Receipt when fully paid, Invoice +
   * linked Payment otherwise). A failed push keeps the sale and marks it FAILED.
   */
  @Post('sync-sale/:saleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  syncSale(
    @TenantId() tenantId: string,
    @Param('saleId') saleId: string,
  ): Promise<SaleSyncResult> {
    return this.quickBooksSalesSyncService.syncSale(tenantId, saleId);
  }

  /** Retry a failed sale sync identified by its sync-log id. */
  @Post('retry/:syncLogId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  retry(
    @TenantId() tenantId: string,
    @Param('syncLogId') syncLogId: string,
  ): Promise<SaleSyncResult> {
    return this.quickBooksSalesSyncService.retry(tenantId, syncLogId);
  }
}
