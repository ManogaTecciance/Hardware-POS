import {
  BadRequestException,
  Body,
  Controller,
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
import { Customer } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import {
  CustomersImportService,
  type ImportCommitSummary,
  type ParsedCustomerRow,
} from './customers-import.service';
import { CustomersService } from './customers.service';
import { CommitCustomerImportDto } from './dto/commit-import.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

interface UploadedSpreadsheet {
  buffer: Buffer;
  originalname?: string;
}

@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly customersImportService: CustomersImportService,
  ) {}

  @Get()
  @RequirePermissions(Permission.CUSTOMER_READ)
  list(@TenantId() tenantId: string, @Query() query: QueryCustomersDto): Promise<Paginated<Customer>> {
    return this.customersService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions(Permission.CUSTOMER_MANAGE)
  create(@TenantId() tenantId: string, @Body() dto: CreateCustomerDto): Promise<Customer> {
    return this.customersService.create(tenantId, dto);
  }

  // ── Bulk import (QuickBooks customer template) ─────────────────────────────

  @Get('import/template')
  @RequirePermissions(Permission.CUSTOMER_MANAGE)
  async importTemplate(@Res() res: Response): Promise<void> {
    const buffer = await this.customersImportService.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="customer-import-template.xlsx"');
    res.send(buffer);
  }

  /**
   * Parse + validate an uploaded sheet and return the rows for review — no
   * customers are created until the reviewed rows are sent to `import/commit`.
   */
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CUSTOMER_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  importPreview(
    @TenantId() tenantId: string,
    @UploadedFile() file: UploadedSpreadsheet | undefined,
  ): Promise<ParsedCustomerRow[]> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.customersImportService.preview(tenantId, file);
  }

  @Post('import/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CUSTOMER_MANAGE)
  importCommit(
    @TenantId() tenantId: string,
    @Body() dto: CommitCustomerImportDto,
  ): Promise<ImportCommitSummary> {
    return this.customersImportService.commit(tenantId, dto.rows);
  }

  @Get(':id')
  @RequirePermissions(Permission.CUSTOMER_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<Customer> {
    return this.customersService.getById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.CUSTOMER_MANAGE)
  update(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ): Promise<Customer> {
    return this.customersService.update(tenantId, id, dto);
  }

  @Post(':id/sync-to-quickbooks')
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  syncToQuickBooks(@TenantId() tenantId: string, @Param('id') id: string): Promise<Customer> {
    return this.customersService.syncToQuickBooks(tenantId, id);
  }
}
