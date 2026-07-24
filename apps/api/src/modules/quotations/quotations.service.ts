import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountType, QuotationStatus } from '@hardware-pos/database';
import type { Paginated, QuotationStatusCode } from '@hardware-pos/shared';

import { customerAddressLine } from '../../common/customer-display';
import { paginate } from '../../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { SettingsService } from '../settings/settings.service';
import { CompleteSaleDto } from '../sales/dto/complete-sale.dto';
import { SalesService } from '../sales/sales.service';
import { DocumentsService } from '../documents/documents.service';
import { SharingService } from '../sharing/sharing.service';
import { ShareEmailDto, ShareWhatsappDto } from '../sharing/dto/share.dto';
import { computeQuotationTotals, QuotationDiscountInput } from './quotations.calc';
import {
  CreateQuotationPersist,
  PersistQuotationLine,
  PersistQuotationTotals,
  QuotationDetailRow,
  QuotationListRow,
  QuotationRevisionRow,
  QuotationsRepository,
  RevisionPersist,
} from './quotations.repository';
import {
  QuotationDetail,
  QuotationItemView,
  QuotationListItem,
  QuotationPreview,
  QuotationRevisionDetail,
  QuotationRevisionSummary,
  QuotationShareResult,
} from './quotations.types';
import { CreateQuotationDto } from './dto/create-quotation.dto';
import { CreateRevisionDto } from './dto/create-revision.dto';
import { QuotationItemInputDto } from './dto/quotation-item.dto';
import { QueryQuotationsDto } from './dto/query-quotations.dto';
import { UpdateQuotationDto } from './dto/update-quotation.dto';
import { ConvertQuotationDto } from './dto/convert-quotation.dto';

/** A line resolved to its snapshot + pricing inputs, before money is computed. */
interface ResolvedLine {
  productId: string | null;
  productName: string;
  sku: string | null;
  imageUrl: string | null;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  quantity: number;
  unitType: string | null;
  unitPrice: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  itemNote: string | null;
  availabilityStatus: string | null;
}

@Injectable()
export class QuotationsService {
  constructor(
    private readonly repo: QuotationsRepository,
    private readonly settings: SettingsService,
    private readonly auditLog: AuditLogService,
    private readonly salesService: SalesService,
    private readonly documents: DocumentsService,
    private readonly sharing: SharingService,
  ) {}

  // ── Public API ───────────────────────────────────────────────

  async preview(tenantId: string, dto: CreateQuotationDto): Promise<QuotationPreview> {
    const app = this.settings.getSettings(tenantId);
    const resolved = await this.resolveFromInputs(tenantId, dto.items ?? [], app.quotation.allowPriceOverride, app.quotation.allowWithoutStock);
    const { lines, totals } = this.finalize(resolved, this.orderDiscount(dto.quotationDiscountType, dto.quotationDiscountValue), app.taxRatePercent);
    return {
      ...totals,
      taxRatePercent: app.taxRatePercent,
      items: lines.map((l) => this.lineToView(l, null)),
    };
  }

  async create(
    tenantId: string,
    actor: AuthenticatedUser,
    dto: CreateQuotationDto,
  ): Promise<QuotationDetail> {
    const app = this.settings.getSettings(tenantId);
    if (app.quotation.requireCustomer && !dto.customerId) {
      throw new BadRequestException('A customer is required before saving this quotation');
    }
    const resolved = await this.resolveFromInputs(
      tenantId,
      dto.items ?? [],
      app.quotation.allowPriceOverride,
      app.quotation.allowWithoutStock,
    );
    const { lines, totals } = this.finalize(
      resolved,
      this.orderDiscount(dto.quotationDiscountType, dto.quotationDiscountValue),
      app.taxRatePercent,
    );

    const persist: CreateQuotationPersist = {
      branchId: dto.branchId ?? null,
      customerId: dto.customerId ?? null,
      createdByUserId: actor.id,
      status: dto.status === 'SENT' ? 'SENT' : 'DRAFT',
      issueDate: new Date(),
      validUntil: this.resolveValidUntil(dto.validUntil, app.quotation.defaultValidityDays),
      notes: dto.notes ?? null,
      termsAndConditions: dto.termsAndConditions ?? app.quotation.defaultTermsAndConditions ?? null,
      shareToken: this.newShareToken(),
      numberFormat: app.quotation.numberFormat,
      totals,
      lines,
    };

    const id = await this.repo.create(tenantId, persist);
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.created',
      entityType: 'Quotation',
      entityId: id,
      metadata: { grandTotal: totals.grandTotal, status: persist.status, itemCount: lines.length },
    });
    return this.getById(tenantId, id);
  }

  async list(tenantId: string, query: QueryQuotationsDto): Promise<Paginated<QuotationListItem>> {
    const [rows, total] = await this.repo.list(
      tenantId,
      {
        search: query.search,
        status: query.status as QuotationStatus | undefined,
        customerId: query.customerId,
        createdByUserId: query.createdByUserId,
        dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
        dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
        validity: query.validity,
        minTotal: query.minTotal,
        maxTotal: query.maxTotal,
        sortBy: query.sortBy,
        sortDir: query.sortDir,
      },
      query.skip,
      query.take,
    );
    const items = await Promise.all(rows.map((r) => this.mapListItem(tenantId, r)));
    return paginate(items, total, query.page, query.pageSize);
  }

  async getById(tenantId: string, id: string): Promise<QuotationDetail> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    return this.mapDetail(tenantId, row);
  }

  async update(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateQuotationDto,
  ): Promise<QuotationDetail> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    if (row.status !== 'DRAFT') {
      throw new BadRequestException(
        'Only draft quotations can be edited in place. Create a revision to change an issued quotation.',
      );
    }
    const app = this.settings.getSettings(tenantId);

    const current = row.revisions[0];
    const resolved = dto.items
      ? await this.resolveFromInputs(tenantId, dto.items, app.quotation.allowPriceOverride, app.quotation.allowWithoutStock)
      : this.resolveFromExisting(current?.items ?? []);

    const orderDiscount = dto.clearQuotationDiscount
      ? null
      : dto.quotationDiscountType !== undefined || dto.quotationDiscountValue !== undefined
        ? this.orderDiscount(dto.quotationDiscountType, dto.quotationDiscountValue)
        : this.orderDiscount(row.quotationDiscountType, this.num(row.quotationDiscountValue));

    const { lines, totals } = this.finalize(resolved, orderDiscount, app.taxRatePercent);

    await this.repo.updateDraftRevision(
      tenantId,
      id,
      row.currentRevisionNumber,
      {
        customerId: dto.customerId,
        validUntil: dto.validUntil !== undefined ? this.resolveValidUntil(dto.validUntil, app.quotation.defaultValidityDays) : undefined,
        notes: dto.notes,
        termsAndConditions: dto.termsAndConditions,
      },
      totals,
      lines,
    );
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.updated',
      entityType: 'Quotation',
      entityId: id,
      metadata: { grandTotal: totals.grandTotal, itemCount: lines.length },
    });
    return this.getById(tenantId, id);
  }

  async createRevision(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
    dto: CreateRevisionDto,
  ): Promise<QuotationDetail> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    if (row.status === 'CONVERTED_TO_SALE' || row.status === 'CANCELLED') {
      throw new BadRequestException(`A ${row.status.toLowerCase()} quotation cannot be revised`);
    }
    const app = this.settings.getSettings(tenantId);

    const resolved = await this.resolveFromInputs(
      tenantId,
      dto.items,
      app.quotation.allowPriceOverride,
      app.quotation.allowWithoutStock,
    );
    const orderDiscount = dto.clearQuotationDiscount
      ? null
      : this.orderDiscount(dto.quotationDiscountType, dto.quotationDiscountValue);
    const { lines, totals } = this.finalize(resolved, orderDiscount, app.taxRatePercent);

    const persist: RevisionPersist = {
      changedByUserId: actor.id,
      changeReason: dto.changeReason ?? null,
      customerId: dto.customerId,
      validUntil: dto.validUntil !== undefined ? this.resolveValidUntil(dto.validUntil, app.quotation.defaultValidityDays) : undefined,
      notes: dto.notes ?? row.notes,
      termsAndConditions: dto.termsAndConditions ?? row.termsAndConditions,
      totals,
      lines,
    };
    const newNumber = await this.repo.createRevision(
      tenantId,
      id,
      row.currentRevisionNumber,
      this.num(row.grandTotal),
      persist,
    );
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.revision_created',
      entityType: 'Quotation',
      entityId: id,
      metadata: { revisionNumber: newNumber, oldTotal: this.num(row.grandTotal), newTotal: totals.grandTotal, changeReason: dto.changeReason },
    });
    return this.getById(tenantId, id);
  }

  async listRevisions(tenantId: string, id: string): Promise<QuotationRevisionSummary[]> {
    await this.assertExists(tenantId, id);
    const rows = await this.repo.findRevisions(tenantId, id);
    return rows.map((r) => this.mapRevisionSummary(r));
  }

  async getRevision(
    tenantId: string,
    id: string,
    revisionId: string,
  ): Promise<QuotationRevisionDetail> {
    const row = await this.repo.findRevision(tenantId, id, revisionId);
    if (!row) throw new NotFoundException('Revision not found');
    return this.mapRevisionDetail(row);
  }

  async duplicate(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<QuotationDetail> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    const app = this.settings.getSettings(tenantId);
    const current = row.revisions[0];
    const resolved = this.resolveFromExisting(current?.items ?? []);
    const { lines, totals } = this.finalize(
      resolved,
      this.orderDiscount(row.quotationDiscountType, this.num(row.quotationDiscountValue)),
      app.taxRatePercent,
    );

    const persist: CreateQuotationPersist = {
      branchId: row.branchId,
      customerId: row.customerId,
      createdByUserId: actor.id,
      status: 'DRAFT',
      issueDate: new Date(),
      validUntil: this.resolveValidUntil(undefined, app.quotation.defaultValidityDays),
      notes: row.notes,
      termsAndConditions: row.termsAndConditions,
      shareToken: this.newShareToken(),
      numberFormat: app.quotation.numberFormat,
      totals,
      lines,
    };
    const newId = await this.repo.create(tenantId, persist);
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.duplicated',
      entityType: 'Quotation',
      entityId: newId,
      metadata: { sourceQuotationId: id, sourceNumber: row.quotationNumber },
    });
    return this.getById(tenantId, newId);
  }

  async markSent(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<QuotationDetail> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    if (row.status === 'CONVERTED_TO_SALE' || row.status === 'CANCELLED') {
      throw new BadRequestException(`A ${row.status.toLowerCase()} quotation cannot be marked as sent`);
    }
    await this.repo.setStatus(tenantId, id, 'SENT');
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.marked_sent',
      entityType: 'Quotation',
      entityId: id,
    });
    return this.getById(tenantId, id);
  }

  async cancel(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<QuotationDetail> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    if (row.status === 'CONVERTED_TO_SALE') {
      throw new BadRequestException('A converted quotation cannot be cancelled');
    }
    await this.repo.setStatus(tenantId, id, 'CANCELLED');
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.cancelled',
      entityType: 'Quotation',
      entityId: id,
    });
    return this.getById(tenantId, id);
  }

  async convertToSale(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
    dto: ConvertQuotationDto,
  ): Promise<{ saleId: string; saleNumber: string; quotationId: string }> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
    if (row.status === 'CANCELLED') {
      throw new BadRequestException('A cancelled quotation cannot be converted');
    }
    if (row.convertedSaleId) {
      const isAdmin = actor.role === 'OWNER' || actor.role === 'ADMIN';
      if (!dto.override || !isAdmin) {
        throw new ConflictException(
          'This quotation has already been converted to a sale. An owner/admin can override.',
        );
      }
    }

    const current = row.revisions[0];
    if (!current || current.items.length === 0) {
      throw new BadRequestException('This quotation has no items to convert');
    }
    const adHoc = current.items.filter((it) => !it.productId);
    if (adHoc.length > 0) {
      throw new BadRequestException(
        'All quotation lines must be catalog products to convert to a sale',
      );
    }

    const branchId = row.branchId ?? dto.branchId;
    if (!branchId) throw new BadRequestException('A branch is required to create the sale');

    const payments = dto.payments ?? [];
    if (payments.length === 0 && !row.customerId) {
      throw new BadRequestException(
        'Add a customer or take payment to convert — an unpaid sale is billed as a customer invoice.',
      );
    }

    const saleDto: CompleteSaleDto = {
      branchId,
      registerId: dto.registerId,
      customerId: row.customerId ?? undefined,
      items: current.items.map((it) => ({
        productId: it.productId as string,
        quantity: this.num(it.quantity),
        unitPrice: this.num(it.unitPrice),
        discountType: (it.discountType as DiscountType | null) ?? undefined,
        discountValue: it.discountValue != null ? this.num(it.discountValue) : undefined,
      })),
      payments,
      orderDiscountType: (row.quotationDiscountType as DiscountType | null) ?? undefined,
      orderDiscountValue: row.quotationDiscountValue != null ? this.num(row.quotationDiscountValue) : undefined,
      orderDiscountReason: `Converted from quotation ${row.quotationNumber}`,
    };

    const sale = await this.salesService.complete(tenantId, actor, saleDto);
    await this.repo.linkConvertedSale(tenantId, id, sale.id);
    await this.auditLog.record(tenantId, {
      userId: actor.id,
      action: 'quotation.converted_to_sale',
      entityType: 'Quotation',
      entityId: id,
      metadata: { saleId: sale.id, saleNumber: sale.saleNumber, quotationNumber: row.quotationNumber },
    });
    return { saleId: sale.id, saleNumber: sale.saleNumber, quotationId: id };
  }

  // ── Documents + sharing ──────────────────────────────────────

  async document(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<{ html: string; pdfAvailable: boolean }> {
    const q = await this.getById(tenantId, id);
    const html = await this.documents.quotationHtml(tenantId, q);
    await this.sharing.recordDelivery(tenantId, actor, id, 'DOWNLOAD');
    return { html, pdfAvailable: this.documents.pdfAvailable };
  }

  /** Render the read-only A4 HTML for a public share token (no auth). */
  async publicDocument(token: string): Promise<string> {
    const row = await this.repo.findByShareToken(token);
    if (!row) throw new NotFoundException('Quotation not found');
    const detail = this.mapDetail(row.tenantId, row);
    return this.documents.quotationHtml(row.tenantId, detail);
  }

  async shareWhatsapp(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
    dto: ShareWhatsappDto,
  ): Promise<QuotationShareResult> {
    const q = await this.getById(tenantId, id);
    return this.sharing.shareWhatsapp(tenantId, actor, q, dto);
  }

  async shareEmail(
    tenantId: string,
    actor: AuthenticatedUser,
    id: string,
    dto: ShareEmailDto,
  ): Promise<QuotationShareResult> {
    const q = await this.getById(tenantId, id);
    return this.sharing.shareEmail(tenantId, actor, q, dto);
  }

  // ── Line resolution + money ──────────────────────────────────

  private async resolveFromInputs(
    tenantId: string,
    items: QuotationItemInputDto[],
    allowPriceOverride: boolean,
    allowWithoutStock: boolean,
  ): Promise<ResolvedLine[]> {
    const productIds = items.map((i) => i.productId).filter((id): id is string => Boolean(id));
    const products = await this.repo.findProductsForSnapshot(tenantId, productIds);

    return items.map((item) => {
      if (item.productId) {
        const product = products.get(item.productId);
        if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

        const unitPrice =
          allowPriceOverride && item.unitPrice != null ? item.unitPrice : Number(product.unitPrice);
        const onHand = Number(product.quantityOnHand);
        let availabilityStatus = 'IN_STOCK';
        if (!product.isActive) availabilityStatus = 'INACTIVE';
        else if (product.trackInventory && onHand <= 0) availabilityStatus = 'OUT_OF_STOCK';
        else if (product.trackInventory && onHand < item.quantity) availabilityStatus = 'INSUFFICIENT_STOCK';

        if (!allowWithoutStock && availabilityStatus !== 'IN_STOCK') {
          throw new BadRequestException(
            `"${product.name}" is not available in the requested quantity`,
          );
        }
        return {
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          imageUrl: product.imageUrl,
          description: item.description ?? product.description,
          category: product.categoryName,
          subcategory: product.subcategoryName,
          quantity: item.quantity,
          unitType: item.unitType ?? product.unitType,
          unitPrice,
          discountType: (item.discountType as DiscountType | undefined) ?? null,
          discountValue: item.discountValue ?? null,
          itemNote: item.itemNote ?? null,
          availabilityStatus,
        };
      }

      // Ad-hoc line (no catalog product).
      if (!item.productName) {
        throw new BadRequestException('A line without a product must have a product name');
      }
      if (item.unitPrice == null) {
        throw new BadRequestException(`A price is required for "${item.productName}"`);
      }
      return {
        productId: null,
        productName: item.productName,
        sku: item.sku ?? null,
        imageUrl: null,
        description: item.description ?? null,
        category: null,
        subcategory: null,
        quantity: item.quantity,
        unitType: item.unitType ?? null,
        unitPrice: item.unitPrice,
        discountType: (item.discountType as DiscountType | undefined) ?? null,
        discountValue: item.discountValue ?? null,
        itemNote: item.itemNote ?? null,
        availabilityStatus: null,
      };
    });
  }

  /** Rebuild resolved lines from a stored revision (keeps captured snapshots + price). */
  private resolveFromExisting(items: QuotationDetailRow['revisions'][number]['items']): ResolvedLine[] {
    return items.map((it) => ({
      productId: it.productId,
      productName: it.productNameSnapshot,
      sku: it.skuSnapshot,
      imageUrl: it.imageUrlSnapshot,
      description: it.descriptionSnapshot,
      category: it.categorySnapshot,
      subcategory: it.subcategorySnapshot,
      quantity: this.num(it.quantity),
      unitType: it.unitType,
      unitPrice: this.num(it.unitPrice),
      discountType: it.discountType,
      discountValue: it.discountValue != null ? this.num(it.discountValue) : null,
      itemNote: it.itemNote,
      availabilityStatus: it.availabilityStatus,
    }));
  }

  private finalize(
    resolved: ResolvedLine[],
    orderDiscount: QuotationDiscountInput | null,
    taxRatePercent: number,
  ): { lines: PersistQuotationLine[]; totals: PersistQuotationTotals } {
    const totals = computeQuotationTotals(
      resolved.map((r) => ({
        unitPrice: r.unitPrice,
        quantity: r.quantity,
        discountType: r.discountType,
        discountValue: r.discountValue,
      })),
      orderDiscount,
      taxRatePercent,
    );
    const lines: PersistQuotationLine[] = resolved.map((r, i) => ({
      productId: r.productId,
      productNameSnapshot: r.productName,
      skuSnapshot: r.sku,
      imageUrlSnapshot: r.imageUrl,
      descriptionSnapshot: r.description,
      categorySnapshot: r.category,
      subcategorySnapshot: r.subcategory,
      quantity: r.quantity,
      unitType: r.unitType,
      unitPrice: totals.lines[i].unitPrice,
      discountType: totals.lines[i].discountType as DiscountType | null,
      discountValue: totals.lines[i].discountValue,
      discountAmount: totals.lines[i].discountAmount,
      taxAmount: totals.lines[i].taxAmount,
      lineSubtotal: totals.lines[i].lineSubtotal,
      lineTotal: totals.lines[i].lineTotal,
      itemNote: r.itemNote,
      availabilityStatus: r.availabilityStatus,
    }));
    return {
      lines,
      totals: {
        subtotal: totals.subtotal,
        productDiscountTotal: totals.productDiscountTotal,
        quotationDiscountType: totals.quotationDiscountType as DiscountType | null,
        quotationDiscountValue: totals.quotationDiscountValue,
        quotationDiscountAmount: totals.quotationDiscountAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
      },
    };
  }

  private orderDiscount(
    type: DiscountType | null | undefined,
    value: number | null | undefined,
  ): QuotationDiscountInput | null {
    if (!type || value == null || value <= 0) return null;
    return { type: type as 'PERCENTAGE' | 'FIXED', value };
  }

  // ── Mapping (Prisma Decimals → numbers / view shapes) ────────

  private async mapListItem(tenantId: string, row: QuotationListRow): Promise<QuotationListItem> {
    const latest = row.revisions[0];
    return {
      id: row.id,
      quotationNumber: row.quotationNumber,
      revisionLabel: this.revisionLabel(tenantId, row.quotationNumber, row.currentRevisionNumber),
      currentRevisionNumber: row.currentRevisionNumber,
      status: row.status as QuotationStatusCode,
      issueDate: row.issueDate.toISOString(),
      validUntil: row.validUntil ? row.validUntil.toISOString() : null,
      isExpired: this.isExpired(row.validUntil, row.status),
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      customerPhone: row.customer?.phone ?? null,
      itemCount: latest?._count.items ?? 0,
      grandTotal: this.num(row.grandTotal),
      createdByName: row.createdBy?.name ?? null,
      updatedAt: row.updatedAt.toISOString(),
      convertedSaleId: row.convertedSaleId,
    };
  }

  private mapDetail(tenantId: string, row: QuotationDetailRow): QuotationDetail {
    const current = row.revisions[0];
    return {
      id: row.id,
      quotationNumber: row.quotationNumber,
      revisionLabel: this.revisionLabel(tenantId, row.quotationNumber, row.currentRevisionNumber),
      currentRevisionNumber: row.currentRevisionNumber,
      status: row.status as QuotationStatusCode,
      issueDate: row.issueDate.toISOString(),
      validUntil: row.validUntil ? row.validUntil.toISOString() : null,
      isExpired: this.isExpired(row.validUntil, row.status),
      notes: row.notes,
      termsAndConditions: row.termsAndConditions,
      // Snapshot keeps its historical field names; the QB-shaped customer
      // record is projected onto them (address parts → one billing line).
      customer: row.customer
        ? {
            id: row.customer.id,
            name: row.customer.name,
            companyName: row.customer.company,
            phone: row.customer.phone,
            email: row.customer.email,
            billingAddress: customerAddressLine(row.customer),
            taxNumber: row.customer.resaleNumber,
          }
        : null,
      createdByName: row.createdBy?.name ?? null,
      branchName: row.branch?.name ?? null,
      branchAddress: row.branch?.address ?? null,
      branchPhone: row.branch?.phone ?? null,
      convertedSaleId: row.convertedSaleId,
      convertedSaleNumber: row.convertedSale?.saleNumber ?? null,
      shareToken: row.shareToken,
      subtotal: this.num(row.subtotal),
      productDiscountTotal: this.num(row.productDiscountTotal),
      quotationDiscountType: row.quotationDiscountType,
      quotationDiscountValue: row.quotationDiscountValue != null ? this.num(row.quotationDiscountValue) : null,
      quotationDiscountAmount: this.num(row.quotationDiscountAmount),
      taxAmount: this.num(row.taxAmount),
      grandTotal: this.num(row.grandTotal),
      items: (current?.items ?? []).map((it) => this.itemRowToView(it)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapRevisionSummary(row: QuotationRevisionRow): QuotationRevisionSummary {
    return {
      id: row.id,
      revisionNumber: row.revisionNumber,
      changeReason: row.changeReason,
      previousGrandTotal: row.previousGrandTotal != null ? this.num(row.previousGrandTotal) : null,
      grandTotal: this.num(row.grandTotal),
      itemCount: row.items.length,
      changedByName: row.changedBy?.name ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mapRevisionDetail(row: QuotationRevisionRow): QuotationRevisionDetail {
    return {
      ...this.mapRevisionSummary(row),
      subtotal: this.num(row.subtotal),
      productDiscountTotal: this.num(row.productDiscountTotal),
      quotationDiscountType: row.quotationDiscountType,
      quotationDiscountValue: row.quotationDiscountValue != null ? this.num(row.quotationDiscountValue) : null,
      quotationDiscountAmount: this.num(row.quotationDiscountAmount),
      taxAmount: this.num(row.taxAmount),
      grandTotal: this.num(row.grandTotal),
      notes: row.notes,
      termsAndConditions: row.termsAndConditions,
      validUntil: row.validUntil ? row.validUntil.toISOString() : null,
      items: row.items.map((it) => this.itemRowToView(it)),
    };
  }

  private itemRowToView(it: QuotationRevisionRow['items'][number]): QuotationItemView {
    return {
      id: it.id,
      productId: it.productId,
      productName: it.productNameSnapshot,
      sku: it.skuSnapshot,
      imageUrl: it.imageUrlSnapshot,
      description: it.descriptionSnapshot,
      category: it.categorySnapshot,
      subcategory: it.subcategorySnapshot,
      quantity: this.num(it.quantity),
      unitType: it.unitType,
      unitPrice: this.num(it.unitPrice),
      discountType: it.discountType,
      discountValue: it.discountValue != null ? this.num(it.discountValue) : null,
      discountAmount: this.num(it.discountAmount),
      taxAmount: this.num(it.taxAmount),
      lineSubtotal: this.num(it.lineSubtotal),
      lineTotal: this.num(it.lineTotal),
      itemNote: it.itemNote,
      availabilityStatus: it.availabilityStatus,
    };
  }

  private lineToView(line: PersistQuotationLine, id: string | null): QuotationItemView {
    return {
      id,
      productId: line.productId,
      productName: line.productNameSnapshot,
      sku: line.skuSnapshot,
      imageUrl: line.imageUrlSnapshot,
      description: line.descriptionSnapshot,
      category: line.categorySnapshot,
      subcategory: line.subcategorySnapshot,
      quantity: line.quantity,
      unitType: line.unitType,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discountValue: line.discountValue,
      discountAmount: line.discountAmount,
      taxAmount: line.taxAmount,
      lineSubtotal: line.lineSubtotal,
      lineTotal: line.lineTotal,
      itemNote: line.itemNote,
      availabilityStatus: line.availabilityStatus,
    };
  }

  // ── Small helpers ────────────────────────────────────────────

  private async assertExists(tenantId: string, id: string): Promise<void> {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw new NotFoundException('Quotation not found');
  }

  private num(value: unknown): number {
    return value == null ? 0 : Number(value);
  }

  private newShareToken(): string {
    return randomBytes(18).toString('hex');
  }

  private revisionLabel(tenantId: string, quotationNumber: string, revisionNumber: number): string {
    if (revisionNumber <= 0) return quotationNumber;
    const format = this.settings.getSettings(tenantId).quotation.revisionFormat || '{number}-R{rev}';
    return format.replace('{number}', quotationNumber).replace('{rev}', String(revisionNumber));
  }

  private isExpired(validUntil: Date | null, status: string): boolean {
    if (!validUntil) return false;
    if (status === 'CONVERTED_TO_SALE' || status === 'CANCELLED') return false;
    return validUntil.getTime() < Date.now();
  }

  private resolveValidUntil(input: string | undefined, defaultDays: number): Date | null {
    if (input) return new Date(input);
    const d = new Date();
    d.setDate(d.getDate() + (defaultDays || 14));
    return d;
  }
}
