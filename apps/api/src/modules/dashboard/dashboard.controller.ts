import { ModuleKey } from '@hardware-pos/database';
import { Controller, Get, Query } from '@nestjs/common';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { QueryRangeDto } from './dto/query-range.dto';
import { DashboardService } from './dashboard.service';
import {
  DashboardStats,
  DashboardSummary,
  PaymentMethodTotal,
  RankedCategory,
  RankedProduct,
  SeriesPoint,
  ShiftSummary,
} from './dashboard.types';

@Controller('dashboard')
// Slice 7.6 — enabled for every business profile; inert today, meaningful once switched off.
@RequireModule(ModuleKey.REPORTING)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @RequirePermissions(Permission.SALE_READ)
  stats(@TenantId() tenantId: string): Promise<DashboardStats> {
    return this.dashboardService.getStats(tenantId);
  }

  /** KPI window with previous-period comparison + per-day sparkline series. */
  @Get('summary')
  @RequirePermissions(Permission.SALE_READ)
  summary(@TenantId() tenantId: string, @Query() q: QueryRangeDto): Promise<DashboardSummary> {
    return this.dashboardService.summary(tenantId, q.from, q.to);
  }

  @Get('sales-series')
  @RequirePermissions(Permission.SALE_READ)
  salesSeries(@TenantId() tenantId: string, @Query() q: QueryRangeDto): Promise<SeriesPoint[]> {
    return this.dashboardService.salesSeries(tenantId, q.from, q.to, q.interval ?? 'day');
  }

  @Get('payment-methods')
  @RequirePermissions(Permission.SALE_READ)
  paymentMethods(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: QueryRangeDto,
  ): Promise<PaymentMethodTotal[]> {
    return this.dashboardService.paymentMethods(
      tenantId,
      q.from,
      q.to,
      q.mine === 'true' ? user.id : undefined,
    );
  }

  @Get('top-categories')
  @RequirePermissions(Permission.SALE_READ)
  topCategories(@TenantId() tenantId: string, @Query() q: QueryRangeDto): Promise<RankedCategory[]> {
    return this.dashboardService.topCategories(tenantId, q.from, q.to, q.limit ?? 5);
  }

  @Get('top-products')
  @RequirePermissions(Permission.SALE_READ)
  topProducts(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: QueryRangeDto,
  ): Promise<RankedProduct[]> {
    return this.dashboardService.topProducts(
      tenantId,
      q.from,
      q.to,
      q.limit ?? 5,
      q.mine === 'true' ? user.id : undefined,
    );
  }

  /** The signed-in cashier's own activity since midnight. */
  @Get('shift-summary')
  @RequirePermissions(Permission.SALE_READ)
  shiftSummary(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShiftSummary> {
    return this.dashboardService.shiftSummary(tenantId, user.id);
  }
}
