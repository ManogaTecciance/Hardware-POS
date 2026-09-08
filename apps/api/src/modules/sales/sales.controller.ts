import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
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
import { MarkSalePaidDto } from './dto/mark-sale-paid.dto';
import { QuerySalesDto } from './dto/query-sales.dto';
import { QuerySalesReportDto } from './dto/query-sales-report.dto';
import { SalesReportService } from './sales-report.service';
import { RetailReportsService } from './retail-reports.service';
import { QueryRetailReportDto, toReportRange } from './dto/query-retail-report.dto';
import { QueryAgeingReportDto } from './dto/query-ageing-report.dto';
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

  /**
   * `8.5` — what the goods that sold actually earned.
   *
   * Costed at TODAY'S weighted average, which is an approximation for a
   * historical sale — D131. The response says which cost each row used and
   * which rows have no cost at all, rather than presenting one figure as if
   * every part of it were equally solid.
   */
  @Get('reports/margin')
  @RequireModule(ModuleKey.REPORTING)
  @RequirePermissions(Permission.REPORT_READ)
  margin(@TenantId() tenantId: string, @Query() query: QueryRetailReportDto) {
    return this.retailReports.margin(tenantId, toReportRange(query));
  }

  /**
   * `8.6` — what is sitting on the shelf and not moving.
   *
   * Not a date range: an age, measured back from a moment. Ninety days by
   * default, inclusive of the boundary.
   */
  @Get('reports/ageing')
  @RequireModule(ModuleKey.REPORTING)
  @RequirePermissions(Permission.REPORT_READ)
  ageing(@TenantId() tenantId: string, @Query() query: QueryAgeingReportDto) {
    return this.retailReports.ageing(tenantId, {
      thresholdDays: query.thresholdDays,
      asOf: query.asOf ? new Date(query.asOf) : undefined,
    });
  }

  /**
   * `8.8` — the baskets currently on hold.
   *
   * Declared before `:id`, like the reports above, or `held` is captured as a
   * sale id.
   *
   * `RETAIL_POS`-gated, unlike the sale READS beside it: holding a basket is
   * part of taking a sale, not part of looking one up, and a tenant without
   * the retail till has no baskets to hold.
   */
  @Get('held')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_READ)
  listHeld(
    @TenantId() tenantId: string,
    @Query('branchId') branchId?: string,
  ): Promise<SaleWithRelations[]> {
    return this.salesService.listHeld(tenantId, branchId);
  }

  /** `8.8` — discard a held basket. A draft moved no stock, so nothing unwinds. */
  @Delete('held/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_CREATE)
  discardHeld(@TenantId() tenantId: string, @Param('id') id: string): Promise<void> {
    return this.salesService.discardHeld(tenantId, id);
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

  /**
   * Tick a credit invoice off as paid, or clear the tick, from the customer page.
   *
   * Bookkeeping only — it moves no money. Requires `payment:create`, because it
   * is an assertion about money having been received, not a sales edit.
   */
  @Post(':id/marked-paid')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.PAYMENT_CREATE)
  setMarkedPaid(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MarkSalePaidDto,
  ): Promise<SaleWithRelations> {
    return this.salesService.setMarkedPaid(tenantId, user, id, dto.marked);
  }

  /** Alias of `/sync` — retry a failed/pending QuickBooks push from the Sales UI. */
  @Post(':id/retry-sync')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_CREATE)
  retrySync(@TenantId() tenantId: string, @Param('id') id: string): Promise<SaleWithRelations> {
    return this.salesService.syncToQuickBooks(tenantId, id);
  }
}
