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
import { SaleWithRelations } from './sales.repository';
import { SalesService } from './sales.service';
import { SaleListItem } from './sales.types';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly salesReportService: SalesReportService,
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
