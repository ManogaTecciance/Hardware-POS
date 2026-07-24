import { Injectable } from '@nestjs/common';
import { DiscountType, Prisma, QuotationStatus } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';

/** One persisted quotation line (already computed + snapshotted by the service). */
export interface PersistQuotationLine {
  productId: string | null;
  productNameSnapshot: string;
  skuSnapshot: string | null;
  imageUrlSnapshot: string | null;
  descriptionSnapshot: string | null;
  categorySnapshot: string | null;
  subcategorySnapshot: string | null;
  quantity: number;
  unitType: string | null;
  unitPrice: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountAmount: number;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  itemNote: string | null;
  availabilityStatus: string | null;
}

export interface PersistQuotationTotals {
  subtotal: number;
  productDiscountTotal: number;
  quotationDiscountType: DiscountType | null;
  quotationDiscountValue: number | null;
  quotationDiscountAmount: number;
  taxAmount: number;
  grandTotal: number;
}

export interface CreateQuotationPersist {
  branchId: string | null;
  customerId: string | null;
  createdByUserId: string;
  status: QuotationStatus;
  issueDate: Date;
  validUntil: Date | null;
  notes: string | null;
  termsAndConditions: string | null;
  shareToken: string;
  numberFormat: string;
  totals: PersistQuotationTotals;
  lines: PersistQuotationLine[];
}

export interface RevisionPersist {
  changedByUserId: string;
  changeReason: string | null;
  customerId?: string | null;
  validUntil?: Date | null;
  notes: string | null;
  termsAndConditions: string | null;
  totals: PersistQuotationTotals;
  lines: PersistQuotationLine[];
}

export interface QuotationListFilters {
  search?: string;
  status?: QuotationStatus;
  customerId?: string;
  createdByUserId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  validity?: 'valid' | 'expired';
  minTotal?: number;
  maxTotal?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

const customerSelect = {
  id: true,
  name: true,
  company: true,
  phone: true,
  email: true,
  street: true,
  city: true,
  state: true,
  zip: true,
  country: true,
  resaleNumber: true,
} satisfies Prisma.CustomerSelect;

const detailInclude = {
  customer: { select: customerSelect },
  branch: { select: { id: true, name: true, address: true, phone: true } },
  createdBy: { select: { id: true, name: true } },
  convertedSale: { select: { id: true, saleNumber: true, status: true } },
  revisions: {
    orderBy: { revisionNumber: 'desc' as const },
    take: 1,
    include: {
      items: { orderBy: { sortOrder: 'asc' as const } },
      changedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.QuotationInclude;

export type QuotationDetailRow = Prisma.QuotationGetPayload<{ include: typeof detailInclude }>;

const listInclude = {
  customer: { select: { id: true, name: true, phone: true, company: true } },
  createdBy: { select: { id: true, name: true } },
  revisions: {
    orderBy: { revisionNumber: 'desc' as const },
    take: 1,
    select: { revisionNumber: true, _count: { select: { items: true } } },
  },
} satisfies Prisma.QuotationInclude;

export type QuotationListRow = Prisma.QuotationGetPayload<{ include: typeof listInclude }>;

export type QuotationRevisionRow = Prisma.QuotationRevisionGetPayload<{
  include: { changedBy: { select: { id: true; name: true } }; items: true };
}>;

export interface SnapshotProduct {
  id: string;
  name: string;
  sku: string | null;
  imageUrl: string | null;
  description: string | null;
  unitType: string | null;
  unitPrice: Prisma.Decimal;
  quantityOnHand: Prisma.Decimal;
  trackInventory: boolean;
  isActive: boolean;
  categoryName: string | null;
  subcategoryName: string | null;
}

@Injectable()
export class QuotationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Load catalog products (+ category/subcategory names) to snapshot onto lines. */
  async findProductsForSnapshot(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, SnapshotProduct>> {
    if (ids.length === 0) return new Map();
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        sku: true,
        description: true,
        type: true,
        unitPrice: true,
        quantityOnHand: true,
        isActive: true,
        category: { select: { name: true } },
        subcategory: { select: { name: true } },
      },
    });
    return new Map(
      products.map((p) => [
        p.id,
        {
          id: p.id,
          name: p.name,
          sku: p.sku,
          imageUrl: null,
          description: p.description,
          unitType: null,
          unitPrice: p.unitPrice,
          quantityOnHand: p.quantityOnHand,
          trackInventory: p.type === 'Inventory',
          isActive: p.isActive,
          categoryName: p.category?.name ?? null,
          subcategoryName: p.subcategory?.name ?? null,
        },
      ]),
    );
  }

  private async nextQuotationNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    format: string,
  ): Promise<string> {
    const seq = padSequence(await nextDocumentNumber(tx, tenantId, 'QUOTATION'));
    return (format || 'QT-{seq}').replace('{seq}', seq);
  }

  private lineData(line: PersistQuotationLine, index: number): Prisma.QuotationItemCreateWithoutRevisionInput {
    return {
      product: line.productId ? { connect: { id: line.productId } } : undefined,
      productNameSnapshot: line.productNameSnapshot,
      skuSnapshot: line.skuSnapshot,
      imageUrlSnapshot: line.imageUrlSnapshot,
      descriptionSnapshot: line.descriptionSnapshot,
      categorySnapshot: line.categorySnapshot,
      subcategorySnapshot: line.subcategorySnapshot,
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
      sortOrder: index,
    };
  }

  async create(tenantId: string, input: CreateQuotationPersist): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const quotationNumber = await this.nextQuotationNumber(tx, tenantId, input.numberFormat);
      const quotation = await tx.quotation.create({
        data: {
          tenantId,
          branchId: input.branchId,
          customerId: input.customerId,
          createdByUserId: input.createdByUserId,
          quotationNumber,
          currentRevisionNumber: 0,
          status: input.status,
          issueDate: input.issueDate,
          validUntil: input.validUntil,
          notes: input.notes,
          termsAndConditions: input.termsAndConditions,
          shareToken: input.shareToken,
          subtotal: input.totals.subtotal,
          productDiscountTotal: input.totals.productDiscountTotal,
          quotationDiscountType: input.totals.quotationDiscountType,
          quotationDiscountValue: input.totals.quotationDiscountValue,
          quotationDiscountAmount: input.totals.quotationDiscountAmount,
          taxAmount: input.totals.taxAmount,
          grandTotal: input.totals.grandTotal,
          revisions: {
            create: {
              revisionNumber: 0,
              changedByUserId: input.createdByUserId,
              changeReason: null,
              subtotal: input.totals.subtotal,
              productDiscountTotal: input.totals.productDiscountTotal,
              quotationDiscountType: input.totals.quotationDiscountType,
              quotationDiscountValue: input.totals.quotationDiscountValue,
              quotationDiscountAmount: input.totals.quotationDiscountAmount,
              taxAmount: input.totals.taxAmount,
              grandTotal: input.totals.grandTotal,
              notes: input.notes,
              termsAndConditions: input.termsAndConditions,
              validUntil: input.validUntil,
              items: { create: input.lines.map((l, i) => this.lineData(l, i)) },
            },
          },
        },
      });
      return quotation.id;
    });
  }

  /** Replace the current (latest) revision's contents in place — DRAFT editing. */
  async updateDraftRevision(
    tenantId: string,
    quotationId: string,
    currentRevisionNumber: number,
    patch: {
      customerId?: string | null;
      validUntil?: Date | null;
      notes?: string | null;
      termsAndConditions?: string | null;
    },
    totals: PersistQuotationTotals,
    lines: PersistQuotationLine[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revision = await tx.quotationRevision.findFirst({
        where: { quotationId, revisionNumber: currentRevisionNumber },
        select: { id: true },
      });
      if (revision) {
        await tx.quotationItem.deleteMany({ where: { quotationRevisionId: revision.id } });
        await tx.quotationRevision.update({
          where: { id: revision.id },
          data: {
            subtotal: totals.subtotal,
            productDiscountTotal: totals.productDiscountTotal,
            quotationDiscountType: totals.quotationDiscountType,
            quotationDiscountValue: totals.quotationDiscountValue,
            quotationDiscountAmount: totals.quotationDiscountAmount,
            taxAmount: totals.taxAmount,
            grandTotal: totals.grandTotal,
            notes: patch.notes,
            termsAndConditions: patch.termsAndConditions,
            validUntil: patch.validUntil,
            items: { create: lines.map((l, i) => this.lineData(l, i)) },
          },
        });
      }
      await tx.quotation.update({
        where: { id: quotationId },
        data: {
          ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
          ...(patch.validUntil !== undefined ? { validUntil: patch.validUntil } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.termsAndConditions !== undefined
            ? { termsAndConditions: patch.termsAndConditions }
            : {}),
          subtotal: totals.subtotal,
          productDiscountTotal: totals.productDiscountTotal,
          quotationDiscountType: totals.quotationDiscountType,
          quotationDiscountValue: totals.quotationDiscountValue,
          quotationDiscountAmount: totals.quotationDiscountAmount,
          taxAmount: totals.taxAmount,
          grandTotal: totals.grandTotal,
        },
      });
    });
  }

  /** Append a new immutable revision and re-point the quotation mirror at it. */
  async createRevision(
    tenantId: string,
    quotationId: string,
    currentRevisionNumber: number,
    previousGrandTotal: number,
    input: RevisionPersist,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.quotationRevision.findFirst({
        where: { quotationId, revisionNumber: currentRevisionNumber },
        select: { id: true },
      });
      const nextNumber = currentRevisionNumber + 1;
      await tx.quotationRevision.create({
        data: {
          quotationId,
          revisionNumber: nextNumber,
          previousRevisionId: previous?.id ?? null,
          changedByUserId: input.changedByUserId,
          changeReason: input.changeReason,
          previousGrandTotal,
          subtotal: input.totals.subtotal,
          productDiscountTotal: input.totals.productDiscountTotal,
          quotationDiscountType: input.totals.quotationDiscountType,
          quotationDiscountValue: input.totals.quotationDiscountValue,
          quotationDiscountAmount: input.totals.quotationDiscountAmount,
          taxAmount: input.totals.taxAmount,
          grandTotal: input.totals.grandTotal,
          notes: input.notes,
          termsAndConditions: input.termsAndConditions,
          validUntil: input.validUntil,
          items: { create: input.lines.map((l, i) => this.lineData(l, i)) },
        },
      });
      await tx.quotation.update({
        where: { id: quotationId },
        data: {
          currentRevisionNumber: nextNumber,
          status: 'REVISED',
          ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
          ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
          notes: input.notes,
          termsAndConditions: input.termsAndConditions,
          subtotal: input.totals.subtotal,
          productDiscountTotal: input.totals.productDiscountTotal,
          quotationDiscountType: input.totals.quotationDiscountType,
          quotationDiscountValue: input.totals.quotationDiscountValue,
          quotationDiscountAmount: input.totals.quotationDiscountAmount,
          taxAmount: input.totals.taxAmount,
          grandTotal: input.totals.grandTotal,
        },
      });
      return nextNumber;
    });
  }

  findDetail(tenantId: string, id: string): Promise<QuotationDetailRow | null> {
    return this.prisma.quotation.findFirst({ where: { id, tenantId }, include: detailInclude });
  }

  findByShareToken(token: string): Promise<QuotationDetailRow | null> {
    return this.prisma.quotation.findFirst({ where: { shareToken: token }, include: detailInclude });
  }

  async list(
    tenantId: string,
    filters: QuotationListFilters,
    skip: number,
    take: number,
  ): Promise<[QuotationListRow[], number]> {
    const now = new Date();
    const where: Prisma.QuotationWhereInput = {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.createdByUserId ? { createdByUserId: filters.createdByUserId } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? { issueDate: { ...(filters.dateFrom ? { gte: filters.dateFrom } : {}), ...(filters.dateTo ? { lte: filters.dateTo } : {}) } }
        : {}),
      ...(filters.minTotal != null || filters.maxTotal != null
        ? { grandTotal: { ...(filters.minTotal != null ? { gte: filters.minTotal } : {}), ...(filters.maxTotal != null ? { lte: filters.maxTotal } : {}) } }
        : {}),
      ...(filters.validity === 'valid' ? { validUntil: { gte: now } } : {}),
      ...(filters.validity === 'expired' ? { validUntil: { lt: now } } : {}),
      ...(filters.search
        ? {
            OR: [
              { quotationNumber: { contains: filters.search, mode: 'insensitive' } },
              { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
              { customer: { phone: { contains: filters.search, mode: 'insensitive' } } },
              { customer: { company: { contains: filters.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const sortField = filters.sortBy ?? 'createdAt';
    const orderBy: Prisma.QuotationOrderByWithRelationInput = {
      [sortField]: filters.sortDir ?? 'desc',
    };

    return this.prisma.$transaction([
      this.prisma.quotation.findMany({ where, include: listInclude, orderBy, skip, take }),
      this.prisma.quotation.count({ where }),
    ]);
  }

  findRevisions(tenantId: string, quotationId: string): Promise<QuotationRevisionRow[]> {
    return this.prisma.quotationRevision.findMany({
      where: { quotationId, quotation: { tenantId } },
      orderBy: { revisionNumber: 'desc' },
      include: { changedBy: { select: { id: true, name: true } }, items: true },
    });
  }

  findRevision(
    tenantId: string,
    quotationId: string,
    revisionId: string,
  ): Promise<QuotationRevisionRow | null> {
    return this.prisma.quotationRevision.findFirst({
      where: { id: revisionId, quotationId, quotation: { tenantId } },
      include: { changedBy: { select: { id: true, name: true } }, items: true },
    });
  }

  setStatus(tenantId: string, id: string, status: QuotationStatus): Promise<{ id: string }> {
    return this.prisma.quotation.update({ where: { id }, data: { status }, select: { id: true } });
  }

  linkConvertedSale(tenantId: string, id: string, saleId: string): Promise<{ id: string }> {
    return this.prisma.quotation.update({
      where: { id },
      data: { convertedSaleId: saleId, status: 'CONVERTED_TO_SALE' },
      select: { id: true },
    });
  }
}
