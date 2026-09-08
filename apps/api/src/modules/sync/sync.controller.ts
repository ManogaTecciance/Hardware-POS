import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { SyncLog, ModuleKey } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { QuerySyncLogsDto } from './dto/query-sync-logs.dto';
import { RefreshResult, RetryResult } from './sync.interfaces';
import { SyncService } from './sync.service';

@Controller('sync')
// Slice 7.6 — the sync queue exists only to serve QuickBooks.
@RequireModule(ModuleKey.QUICKBOOKS)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** Queue health for the header pill — readable by any authenticated role. */
  @Get('status')
  status(@TenantId() tenantId: string) {
    return this.syncService.status(tenantId);
  }

  @Get('logs')
  @RequirePermissions(Permission.SYNC_READ)
  listLogs(
    @TenantId() tenantId: string,
    @Query() query: QuerySyncLogsDto,
  ): Promise<Paginated<SyncLog>> {
    return this.syncService.listLogs(tenantId, query);
  }

  @Post('sales/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.SYNC_READ)
  retrySale(@TenantId() tenantId: string, @Param('id') id: string): Promise<RetryResult> {
    return this.syncService.retrySale(tenantId, id);
  }

  @Post('products/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.SYNC_READ)
  refreshProducts(@TenantId() tenantId: string): Promise<RefreshResult> {
    return this.syncService.refreshProducts(tenantId);
  }
}
