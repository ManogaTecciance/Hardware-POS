import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { Paginated } from '@hardware-pos/shared';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { CommitSupplierImportDto } from './dto/commit-import.dto';
import { MapQbVendorDto } from './dto/qb-mapping.dto';
import { QuerySuppliersDto } from './dto/query-suppliers.dto';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier-input.dto';
import {
  SuppliersImportService,
  type ImportCommitSummary,
  type ParsedSupplierRow,
} from './suppliers-import.service';
import { SuppliersService } from './suppliers.service';
import type { SupplierDto } from './suppliers.types';

interface UploadedSpreadsheet {
  buffer: Buffer;
  originalname?: string;
}

@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliersService: SuppliersService,
    private readonly suppliersImportService: SuppliersImportService,
  ) {}

  @Get()
  @RequirePermissions(Permission.SUPPLIER_READ)
  list(
    @TenantId() tenantId: string,
    @Query() query: QuerySuppliersDto,
  ): Promise<Paginated<SupplierDto>> {
    return this.suppliersService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions(Permission.SUPPLIER_MANAGE)
  create(@TenantId() tenantId: string, @Body() dto: CreateSupplierDto): Promise<SupplierDto> {
    return this.suppliersService.create(tenantId, dto);
  }

  // ── Bulk import (QuickBooks vendor template) ───────────────────────────────

  @Get('import/template')
  @RequirePermissions(Permission.SUPPLIER_MANAGE)
  async importTemplate(@Res() res: Response): Promise<void> {
    const buffer = await this.suppliersImportService.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="vendor-import-template.xlsx"');
    res.send(buffer);
  }

  /**
   * Parse + validate an uploaded sheet and return the rows for review — no
   * vendors are created until the reviewed rows are sent to `import/commit`.
   */
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SUPPLIER_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  importPreview(
    @TenantId() tenantId: string,
    @UploadedFile() file: UploadedSpreadsheet | undefined,
  ): Promise<ParsedSupplierRow[]> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.suppliersImportService.preview(tenantId, file);
  }

  @Post('import/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SUPPLIER_MANAGE)
  importCommit(
    @TenantId() tenantId: string,
    @Body() dto: CommitSupplierImportDto,
  ): Promise<ImportCommitSummary> {
    return this.suppliersImportService.commit(tenantId, dto.rows);
  }

  // ── Single vendor ──────────────────────────────────────────────────────────

  @Get(':id')
  @RequirePermissions(Permission.SUPPLIER_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<SupplierDto> {
    return this.suppliersService.getById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.SUPPLIER_MANAGE)
  update(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ): Promise<SupplierDto> {
    return this.suppliersService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.SUPPLIER_DELETE)
  delete(@TenantId() tenantId: string, @Param('id') id: string): Promise<void> {
    return this.suppliersService.delete(tenantId, id);
  }

  // ── QuickBooks vendor mapping ──────────────────────────────────────────────

  @Post(':id/quickbooks-mapping')
  @RequirePermissions(Permission.SUPPLIER_QB_MAP)
  mapQbVendor(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: MapQbVendorDto,
  ): Promise<SupplierDto> {
    return this.suppliersService.mapQbVendor(tenantId, id, dto.vendorId);
  }

  @Delete(':id/quickbooks-mapping')
  @RequirePermissions(Permission.SUPPLIER_QB_MAP)
  unmapQbVendor(@TenantId() tenantId: string, @Param('id') id: string): Promise<SupplierDto> {
    return this.suppliersService.unmapQbVendor(tenantId, id);
  }
}
