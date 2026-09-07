import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';
import type { Response } from 'express';

import { BranchScope, BranchScopeKind } from '../../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateDraftDto } from './dto/create-draft.dto';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { QuerySalesDto } from './dto/query-sales.dto';
import { QuerySalesReportDto } from './dto/query-sales-report.dto';
import { SalesReportService } from './sales-report.service';
import { RetailReportsService } from './retail-reports.service';
import { QueryRetailReportDto, toReportRange } from './dto/query-retail-report.dto';
import { SaleWithRelations } from './sales.repository';
import { SalesService } from './sales.service';
import { SaleListItem } from './sales.types';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly salesReportService: SalesReportService,
    private readonly retailReports: RetailReportsService,
  ) {}

  @Post('draft')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_CREATE)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  createDraft(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDraftDto,
  ): Promise<SaleWithRelations> {
    return this.salesService.createDraft(tenantId, user, dto);
  }

  @Post('complete')
  @HttpCode(HttpStatus.CREATED)
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_CREATE)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  complete(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteSaleDto,
  ): Promise<SaleWithRelations> {
    return this.salesService.complete(tenantId, user, dto);
  }

  @Get()
  @RequirePermissions(Permission.SALE_READ)
  list(
    @TenantId() tenantId: string,
    @Query() query: QuerySalesDto,
  ): Promise<Paginated<SaleListItem>> {
    return this.salesService.list(tenantId, query);
  }

  /**
   * Export the sales matching the list filters as a PDF or Excel report.
   * Declared before `:id` so the literal segment isn't captured as an id.
   */
  @Get('report')
  @RequirePermissions(Permission.SALE_READ)
  async report(
    @TenantId() tenantId: string,
    @Query() query: QuerySalesReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.salesReportService.generate(tenantId, query);
    res.setHeader('Content-Type', report.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.send(report.buffer);
  }

  /**
   * `8.3` — what sold, by product and by size.
   *
   * Declared before `:id`, like `report` above, or the literal segment is
   * captured as a sale id.
   *
   * Gated on `REPORTING`, not on `RETAIL_POS`: this is a report, and every
   * other report route in the app (`/dashboard/*`, `/restaurant/reports/*`)
   * carries the same module. It also makes the sidebar honest — `8.2` hides
   * `/reports` when REPORTING is absent, and frontend hiding is usability
   * only; the server has to be the one that refuses.
   *
   * Tenant-wide, like the `GET /sales/report` beside it. A per-branch reading
   * is a different question and would need its own parameter and its own
   * tests; inventing one here would ship a filter nothing has exercised.
   */
  @Get('reports/by-variant')
  @RequireModule(ModuleKey.REPORTING)
  @RequirePermissions(Permission.REPORT_READ)
  salesByVariant(@TenantId() tenantId: string, @Query() query: QueryRetailReportDto) {
    return this.retailReports.salesByVariant(tenantId, toReportRange(query));
  }

  /**
   * `8.4` — how much tax was charged at each rate.
   *
   * Same gate and the same tenant-wide reading as `by-variant` above.
   */
  @Get('reports/tax-by-rate')
  @RequireModule(ModuleKey.REPORTING)
  @RequirePermissions(Permission.REPORT_READ)
  taxByRate(@TenantId() tenantId: string, @Query() query: QueryRetailReportDto) {
    return this.retailReports.taxByRate(tenantId, toReportRange(query));
  }

  @Get(':id')
  @RequirePermissions(Permission.SALE_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<SaleWithRelations> {
    return this.salesService.getById(tenantId, id);
  }

  @Post(':id/sync')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_CREATE)
  sync(@TenantId() tenantId: string, @Param('id') id: string): Promise<SaleWithRelations> {
    return this.salesService.syncToQuickBooks(tenantId, id);
  }

  /** Alias of `/sync` — retry a failed/pending QuickBooks push from the Sales UI. */
  @Post(':id/retry-sync')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_CREATE)
  retrySync(@TenantId() tenantId: string, @Param('id') id: string): Promise<SaleWithRelations> {
    return this.salesService.syncToQuickBooks(tenantId, id);
  }
}
