import { formatDateInTimeZone, safeTimeZone } from '@hardware-pos/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ShareChannel } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { SettingsService } from '../settings/settings.service';
import { DocumentsService } from '../documents/documents.service';
import { QuotationDetail, QuotationShareResult } from '../quotations/quotations.types';
import { MailService } from './mail.service';
import { ShareEmailDto, ShareWhatsappDto } from './dto/share.dto';

@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly mail: MailService,
    private readonly audit: AuditLogService,
  ) {}

  async shareWhatsapp(
    tenantId: string,
    actor: AuthenticatedUser,
    q: QuotationDetail,
    dto: ShareWhatsappDto,
  ): Promise<QuotationShareResult> {
    const app = this.settings.getSettings(tenantId);
    const businessName = app.documents.companyName ?? (await this.tenantName(tenantId));
    const phone = this.normalizePhone(dto.phone ?? q.customer?.phone ?? '');
    const shareUrl = this.publicShareUrl(q.shareToken);

    const message = this.fill(app.sharing.whatsappMessageTemplate, q, businessName, safeTimeZone(app.timezone));
    const fullMessage = shareUrl ? `${message}\n${shareUrl}` : message;
    const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(fullMessage)}`;

    await this.recordShare(tenantId, q.id, 'WHATSAPP', phone || null, 'SENT', actor.id);
    return {
      channel: 'WHATSAPP',
      status: 'SENT',
      recipient: phone || null,
      whatsappUrl,
      shareUrl: shareUrl ?? undefined,
      message: fullMessage,
    };
  }

  async shareEmail(
    tenantId: string,
    actor: AuthenticatedUser,
    q: QuotationDetail,
    dto: ShareEmailDto,
  ): Promise<QuotationShareResult> {
    const app = this.settings.getSettings(tenantId);
    const businessName = app.documents.companyName ?? (await this.tenantName(tenantId));
    const to = dto.to ?? q.customer?.email ?? null;
    if (!to) {
      throw new BadRequestException('No recipient email — add one to the customer or pass "to".');
    }

    const subject = dto.subject ?? this.fill(app.sharing.emailSubjectTemplate, q, businessName, safeTimeZone(app.timezone));
    const body = dto.message ?? this.fill(app.sharing.emailBodyTemplate, q, businessName, safeTimeZone(app.timezone));
    const shareUrl = this.publicShareUrl(q.shareToken);

    // Prefer a real PDF attachment; fall back to the print-ready HTML document.
    const pdf = await this.documents.quotationPdf(tenantId, q);
    const html = await this.documents.quotationHtml(tenantId, q);
    const attachment = pdf
      ? { filename: `${q.quotationNumber}.pdf`, content: pdf, contentType: 'application/pdf' }
      : { filename: `${q.quotationNumber}.html`, content: Buffer.from(html, 'utf8'), contentType: 'text/html' };

    const from = app.sharing.emailSenderAddress
      ? `${app.sharing.emailSenderName} <${app.sharing.emailSenderAddress}>`
      : undefined;
    const result = await this.mail.send({
      to,
      cc: dto.cc,
      from,
      subject,
      text: shareUrl ? `${body}\n\nView online: ${shareUrl}` : body,
      html,
      attachments: [attachment],
    });

    await this.recordShare(
      tenantId,
      q.id,
      'EMAIL',
      to,
      result.status,
      actor.id,
      result.error,
    );
    return {
      channel: 'EMAIL',
      status: result.status,
      recipient: to,
      shareUrl: shareUrl ?? undefined,
      message: body,
      error: result.error,
    };
  }

  /** Log a download/print share event (no delivery, just the audit trail). */
  async recordDelivery(
    tenantId: string,
    actor: AuthenticatedUser,
    quotationId: string,
    channel: 'DOWNLOAD' | 'PRINT',
  ): Promise<void> {
    await this.recordShare(tenantId, quotationId, channel, null, 'SENT', actor.id);
  }

  // ── helpers ──────────────────────────────────────────────────

  private async recordShare(
    tenantId: string,
    quotationId: string,
    channel: ShareChannel,
    recipient: string | null,
    status: 'SENT' | 'FAILED' | 'PENDING',
    userId: string,
    errorMessage?: string,
  ): Promise<void> {
    await this.prisma.quotationShareLog.create({
      data: {
        tenantId,
        quotationId,
        channel,
        recipient,
        status,
        sentByUserId: userId,
        errorMessage: errorMessage ?? null,
      },
    });
    await this.audit.record(tenantId, {
      userId,
      action: 'quotation.shared',
      entityType: 'Quotation',
      entityId: quotationId,
      metadata: { channel, recipient, status },
    });
  }

  private fill(template: string, q: QuotationDetail, businessName: string, tz: string): string {
    const validUntil = q.validUntil
      ? formatDateInTimeZone(new Date(q.validUntil), tz)
      : '—';
    return template
      .replace(/\{customerName\}/g, q.customer?.name ?? 'Customer')
      .replace(/\{quotationNumber\}/g, q.revisionLabel)
      .replace(/\{businessName\}/g, businessName)
      .replace(/\{validUntil\}/g, validUntil);
  }

  /** Basic country-code handling: local Sri Lankan 0XXXXXXXXX → 94XXXXXXXXX. */
  private normalizePhone(raw: string): string {
    let digits = (raw || '').replace(/[^\d]/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) digits = `94${digits.slice(1)}`;
    return digits;
  }

  private publicShareUrl(token: string | null): string | null {
    if (!token) return null;
    const base = (process.env.PUBLIC_SHARE_BASE_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');
    return `${base}/public/quotations/${token}`;
  }

  private async tenantName(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return tenant?.name ?? 'Hardware POS';
  }
}
