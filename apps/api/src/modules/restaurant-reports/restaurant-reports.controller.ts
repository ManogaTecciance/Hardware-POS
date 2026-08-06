import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { RestaurantReportsService } from './restaurant-reports.service';

function parseRange(fromIso?: string, toIso?: string): { from: Date; to: Date } {
  const to = toIso ? new Date(toIso) : new Date();
  const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('Invalid from/to date');
  }
  if (from > to) throw new BadRequestException('from must be ≤ to');
  return { from, to };
}

@Controller('restaurant/reports/branches/:branchId')
@RequireModule(ModuleKey.REPORTING)
export class RestaurantReportsController {
  constructor(private readonly service: RestaurantReportsService) {}

  @Get('sales-summary')
  @RequirePermissions(Permission.REPORT_READ)
  salesSummary(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.salesSummary(tenantId, branchId, parseRange(from, to));
  }

  @Get('top-items')
  @RequirePermissions(Permission.REPORT_READ)
  topItems(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Math.min(Math.max(Number(limit ?? '10'), 1), 100);
    return this.service.topItems(tenantId, branchId, parseRange(from, to), parsedLimit);
  }

  @Get('waiter-performance')
  @RequirePermissions(Permission.REPORT_READ)
  waiterPerformance(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.waiterPerformance(tenantId, branchId, parseRange(from, to));
  }

  @Get('payment-breakdown')
  @RequirePermissions(Permission.REPORT_READ)
  paymentBreakdown(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.paymentBreakdown(tenantId, branchId, parseRange(from, to));
  }

  @Get('voids')
  @RequirePermissions(Permission.REPORT_READ)
  voids(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.voidReport(tenantId, branchId, parseRange(from, to));
  }

  @Get('channels')
  @RequirePermissions(Permission.REPORT_READ)
  channels(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.channelBreakdown(tenantId, branchId, parseRange(from, to));
  }
}
