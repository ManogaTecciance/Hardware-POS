import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PaymentMethod, Prisma, UserRole } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { round2 } from '../../common/money';
import { paginate } from '../../common/pagination';
import { AuthenticatedUser } from '../auth/auth.types';
import { AuthService } from '../auth/auth.service';
import { Permission, roleHasPermission } from '../auth/permissions';
import { AccountingProviderFactory } from '../providers/accounting/accounting-provider.factory';
import { InventoryProviderFactory } from '../providers/inventory/inventory-provider.factory';
import { AccountingProvider } from '../providers/accounting/accounting-provider';
import { ProviderOperationUnavailableError } from '../providers/provider.errors';
import { StockLine } from '../providers/provider.types';
import { SettingsService } from '../settings/settings.service';
import { SyncQueueService } from '../sync/queue/sync-queue.service';
import {
  customerReturnDocumentLabel,
  resolveCustomerReturnDocumentKind,
} from './customer-return-document';
import { computeReturnLine, sumReturnTotals, type ComputedReturnLine } from './returns.calc';
import {
  PostReturnAccounting,
  RestoreStock,
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
    private readonly accountingProviders: AccountingProviderFactory,
    private readonly inventoryProviders: InventoryProviderFactory,
  ) {}

  /**
   * The accounting provider that owns this sale's financial record.
   *
   * Resolved from the sale's own stored evidence, never from the tenant's current
   * `TenantBusinessProfile`: a return has to reverse the entry where the sale was
   * actually filed. A tenant that moved from QuickBooks to NONE still has sales in
   * QuickBooks that must be credited there, and a tenant that moved the other way
   * must not have credit notes pushed for sales QuickBooks never recorded.
   */
  private accountingFor(sale: SaleForReturn): AccountingProvider {
    return this.accountingProviders.forSale(sale);
  }

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
    /*
     * D58: a projected restaurant line may carry no productId (a legacy
     * MenuItem sale). Restaurant returns are explicitly deferred — the
     * RETURNS module is not in the food-service set — so a productless line
     * is not returnable here rather than half-returnable. Retail lines
     * always carry a product; this filters nothing for them.
     */
    return sale.items
      .filter((it): it is (typeof it) & { productId: string } => it.productId !== null)
      .map((it) => {
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

    // The same provider the completion will use, resolved from the same evidence,
    // so a preview can never advertise a document the completion will not produce.
    const accounting = this.accountingFor(sale);

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
      quickbooksDocumentType: accounting.resolveReturnDocumentType({
        originalPaymentStatus: sale.paymentStatus,
        refundMethod,
      }).documentType,
      documentKind: resolveCustomerReturnDocumentKind({
        refundMethod,
        originalPaymentStatus: sale.paymentStatus,
      }),
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

    // One provider for the whole operation: the document decision below and the
    // submission inside the transaction come from the same resolved instance, so
    // they cannot disagree.
    const accounting = this.accountingFor(sale);
    const quickbooksDocumentType = accounting.resolveReturnDocumentType({
      originalPaymentStatus: sale.paymentStatus,
      refundMethod: dto.refundMethod,
    }).documentType;

    const postAccounting: PostReturnAccounting = (tx, returnId) =>
      accounting.postReturn(
        tx,
        { tenantId, branchId: sale.branchId },
        returnId,
        quickbooksDocumentType,
      );

    // Inventory is resolved from the tenant's CURRENT mode, not from the sale's
    // accounting provenance. Inventory authority and accounting provenance are
    // separate concepts (D29), and there is no per-sale inventory provenance to
    // read — which is safe only because `BusinessProfileService` now refuses to
    // change `inventoryMode` once stock has moved.
    const inventory = await this.inventoryProviders.forTenant(tenantId);
    const restockLines = eligibleRestockLines(computed.persistItems);
    const restoreStock: RestoreStock = (tx, lines, returnId) =>
      inventory.restoreStock(tx, { tenantId, branchId: sale.branchId }, lines, {
        // 1a.21 — the counterpart of the SALE row. `lines` has already been
        // filtered to those that actually restock, so a DAMAGED item that is
        // refunded but not resold produces no ledger entry, which is correct: no
        // stock moved.
        reason: 'RETURN',
        refType: 'RETURN',
        refId: returnId,
        createdByUserId: actor.id,
      });

    let created: ReturnWithRelations;
    try {
      created = await this.repo.createCompleted(
        {
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
          restockLines,
          // No external document means nothing is pending. Leaving this `PENDING`
          // would show a QuickBooks push that is never going to happen, and would
          // leave the return permanently "waiting for QuickBooks".
          syncStatus: quickbooksDocumentType === null ? 'NOT_SYNCED' : 'PENDING',
          items: computed.persistItems,
        },
        postAccounting,
        restoreStock,
      );
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

  /**
   * Re-queue a failed external push.
   *
   * Gated on the return's own provenance rather than the tenant's current profile.
   * A return with no external accounting document has nothing to retry: there is
   * no `SyncJob` to requeue and no external system that ever received it, so this
   * refuses instead of producing a confusing "no sync job found" from the queue.
   */
  async retrySync(tenantId: string, id: string): Promise<{ id: string; syncStatus: string }> {
    const ret = await this.getById(tenantId, id);
    const accounting = this.accountingProviders.forReturn(ret);
    if (accounting.provider !== 'QUICKBOOKS') {
      throw new ProviderOperationUnavailableError(accounting.name, 'retrying an external sync');
    }
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
    /*
     * D101 (3.11) — the weight that allocates the sale's recorded tax.
     *
     * Σ over EVERY sale line of `lineTaxable × rate`, where `lineTaxable` is the
     * line net less its proportional share of the order discount — the same
     * quantity `computeReturnLine` derives, so numerator and denominator are
     * built the same way and the shares provably sum to 1.
     *
     * Computed over ALL lines, not just the ones being returned: a share must
     * mean the same thing whether the customer brings back one item or every
     * item, which is what makes a sequence of partial returns reconcile.
     *
     * Null when the sale predates 3.8 — one line without a rate makes the whole
     * weight unusable, which is correct: those sales fall back wholesale to the
     * proportional method they were refunded by before.
     */
    const discountedSubtotalAll = Number(sale.subtotal) - Number(sale.totalDiscount);
    const anyLineMissingRate = sale.items.some((it) => it.taxRatePercent === null);
    const taxWeightTotal = anyLineMissingRate
      ? null
      : sale.items.reduce((acc, it) => {
          const lineTotal = Number(it.lineTotal);
          const orderDiscountShare =
            discountedSubtotalAll > 0
              ? (Number(sale.orderDiscountAmount) * lineTotal) / discountedSubtotalAll
              : 0;
          return acc + (lineTotal - orderDiscountShare) * Number(it.taxRatePercent);
        }, 0);

    const saleSnapshot = {
      subtotal: Number(sale.subtotal),
      totalDiscount: Number(sale.totalDiscount),
      orderDiscountAmount: Number(sale.orderDiscountAmount),
      taxAmount: Number(sale.taxAmount),
      taxWeightTotal,
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
      /*
       * D58: a projected restaurant line may have no product. Restaurant
       * returns are deferred (the RETURNS module is not in the food-service
       * set), so such a line is refused loudly rather than returned without a
       * stock identity. Retail lines always carry a product.
       */
      const productId = si.productId;
      if (productId === null) {
        throw new BadRequestException(
          `${si.productName} was sold without a product reference and cannot be returned here`,
        );
      }

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
          // Null means this line predates 3.8 — the fallback signal.
          taxRatePercent: si.taxRatePercent === null ? null : Number(si.taxRatePercent),
        },
        qty,
      );
      computedLines.push(line);

      previewItems.push({
        saleItemId: si.id,
        productId,
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
        productId,
        // D99 (1a.20) — the variant comes from the SALE, never from the caller.
        // `ReturnItemInputDto` names a `saleItemId`, so the server already holds
        // the historical record; a client cannot restock a size other than the
        // one that was sold, because it is never asked which.
        productVariantId: si.productVariantId,
        productNameSnapshot: si.productName,
        skuSnapshot: si.sku,
        // D44 — copied, not re-derived. The sale froze these at sale time; a
        // rename since must not change what the return says came back.
        variantSkuSnapshot: si.variantSkuSnapshot,
        variantNameSnapshot: si.variantNameSnapshot,
        // D101 (3.11) — the rate REVERSED, copied from the sale line for the
        // same reason: a rate change between purchase and return must not alter
        // the refund, and a credit note should be self-contained.
        taxRatePercent: si.taxRatePercent === null ? null : Number(si.taxRatePercent),
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
    const html = renderReturnReceipt(this.toReceiptData(ret, settings.receiptFooter));
    const job = await this.repo.createReceiptPrintJob({
      tenantId,
      saleId: ret.originalSaleId,
      returnId: ret.id,
      html,
      createdByUserId: userId,
    });
    return { printJobId: job.id, html };
  }

  private toReceiptData(ret: ReturnWithRelations, footer: string): ReturnReceiptData {
    // `quickbooksDocumentType` is external-integration metadata and is null for a
    // tenant with no accounting provider. The two explicit branches keep today's
    // QuickBooks wording byte-identical — a QuickBooks return always has a document
    // type, so its label never comes from the local resolver. The fallback is the
    // Slice 6B local decision, so a null never silently prints "Refund Receipt" on
    // a return where no money moved.
    const documentTypeLabel =
      ret.quickbooksDocumentType === 'CREDIT_MEMO'
        ? 'Credit Memo'
        : ret.quickbooksDocumentType === 'REFUND_RECEIPT'
          ? 'Refund Receipt'
          : customerReturnDocumentLabel(
              resolveCustomerReturnDocumentKind({
                refundMethod: ret.refundMethod,
                originalPaymentStatus: ret.originalSale.paymentStatus,
              }),
            );
    const remaining = round2(Number(ret.originalSale.total) - Number(ret.originalSale.returnedAmount));
    return {
      storeName: ret.tenant.name,
      branchName: ret.branch?.name ?? null,
      registerName: ret.register?.name ?? null,
      returnNumber: ret.returnNumber,
      originalSaleNumber: ret.originalSale.saleNumber,
      dateTime: (ret.completedAt ?? ret.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
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
      // The template prints a "QuickBooks · <status>" row whenever this is set, on
      // a CUSTOMER-facing receipt. Suppress it for a tenant with no accounting
      // provider — telling a customer their refund is "QuickBooks NOT_SYNCED" is
      // wrong for a tenant that does not use QuickBooks at all. A tenant that does
      // always has a document type, so their receipt is unchanged.
      syncStatus: ret.quickbooksDocumentType === null ? null : ret.syncStatus,
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

  // `resolveQboDocType` used to live here. Its rule — STORE_CREDIT → CREDIT_MEMO,
  // otherwise a fully-paid sale → REFUND_RECEIPT and anything else → CREDIT_MEMO —
  // now lives in `QuickBooksAccountingProvider.resolveReturnDocumentType`,
  // unchanged. It was moved rather than rewritten, and
  // `return-accounting-adoption.spec.ts` pins the two against each other across
  // every payment-status × refund-method pair.
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
    quickbooksDocumentType: row.quickbooksDocumentType,
    documentKind: resolveCustomerReturnDocumentKind({
      refundMethod: row.refundMethod,
      originalPaymentStatus: row.originalSale.paymentStatus,
    }),
  };
}

/**
 * Which returned lines re-enter available stock.
 *
 * The rule is unchanged from `returns.repository`: only GOOD items marked
 * RETURN_TO_STOCK. Damaged, opened, defective and non-resellable stock never
 * restocks whatever the disposition says.
 *
 * `trackInventory: true` on every eligible line is deliberate and preserves
 * today's behaviour exactly. The old code did not know a product's type either —
 * it relied on `type: 'Inventory'` in the update predicate to make a Service
 * product silently restock nothing, and both stock-tracking providers carry that
 * same predicate. Deciding it here instead would need an extra product read and
 * would move a rule that is already enforced correctly one layer down.
 */
function eligibleRestockLines(items: PersistReturnItem[]): StockLine[] {
  return items
    .filter((it) => it.itemCondition === 'GOOD' && it.stockDisposition === 'RETURN_TO_STOCK')
    .map((it) => ({
      productId: it.productId,
      // D99 (1a.20) — threaded now that 1c.7 lets a sale record a variant.
      // Hardcoding null here meant a returned Medium credited the customer,
      // bumped the product total, and never went back on the shelf: the variant
      // row stayed down and the D10 mirror drifted up with every return.
      productVariantId: it.productVariantId,
      productName: it.productNameSnapshot,
      quantity: Number(it.returnQuantity),
      trackInventory: true,
    }));
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
