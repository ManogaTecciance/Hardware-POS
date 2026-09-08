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
import { Product } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';
import type { Response } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { MockSyncSummary } from './products.repository';
import {
  ImportCommitSummary,
  ParsedProductRow,
  ProductsImportService,
} from './products-import.service';
import { ProductsReportService } from './products-report.service';
import { ProductsService } from './products.service';
import { CommitImportDto } from './dto/commit-import.dto';
import { QueryProductsReportDto } from './dto/query-products-report.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { SearchProductsDto } from './dto/search-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

/** Uploaded spreadsheet from multer (memory storage). */
interface UploadedSpreadsheet {
  buffer: Buffer;
  originalname?: string;
}

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly productsImportService: ProductsImportService,
    private readonly productsReportService: ProductsReportService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(@TenantId() tenantId: string, @Query() query: QueryProductsDto): Promise<Paginated<Product>> {
    return this.productsService.list(tenantId, query);
  }

  // Static routes must precede the ':id' param route so they are not shadowed.
  @Get('search')
  @RequirePermissions(Permission.PRODUCT_READ)
  search(
    @TenantId() tenantId: string,
    @Query() query: SearchProductsDto,
  ): Promise<Paginated<Product>> {
    return this.productsService.search(tenantId, query);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  create(@TenantId() tenantId: string, @Body() dto: CreateProductDto): Promise<Product> {
    return this.productsService.create(tenantId, dto);
  }

  /**
   * Export the products matching the list filters as a PDF or Excel stock
   * report. Declared before `:id` so the literal segment isn't captured.
   */
  @Get('report')
  @RequirePermissions(Permission.PRODUCT_READ)
  async report(
    @TenantId() tenantId: string,
    @Query() query: QueryProductsReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.productsReportService.generate(tenantId, query);
    res.setHeader('Content-Type', report.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.send(report.buffer);
  }

  /** Download the blank .xlsx template for the bulk product import. */
  @Get('import/template')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async importTemplate(@Res() res: Response): Promise<void> {
    const buffer = await this.productsImportService.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
    res.send(buffer);
  }

  /**
   * Parse + validate an uploaded sheet and return the rows for review — no
   * products are created until the reviewed rows are sent to `import/commit`.
   */
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  importPreview(
    @TenantId() tenantId: string,
    @UploadedFile() file: UploadedSpreadsheet | undefined,
  ): Promise<ParsedProductRow[]> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.productsImportService.preview(tenantId, file);
  }

  /** Create/update the reviewed rows; returns each row's product id for images. */
  @Post('import/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  importCommit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CommitImportDto,
  ): Promise<ImportCommitSummary> {
    return this.productsImportService.commit(tenantId, user.role, dto.rows);
  }

  /** Refresh the product cache from a mock QuickBooks pull. Owner-level roles only. */
  @Post('sync/mock')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  mockSync(@TenantId() tenantId: string): Promise<MockSyncSummary> {
    return this.productsService.mockSync(tenantId);
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCT_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<Product> {
    return this.productsService.getById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<Product> {
    return this.productsService.update(tenantId, id, dto, user.role);
  }

  /** Soft-delete (deactivate). Sale history keeps referencing the product. */
  @Delete(':id')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  deactivate(@TenantId() tenantId: string, @Param('id') id: string): Promise<Product> {
    return this.productsService.deactivate(tenantId, id);
  }

  /** Upload the POS-side product photo (stored in S3; never sent to QuickBooks). */
  @Post(':id/image')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  // Nest's FileInterceptor defaults to multer memory storage, so the file has `.buffer`.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadImage(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ): Promise<Product> {
    return this.productsService.setImage(tenantId, id, file);
  }

  @Delete(':id/image')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  removeImage(@TenantId() tenantId: string, @Param('id') id: string): Promise<Product> {
    return this.productsService.removeImage(tenantId, id);
  }

  @Post(':id/sync-to-quickbooks')
  @RequirePermissions(Permission.QUICKBOOKS_MANAGE)
  syncToQuickBooks(@TenantId() tenantId: string, @Param('id') id: string): Promise<Product> {
    return this.productsService.syncToQuickBooks(tenantId, id);
  }
}
