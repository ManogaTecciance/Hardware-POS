import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  PaymentMethod,
  Prisma,
  QuickBooksReturnDocumentType,
  UserRole,
} from '@hardware-pos/database';
import { safeTimeZone, type Paginated } from '@hardware-pos/shared';

import { round2 } from '../../common/money';
import { paginate } from '../../common/pagination';
import { AuthenticatedUser } from '../auth/auth.types';
import { AuthService } from '../auth/auth.service';
import { Permission, roleHasPermission } from '../auth/permissions';
import { formatReceiptDateTime } from '../receipts/receipt-templates';
import { SettingsService } from '../settings/settings.service';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import { computeReturnLine, sumReturnTotals, type ComputedReturnLine } from './returns.calc';
import {
  ReturnListRow,
  ReturnWithRelations,
  ReturnsRepository,
  SaleForReturn,
} from './returns.repository';
import { renderReturnReceipt, type ReturnReceiptData } from './return-receipt.template';
import {
  PersistReturnItem,
  ReturnApprovalResult,
  ReturnApprovalTokenPayload,
  ReturnEligibility,
  ReturnListItem,
  ReturnPreview,
  ReturnPreviewItem,
  ReturnableItem,
} from './returns.types';
import { ApproveReturnDto } from './dto/approve-return.dto';
import { CreateReturnDto } from './dto/create-return.dto';
import { PreviewReturnDto } from './dto/preview-return.dto';
import { QueryReturnsDto } from './dto/query-returns.dto';
import { ReturnItemInputDto } from './dto/return-item-input.dto';

const APPROVAL_TOKEN_TTL = '15m';
const APPROVAL_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Half of a Decimal(12,3) quantity's last digit; used for "fully returned". */
const QTY_EPSILON = 0.0005;
/** Money comparison tolerance (half a cent). */
const MONEY_EPSILON = 0.005;
/** Conditions that must never re-enter normal available stock. */
const NON_RESTOCKABLE = new Set<string>(['DAMAGED', 'DEFECTIVE', 'OPENED_USED', 'NON_RESELLABLE']);

/** Result of validating + pricing a return selection (shared by preview & complete). */
interface ComputedReturn {
  previewItems: ReturnPreviewItem[];
  persistItems: PersistReturnItem[];
  computedLines: ComputedReturnLine[];
  totals: ReturnType<typeof sumReturnTotals>;
  isFullReturn: boolean;
}

@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    private readonly repo: ReturnsRepository,
    private readonly settingsService: SettingsService,
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly syncQueue: SyncQueueService,
  ) {}

  // ── sale eligibility / returnable items ────────────────────────────────────

  async getEligibility(tenantId: string, saleId: string): Promise<ReturnEligibility> {
    const sale = await this.loadSale(tenantId, saleId);
    const settings = this.settingsService.getSettings(tenantId).returns;

    const soldAt = sale.completedAt ?? sale.createdAt;
    const daysSinceSale = Math.floor((Date.now() - soldAt.getTime()) / 86_400_000);
    const withinReturnWindow = daysSinceSale <= settings.returnPeriodDays;
    const alreadyFullyReturned = sale.items.every(
      (it) => Number(it.returnedQuantity) >= Number(it.quantity) - QTY_EPSILON,
    );

    const reasons: string[] = [];
    if (sale.status !== 'COMPLETED') reasons.push('The sale is not completed');
    if (alreadyFullyReturned) reasons.push('Every item on this sale has already been returned');

    return {
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      eligible: sale.status === 'COMPLETED' && !alreadyFullyReturned,
      reasons,
      returnPeriodDays: settings.returnPeriodDays,
      withinReturnWindow,
      daysSinceSale,
      alreadyFullyReturned,
      originalPaymentMethods: [...new Set(sale.payments.map((p) => p.method))],
      isCreditCustomer: sale.customer?.customerType === 'CREDIT',
    };
  }

  async getReturnableItems(tenantId: string, saleId: string): Promise<ReturnableItem[]> {
    const sale = await this.loadSale(tenantId, saleId);
    return sale.items.map((it) => {
      const purchased = Number(it.quantity);
      const previously = Number(it.returnedQuantity);
      return {
        saleItemId: it.id,
        productId: it.productId,
        productName: it.productName,
        sku: it.sku,
        imageUrl: null,
        unitPrice: Number(it.unitPrice),
        purchasedQuantity: purchased,
        previouslyReturnedQuantity: previously,
        availableReturnQuantity: round3(Math.max(0, purchased - previously)),
        productDiscount: Number(it.discountAmount),
        lineTotal: Number(it.lineTotal),
      };
    });
  }

  // ── preview ────────────────────────────────────────────────────────────────

  async preview(tenantId: string, actor: AuthenticatedUser, dto: PreviewReturnDto): Promise<ReturnPreview> {
    const sale = await this.loadSale(tenantId, dto.originalSaleId);
    const settings = this.settingsService.getSettings(tenantId);
    const computed = this.computeReturn(sale, dto.items);

    const refundMethod = dto.refundMethod ?? this.suggestRefundMethod(sale);
    const { requiresApproval, reasons } = this.evaluateApproval(
      sale,
      computed,
      refundMethod,
      settings.returns,
      actor.role,
    );

    return {
      originalSaleId: sale.id,
      saleNumber: sale.saleNumber,
      items: computed.previewItems,
      subtotal: computed.totals.subtotal,
      productDiscountAdjustment: computed.totals.productDiscountAdjustment,
      orderDiscountAdjustment: computed.totals.orderDiscountAdjustment,
      taxAdjustment: computed.totals.taxAdjustment,
      refundTotal: computed.totals.refundTotal,
      isFullReturn: computed.isFullReturn,
      requiresApproval,
      approvalReasons: reasons,
      suggestedRefundMethod: this.suggestRefundMethod(sale),
      allowedRefundMethods: this.allowedRefundMethods(settings.returns),
      quickbooksDocumentType: this.resolveQboDocType(sale, refundMethod),
    };
  }

  // ── manager approval (mint token) ──────────────────────────────────────────

  async approve(tenantId: string, dto: ApproveReturnDto): Promise<ReturnApprovalResult> {
    const approver = await this.authService.findUserByPin(tenantId, dto.managerPin);
    if (!approver) {
      throw new UnauthorizedException('Invalid manager PIN');
    }
    if (!roleHasPermission(approver.role, Permission.RETURN_APPROVE)) {
      return {
        approved: false,
        approvedByUserId: approver.id,
        approvalToken: null,
        expiresAt: null,
        reason: 'This user is not allowed to approve returns',
      };
    }

    const payload: ReturnApprovalTokenPayload = {
      typ: 'return-approval',
      tenantId,
      originalSaleId: dto.originalSaleId,
      refundTotal: round2(dto.refundTotal),
      approvedByUserId: approver.id,
      approverRole: approver.role,
    };
    const approvalToken = await this.jwtService.signAsync(payload, { expiresIn: APPROVAL_TOKEN_TTL });

    return {
      approved: true,
      approvedByUserId: approver.id,
      approvalToken,
      expiresAt: new Date(Date.now() + APPROVAL_TOKEN_TTL_MS).toISOString(),
    };
  }

  // ── complete (create the return atomically) ────────────────────────────────

  async complete(
    tenantId: string,
    actor: AuthenticatedUser,
    dto: CreateReturnDto,
    idempotencyKey: string | null,
  ): Promise<ReturnWithRelations> {
    const key = dto.idempotencyKey ?? idempotencyKey;

    // Idempotency: a replay returns the original return instead of a duplicate.
    if (key) {
      const existing = await this.repo.findByIdempotencyKey(tenantId, key);
      if (existing) return existing;
    }

    const sale = await this.loadSale(tenantId, dto.originalSaleId);
    if (sale.status !== 'COMPLETED') {
      throw new BadRequestException('Returns can only be created against a completed sale');
    }

    const settings = this.settingsService.getSettings(tenantId);
    const computed = this.computeReturn(sale, dto.items);
    const refundTotal = computed.totals.refundTotal;
    if (refundTotal <= 0) {
      throw new BadRequestException('Refund total must be greater than zero');
    }

    this.validateRefundMethod(sale, dto.refundMethod, refundTotal, settings.returns);

    // Approval: re-evaluate on the server and require a covering token when needed.
    const { requiresApproval, reasons } = this.evaluateApproval(
      sale,
      computed,
      dto.refundMethod,
      settings.returns,
      actor.role,
    );
    const approvedByUserId = requiresApproval
      ? await this.verifyApprovalToken(tenantId, dto.originalSaleId, refundTotal, dto.approvalToken, reasons)
      : null;

    const quickbooksDocumentType = this.resolveQboDocType(sale, dto.refundMethod);

    let created: ReturnWithRelations;
    try {
      created = await this.repo.createCompleted({
        tenantId,
        branchId: sale.branchId,
        registerId: sale.registerId,
        originalSaleId: sale.id,
        customerId: sale.customerId,
        createdByUserId: actor.id,
        approvedByUserId,
        approvalToken: requiresApproval ? (dto.approvalToken ?? null) : null,
        idempotencyKey: key ?? null,
        notes: dto.notes?.trim() || null,
        subtotal: computed.totals.subtotal,
        productDiscountAdjustment: computed.totals.productDiscountAdjustment,
        orderDiscountAdjustment: computed.totals.orderDiscountAdjustment,
        taxAdjustment: computed.totals.taxAdjustment,
        refundTotal,
        refundMethod: dto.refundMethod,
        refundReference: dto.refundReference?.trim() || null,
        refundMetadata: dto.refundMetadata ?? null,
        quickbooksDocumentType,
        items: computed.persistItems,
      });
    } catch (err) {
      // Unique-key race on idempotency: return the winner instead of failing.
      if (
        key &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.repo.findByIdempotencyKey(tenantId, key);
        if (existing) return existing;
      }
      throw err;
    }

    // Issue the return receipt (best-effort; the return is already committed).
    try {
      await this.issueReceipt(tenantId, created, actor.id);
    } catch (e) {
      this.logger.warn(`Return ${created.returnNumber} receipt generation failed: ${String(e)}`);
    }

    // Re-read so the response carries the freshly-created print job / totals.
    return (await this.repo.findByIdForTenant(tenantId, created.id)) ?? created;
  }

  // ── list / detail ──────────────────────────────────────────────────────────

  async list(tenantId: string, query: QueryReturnsDto): Promise<Paginated<ReturnListItem>> {
    const [rows, total] = await this.repo.findManyByTenant(
      tenantId,
      {
        status: query.status,
        refundStatus: query.refundStatus,
        syncStatus: query.syncStatus,
        refundMethod: query.refundMethod,
        search: query.search?.trim() || undefined,
        originalSaleId: query.originalSaleId,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      query.skip,
      query.take,
    );
    return paginate(rows.map(toReturnListItem), total, query.page, query.pageSize);
  }

  async getById(tenantId: string, id: string): Promise<ReturnWithRelations> {
    const ret = await this.repo.findByIdForTenant(tenantId, id);
    if (!ret) {
      throw new NotFoundException(`Return ${id} not found`);
    }
    return ret;
  }

  /** Returns for a sale — used by the Sale-detail "Returns" section. */
  getReturnsForSale(tenantId: string, saleId: string): Promise<ReturnWithRelations[]> {
    return this.repo.findBySale(tenantId, saleId);
  }

  // ── receipt / retry ──────────────────────────────────────────────────────────

  async generateReceipt(tenantId: string, id: string, userId: string): Promise<{ printJobId: string; html: string }> {
    const ret = await this.getById(tenantId, id);
    return this.issueReceipt(tenantId, ret, userId);
  }

  retrySync(tenantId: string, id: string): Promise<{ id: string; syncStatus: string }> {
    return this.syncQueue.requeueReturn(tenantId, id);
  }

  async cancel(tenantId: string, id: string): Promise<ReturnWithRelations> {
    const ret = await this.getById(tenantId, id);
    if (ret.status === 'COMPLETED') {
      throw new BadRequestException(
        'A completed return cannot be cancelled; issue a corrective transaction instead',
      );
    }
    // Draft / pending-approval returns are not currently persisted, so this is a
    // guard rail for a future server-side draft lifecycle.
    return ret;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async loadSale(tenantId: string, saleId: string): Promise<SaleForReturn> {
    const sale = await this.repo.findSaleForReturn(tenantId, saleId);
    if (!sale) {
      throw new NotFoundException(`Sale ${saleId} not found`);
    }
    return sale;
  }

  /**
   * Validate the selected lines against the sale and recompute every money figure
   * from the original snapshot. This is the authoritative pricing — client amounts
   * are never used.
   */
  private computeReturn(sale: SaleForReturn, inputItems: ReturnItemInputDto[]): ComputedReturn {
    const byId = new Map(sale.items.map((it) => [it.id, it]));
    const seen = new Set<string>();

    // The recorded sale.taxAmount is the authoritative tax the customer paid; the
    // calc allocates that amount proportionally (it is 0 when tax was disabled).
    const saleSnapshot = {
      subtotal: Number(sale.subtotal),
      totalDiscount: Number(sale.totalDiscount),
      orderDiscountAmount: Number(sale.orderDiscountAmount),
      taxAmount: Number(sale.taxAmount),
    };

    const previewItems: ReturnPreviewItem[] = [];
    const persistItems: PersistReturnItem[] = [];
    const computedLines: ComputedReturnLine[] = [];

    for (const input of inputItems) {
      const si = byId.get(input.saleItemId);
      if (!si) {
        throw new BadRequestException(`Sale item ${input.saleItemId} is not on this sale`);
      }
      if (seen.has(input.saleItemId)) {
        throw new BadRequestException(`Sale item ${input.saleItemId} appears twice`);
      }
      seen.add(input.saleItemId);

      const purchased = Number(si.quantity);
      const previously = Number(si.returnedQuantity);
      const available = round3(purchased - previously);
      const qty = round3(input.returnQuantity);

      if (qty <= 0) {
        throw new BadRequestException(`Return quantity for ${si.productName} must be at least 1`);
      }
      if (qty > available + QTY_EPSILON) {
        throw new BadRequestException(
          `Cannot return ${qty} of ${si.productName}; only ${available} available ` +
            `(purchased ${purchased}, already returned ${previously})`,
        );
      }
      if (input.stockDisposition === 'RETURN_TO_STOCK' && NON_RESTOCKABLE.has(input.itemCondition)) {
        throw new BadRequestException(
          `${si.productName}: ${input.itemCondition} items cannot be returned to normal stock`,
        );
      }

      const line = computeReturnLine(
        saleSnapshot,
        {
          unitPrice: Number(si.unitPrice),
          purchasedQuantity: purchased,
          discountAmount: Number(si.discountAmount),
          lineTotal: Number(si.lineTotal),
        },
        qty,
      );
      computedLines.push(line);

      previewItems.push({
        saleItemId: si.id,
        productId: si.productId,
        productName: si.productName,
        sku: si.sku,
        returnQuantity: qty,
        originalUnitPrice: line.originalUnitPrice,
        originalLineSubtotal: line.originalLineSubtotal,
        productDiscountAdjustment: line.productDiscountAdjustment,
        orderDiscountAdjustment: line.orderDiscountAdjustment,
        taxAdjustment: line.taxAdjustment,
        refundableAmount: line.refundableAmount,
        returnReason: input.returnReason,
        itemCondition: input.itemCondition,
        stockDisposition: input.stockDisposition,
      });

      persistItems.push({
        originalSaleItemId: si.id,
        productId: si.productId,
        productNameSnapshot: si.productName,
        skuSnapshot: si.sku,
        imageUrlSnapshot: null,
        originalUnitPrice: line.originalUnitPrice,
        purchasedQuantity: purchased,
        previouslyReturnedQuantity: previously,
        returnQuantity: qty,
        returnReason: input.returnReason,
        itemCondition: input.itemCondition,
        stockDisposition: input.stockDisposition,
        note: input.note?.trim() || null,
        originalLineSubtotal: line.originalLineSubtotal,
        productDiscountAdjustment: line.productDiscountAdjustment,
        orderDiscountAdjustment: line.orderDiscountAdjustment,
        taxAdjustment: line.taxAdjustment,
        refundableAmount: line.refundableAmount,
      });
    }

    const totals = sumReturnTotals(computedLines);

    // A full return returns all remaining quantity of every line on the sale.
    const returnedNow = new Map(persistItems.map((it) => [it.originalSaleItemId, it.returnQuantity]));
    const isFullReturn = sale.items.every((it) => {
      const already = Number(it.returnedQuantity);
      const now = returnedNow.get(it.id) ?? 0;
      return already + now >= Number(it.quantity) - QTY_EPSILON;
    });

    return { previewItems, persistItems, computedLines, totals, isFullReturn };
  }

  private validateRefundMethod(
    sale: SaleForReturn,
    method: PaymentMethod,
    refundTotal: number,
    settings: ReturnType<SettingsService['getSettings']>['returns'],
  ): void {
    if (!this.allowedRefundMethods(settings).includes(method)) {
      throw new BadRequestException(`Refund method ${method} is not allowed`);
    }
    if (method === 'STORE_CREDIT') {
      if (!settings.allowStoreCredit) {
        throw new BadRequestException('Store credit refunds are disabled');
      }
      if (!sale.customerId || sale.customer?.customerType === 'WALK_IN') {
        throw new BadRequestException(
          'Store credit requires a saved customer; convert the walk-in customer first',
        );
      }
    }

    // Rule: total refunds can never exceed what was sold.
    const alreadyRefunded = Number(sale.returnedAmount);
    if (alreadyRefunded + refundTotal > Number(sale.total) + MONEY_EPSILON) {
      throw new BadRequestException('Refund exceeds the remaining value of the sale');
    }

    // Rule: a cash refund cannot exceed the amount actually paid on the sale.
    if (method === 'CASH' && refundTotal > Number(sale.paidAmount) + MONEY_EPSILON) {
      throw new BadRequestException('Cash refund cannot exceed the amount paid on the sale');
    }
  }

  /** Which triggers demand manager approval for this return (spec §6). */
  private evaluateApproval(
    sale: SaleForReturn,
    computed: ComputedReturn,
    refundMethod: PaymentMethod,
    settings: ReturnType<SettingsService['getSettings']>['returns'],
    actorRole: UserRole,
  ): { requiresApproval: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const refundTotal = computed.totals.refundTotal;
    const soldAt = sale.completedAt ?? sale.createdAt;
    const daysSinceSale = Math.floor((Date.now() - soldAt.getTime()) / 86_400_000);
    const originalMethods = new Set(sale.payments.map((p) => p.method));

    if (actorRole === 'CASHIER' && refundTotal > settings.cashierReturnValueLimit) {
      reasons.push(`Refund exceeds the cashier limit (Rs. ${settings.cashierReturnValueLimit})`);
    }
    if (daysSinceSale > settings.returnPeriodDays) {
      reasons.push(`Return is outside the ${settings.returnPeriodDays}-day return period`);
    }
    if (
      settings.requireApprovalForNonGoodCondition &&
      computed.persistItems.some((it) => it.itemCondition !== 'GOOD')
    ) {
      reasons.push('A returned item is damaged, opened, or used');
    }
    if (refundMethod !== 'STORE_CREDIT' && originalMethods.size > 0 && !originalMethods.has(refundMethod)) {
      reasons.push('Refund method differs from the original payment method');
    }
    if (refundMethod === 'CASH' && !originalMethods.has('CASH')) {
      reasons.push('Cash refund requested for a non-cash sale');
    }
    if (computed.isFullReturn) {
      reasons.push('Full-sale return');
    }
    if (sale.customer?.customerType === 'CREDIT') {
      reasons.push('Customer is a credit customer');
    }
    if (
      settings.requireApprovalForOtherReason &&
      computed.persistItems.some((it) => it.returnReason === 'OTHER')
    ) {
      reasons.push('A returned line uses the "Other" reason');
    }

    return { requiresApproval: reasons.length > 0, reasons };
  }

  private async verifyApprovalToken(
    tenantId: string,
    originalSaleId: string,
    refundTotal: number,
    token: string | undefined,
    reasons: string[],
  ): Promise<string> {
    if (!token) {
      throw this.approvalRequired(reasons);
    }
    let payload: ReturnApprovalTokenPayload;
    try {
      payload = this.jwtService.verify<ReturnApprovalTokenPayload>(token);
    } catch {
      throw this.approvalRequired(reasons, 'The approval has expired; ask a manager to approve again');
    }
    const matches =
      payload.typ === 'return-approval' &&
      payload.tenantId === tenantId &&
      payload.originalSaleId === originalSaleId &&
      Math.abs(Number(payload.refundTotal) - refundTotal) <= MONEY_EPSILON;
    if (!matches || !roleHasPermission(payload.approverRole, Permission.RETURN_APPROVE)) {
      throw this.approvalRequired(reasons, 'The approval does not match this return');
    }
    return payload.approvedByUserId;
  }

  private approvalRequired(reasons: string[], message?: string): ForbiddenException {
    return new ForbiddenException({
      error: 'ReturnApprovalRequired',
      message: message ?? 'This return requires manager approval',
      requiresApproval: true,
      reasons,
    });
  }

  private async issueReceipt(
    tenantId: string,
    ret: ReturnWithRelations,
    userId: string,
  ): Promise<{ printJobId: string; html: string }> {
    const settings = this.settingsService.getSettings(tenantId);
    const html = renderReturnReceipt(
      this.toReceiptData(ret, settings.receiptFooter, safeTimeZone(settings.timezone)),
    );
    const job = await this.repo.createReceiptPrintJob({
      tenantId,
      saleId: ret.originalSaleId,
      returnId: ret.id,
      html,
      createdByUserId: userId,
    });
    return { printJobId: job.id, html };
  }

  private toReceiptData(ret: ReturnWithRelations, footer: string, tz: string): ReturnReceiptData {
    const documentTypeLabel =
      ret.quickbooksDocumentType === 'CREDIT_MEMO' ? 'Credit Memo' : 'Refund Receipt';
    const remaining = round2(Number(ret.originalSale.total) - Number(ret.originalSale.returnedAmount));
    return {
      storeName: ret.tenant.name,
      branchName: ret.branch?.name ?? null,
      registerName: ret.register?.name ?? null,
      returnNumber: ret.returnNumber,
      originalSaleNumber: ret.originalSale.saleNumber,
      dateTime: formatReceiptDateTime(ret.completedAt ?? ret.createdAt, tz),
      documentType: documentTypeLabel,
      customerName: ret.customer?.name ?? null,
      cashierName: ret.createdBy?.name ?? null,
      approverName: ret.approvedBy?.name ?? null,
      items: ret.items.map((it) => ({
        name: it.productNameSnapshot,
        sku: it.skuSnapshot,
        quantity: Number(it.returnQuantity),
        unitPrice: Number(it.originalUnitPrice),
        discountAdjustment: Number(it.productDiscountAdjustment) + Number(it.orderDiscountAdjustment),
        refundableAmount: Number(it.refundableAmount),
        reason: humanize(it.returnReason),
        condition: humanize(it.itemCondition),
      })),
      subtotal: Number(ret.subtotal),
      productDiscountAdjustment: Number(ret.productDiscountAdjustment),
      orderDiscountAdjustment: Number(ret.orderDiscountAdjustment),
      taxAdjustment: Number(ret.taxAdjustment),
      refundTotal: Number(ret.refundTotal),
      refundMethod: humanize(ret.refundMethod ?? ''),
      refundReference: ret.refundReference,
      remainingSaleValue: remaining,
      syncStatus: ret.syncStatus,
      footer,
    };
  }

  private suggestRefundMethod(sale: SaleForReturn): PaymentMethod {
    return sale.payments[0]?.method ?? 'CASH';
  }

  private allowedRefundMethods(
    settings: ReturnType<SettingsService['getSettings']>['returns'],
  ): PaymentMethod[] {
    const valid = new Set<string>(Object.values(PaymentMethodValues));
    return settings.allowedRefundMethods
      .filter((m) => valid.has(m))
      .filter((m) => settings.allowStoreCredit || m !== 'STORE_CREDIT') as PaymentMethod[];
  }

  private resolveQboDocType(sale: SaleForReturn, refundMethod: PaymentMethod): QuickBooksReturnDocumentType {
    // Store / customer credit is always a Credit Memo; a fully-paid sale refunded
    // by cash/card/bank is a Refund Receipt; credit / partial sales are Credit Memos.
    if (refundMethod === 'STORE_CREDIT') return 'CREDIT_MEMO';
    return sale.paymentStatus === 'PAID' ? 'REFUND_RECEIPT' : 'CREDIT_MEMO';
  }
}

/** PaymentMethod enum values as a plain object (Prisma enums are type-only at runtime). */
const PaymentMethodValues = {
  CASH: 'CASH',
  CARD: 'CARD',
  BANK_TRANSFER: 'BANK_TRANSFER',
  QR_PAYMENT: 'QR_PAYMENT',
  CHECK: 'CHECK',
  STORE_CREDIT: 'STORE_CREDIT',
  OTHER: 'OTHER',
} as const;

function toReturnListItem(row: ReturnListRow): ReturnListItem {
  return {
    id: row.id,
    returnNumber: row.returnNumber,
    originalSaleId: row.originalSaleId,
    originalSaleNumber: row.originalSale.saleNumber,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    customerName: row.customer?.name ?? null,
    cashierName: row.createdBy?.name ?? null,
    itemCount: row._count.items,
    refundTotal: Number(row.refundTotal),
    refundMethod: row.refundMethod,
    status: row.status,
    refundStatus: row.refundStatus,
    syncStatus: row.syncStatus,
  };
}

/** Turn an enum value (WRONG_PRODUCT) into a label (Wrong product). */
function humanize(value: string): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Round a quantity to 3 decimal places (Decimal(12,3)). */
function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
