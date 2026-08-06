import { BadRequestException, Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';
import type { Response } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { AuditLogService } from '../audit-log/audit-log.service';
import { DocumentsService, PreviewDocumentType } from './documents.service';
import { PreviewDocumentDto } from './dto/preview-document.dto';

const PREVIEW_TYPES: PreviewDocumentType[] = ['quotation', 'invoice', 'return', 'exchange'];

function assertPreviewType(type: string): PreviewDocumentType {
  if (!PREVIEW_TYPES.includes(type as PreviewDocumentType)) {
    throw new BadRequestException(`Unknown preview type: ${type}`);
  }
  return type as PreviewDocumentType;
}

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly audit: AuditLogService,
  ) {}

  /** A4 final bill / invoice HTML for a completed sale (print or Save-as-PDF). */
  @Get('sales/:saleId')
  @RequireModule(ModuleKey.RETAIL_POS)
  @RequirePermissions(Permission.SALE_READ)
  async saleBill(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('saleId') saleId: string,
  ): Promise<{ html: string; format: 'A4' }> {
    const html = await this.documents.saleHtml(tenantId, saleId);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'bill.printed',
      entityType: 'Sale',
      entityId: saleId,
      metadata: { format: 'A4' },
    });
    return { html, format: 'A4' };
  }

  /** A4 return / refund note HTML for a completed return. */
  @Get('returns/:returnId')
  @RequireModule(ModuleKey.RETURNS)
  @RequirePermissions(Permission.RETURN_READ)
  async returnNote(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('returnId') returnId: string,
  ): Promise<{ html: string; format: 'A4' }> {
    const html = await this.documents.returnHtml(tenantId, returnId);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'return.document_printed',
      entityType: 'Return',
      entityId: returnId,
      metadata: { format: 'A4' },
    });
    return { html, format: 'A4' };
  }

  // ── Template preview (sample data) — Settings → Documents ──────

  /**
   * A4 preview HTML with sample data for the given document type. The optional
   * body lets the Settings UI preview UNSAVED document settings live.
   */
  @Post('preview/:type')
  @RequireModule(ModuleKey.SETTINGS)
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  preview(
    @TenantId() tenantId: string,
    @Param('type') type: string,
    @Body() dto: PreviewDocumentDto,
  ): { html: string; format: 'A4' } {
    const html = this.documents.previewHtml(
      tenantId,
      assertPreviewType(type),
      dto.documents,
      dto.lineCount,
    );
    return { html, format: 'A4' };
  }

  /** Downloadable sample PDF (falls back to print-ready HTML if Puppeteer is off). */
  @Get('sample-pdf/:type')
  @RequireModule(ModuleKey.SETTINGS)
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  async samplePdf(
    @TenantId() tenantId: string,
    @Param('type') type: string,
    @Res() res: Response,
  ): Promise<void> {
    const previewType = assertPreviewType(type);
    const pdf = await this.documents.previewPdf(tenantId, previewType);
    if (pdf) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${previewType}-sample.pdf"`);
      res.end(pdf);
      return;
    }
    // No server-side PDF engine — serve print-ready HTML instead.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(this.documents.previewHtml(tenantId, previewType));
  }
}
