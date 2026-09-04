import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DiscountType, PaymentStatus, QuickBooksDocumentType } from '@hardware-pos/database';
import { CURRENCY_SYMBOL, type Paginated } from '@hardware-pos/shared';

import { paginate } from '../../common/pagination';
import { round2, sum2 } from '../../common/money';
import { AuthenticatedUser } from '../auth/auth.types';
import { DiscountsService, ORDER_DISCOUNT_KEY } from '../discounts/discounts.service';
import { CreditService } from '../credit/credit.service';
import { SettingsService } from '../settings/settings.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { QuerySalesDto } from './dto/query-sales.dto';
import { SaleItemInputDto } from './dto/sale-item.dto';
import { resolvePaymentDueDate, resolveSaleDate } from './sale-date';
import { SaleListRow, SaleWithRelations, SalesRepository } from './sales.repository';
import {
  CartItemInput,
  ComputedSale,
  OrderDiscountInput,
  PersistSaleInput,
  SaleListItem,
} from './sales.types';

@Injectable()
export class SalesService {
  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly settingsService: SettingsService,
    private readonly discountsService: DiscountsService,
    private readonly credit: CreditService,
  ) {}

  async list(tenantId: string, query: QuerySalesDto): Promise<Paginated<SaleListItem>> {
    const [rows, total] = await this.salesRepository.findManyByTenant(
      tenantId,
      {
        syncStatus: query.syncStatus,
        paymentStatus: query.paymentStatus,
        search: query.search?.trim() || undefined,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        // "Past due" means the shop's day has moved on from the due date. The
        // due date itself sits at end of day, so today's dues are not yet late.
        overdueAsOf: query.overdue === 'true' ? new Date() : undefined,
      },
      query.skip,
      query.take,
    );
    return paginate(rows.map(toSaleListItem), total, query.page, query.pageSize);
  }

  async getById(tenantId: string, id: string): Promise<SaleWithRelations> {
    const sale = await this.salesRepository.findByIdForTenant(tenantId, id);
    if (!sale) {
      throw new NotFoundException(`Sale ${id} not found`);
    }
    return sale;
  }

  /** Create a DRAFT sale from a cart (totals computed, nothing charged). */
  async createDraft(
    tenantId: string,
    actor: AuthenticatedUser,
    dto: CreateDraftDto,
  ): Promise<SaleWithRelations> {
    await this.assertLocations(tenantId, dto.branchId, dto.registerId, dto.customerId);
    const computed = await this.computeCart(tenantId, actor, dto.items.map(toCartItem));
    return this.salesRepository.createDraft({
      tenantId,
      cashierId: actor.id,
      branchId: dto.branchId,
      registerId: dto.registerId,
      customerId: dto.customerId,
      computed,
    });
  }

  /**
   * Complete a sale (12-step pipeline): validate cart & prices, check stock,
   * compute totals/discounts/tax, then persist the sale, items, payments, and an
   * outbound QuickBooks sync job. Works one-shot (cart in body) or by finishing a
   * draft (`saleId`). Supports full / partial / credit payment.
   */
  async complete(
    tenantId: string,
    actor: AuthenticatedUser,
    dto: CompleteSaleDto,
  ): Promise<SaleWithRelations> {
    let items: CartItemInput[];
    let branchId: string;
    let registerId: string | null | undefined;
    let customerId: string | null | undefined;

    if (dto.saleId) {
      const draft = await this.salesRepository.findDraftWithItems(tenantId, dto.saleId);
      if (!draft) {
        throw new NotFoundException(`Draft sale ${dto.saleId} not found`);
      }
      items = draft.items.map((it) => ({
        productId: it.productId,
        quantity: Number(it.quantity),
        discountType: it.discountType,
        discountValue: it.discountValue != null ? Number(it.discountValue) : null,
        discountReason: it.discountReason,
        approvedByUserId: it.approvedByUserId,
      }));
      branchId = draft.branchId;
      registerId = draft.registerId;
      customerId = dto.customerId ?? draft.customerId;
    } else {
      // DTO validation guarantees branchId + items when saleId is absent.
      items = (dto.items ?? []).map(toCartItem);
      branchId = dto.branchId as string;
      registerId = dto.registerId;
      customerId = dto.customerId;
    }

    // Resolved before any pricing work so a future date fails fast. Anchored in
    // the shop's timezone, which is the zone the resulting invoice prints in.
    const saleDate = resolveSaleDate(
      dto.saleDate,
      this.settingsService.getSettings(tenantId).timezone,
    );

    await this.assertLocations(tenantId, branchId, registerId, customerId);

    const orderDiscountInput: OrderDiscountInput = {
      type: dto.orderDiscountType,
      value: dto.orderDiscountValue,
      reason: dto.orderDiscountReason,
      approvalToken: dto.orderApprovalToken,
    };
    const computed = await this.computeCart(tenantId, actor, items, orderDiscountInput);
    const paidAmount = sum2(dto.payments.map((p) => p.amount));
    const { total } = computed;
    const paymentStatus: PaymentStatus =
      paidAmount <= 0 ? 'UNPAID' : paidAmount >= total ? 'PAID' : 'PARTIAL';
    const balanceAmount = Math.max(0, round2(total - paidAmount));
    const quickbooksDocumentType: QuickBooksDocumentType =
      paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE';

    if (quickbooksDocumentType === 'INVOICE' && !customerId) {
      throw new BadRequestException('A customer is required for a credit/partial sale (Invoice)');
    }

    // After the customer check, so a credit sale with no customer is told the
    // more fundamental thing first. Resolved once the balance is known: whether
    // a due date is required, and whether one is even allowed, both depend on
    // the sale leaving money owed.
    const paymentDueDate = resolvePaymentDueDate(dto.paymentDueDate, {
      leavesBalance: balanceAmount > 0,
      saleDate,
      tz: this.settingsService.getSettings(tenantId).timezone,
    });

    // A sale that leaves a balance is credit — the customer must be allowed
    // credit and stay within their limit (including what they already owe).
    if (balanceAmount > 0 && customerId) {
      await this.assertWithinCreditLimit(tenantId, customerId, balanceAmount);
    }

    const persist: PersistSaleInput = {
      tenantId,
      cashierId: actor.id,
      branchId,
      registerId,
      customerId,
      saleDate,
      paymentDueDate,
      computed,
      payments: dto.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        reference: p.reference,
      })),
      paidAmount,
      balanceAmount,
      paymentStatus,
      quickbooksDocumentType,
    };

    return dto.saleId
      ? this.salesRepository.completeDraft(tenantId, dto.saleId, persist)
      : this.salesRepository.createCompleted(persist);
  }

  /** MOCK QuickBooks push for a completed sale (real QBO integration comes later). */
  async syncToQuickBooks(tenantId: string, id: string): Promise<SaleWithRelations> {
    const sale = await this.salesRepository.findByIdForTenant(tenantId, id);
    if (!sale) {
      throw new NotFoundException(`Sale ${id} not found`);
    }
    if (sale.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed sales can be synced to QuickBooks');
    }
    return this.salesRepository.markSynced(sale);
  }

  // ── compute pipeline ───────────────────────────────────────────────────────

  private async computeCart(
    tenantId: string,
    actor: AuthenticatedUser,
    items: CartItemInput[],
    orderDiscountInput?: OrderDiscountInput,
  ): Promise<ComputedSale> {
    if (items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await this.salesRepository.findProductsByIds(tenantId, ids);
    const byId = new Map(products.map((p) => [p.id, p]));
    const settings = this.settingsService.getSettings(tenantId);

    const lines = await Promise.all(
      items.map(async (item) => {
        const product = byId.get(item.productId);
        if (!product) {
          throw new BadRequestException(`Unknown product ${item.productId}`);
        }
        if (!product.isActive) {
          throw new BadRequestException(`Product ${product.name} is inactive`);
        }
        const cachedPrice = Number(product.unitPrice);
        if (item.unitPrice != null && round2(item.unitPrice) !== round2(cachedPrice)) {
          throw new BadRequestException(
            `Price for ${product.name} has changed; refresh the product cache`,
          );
        }

        const quantity = item.quantity;
        const onHand = Number(product.quantityOnHand);
        if (product.type === 'Inventory' && quantity > onHand) {
          throw new BadRequestException(
            `Insufficient stock for ${product.name} (on hand ${onHand}, requested ${quantity})`,
          );
        }

        const lineSubtotal = round2(cachedPrice * quantity);
        const discountAmount = computeDiscount(lineSubtotal, item.discountType, item.discountValue);
        const effectivePercent = lineSubtotal > 0 ? (discountAmount / lineSubtotal) * 100 : 0;

        // Enforce the role-based discount limit; over-limit lines need a covering
        // approval token (one-shot) or a previously-recorded approver (draft).
        const approvedByUserId =
          discountAmount > 0 && item.discountType && item.discountValue
            ? await this.discountsService.resolveApproval({
                tenantId,
                actorRole: actor.role,
                productId: product.id,
                discountType: item.discountType,
                discountValue: item.discountValue,
                effectivePercent,
                approvalToken: item.approvalToken,
                existingApproverId: item.approvedByUserId,
              })
            : null;

        return {
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          trackInventory: product.type === 'Inventory',
          unitPrice: cachedPrice,
          quantity,
          discountType: item.discountType ?? null,
          discountValue: item.discountValue ?? null,
          discountAmount,
          discountReason: item.discountReason ?? null,
          approvedByUserId,
          taxAmount: 0,
          lineSubtotal,
          lineTotal: round2(lineSubtotal - discountAmount),
        };
      }),
    );

    const subtotal = sum2(lines.map((l) => l.lineSubtotal));
    const totalDiscount = sum2(lines.map((l) => l.discountAmount));
    // Order-level discount applies to the subtotal AFTER per-line discounts.
    const discountedSubtotal = round2(subtotal - totalDiscount);
    const orderDiscount = await this.resolveOrderDiscount(
      tenantId,
      actor,
      discountedSubtotal,
      orderDiscountInput,
    );

    const taxable = round2(discountedSubtotal - orderDiscount.amount);
    const taxAmount = settings.taxRatePercent > 0 ? round2((taxable * settings.taxRatePercent) / 100) : 0;
    const total = round2(taxable + taxAmount);

    return {
      lines,
      subtotal,
      totalDiscount,
      orderDiscountType: orderDiscount.type,
      orderDiscountValue: orderDiscount.value,
      orderDiscountAmount: orderDiscount.amount,
      orderDiscountReason: orderDiscount.reason,
      orderDiscountApprovedById: orderDiscount.approvedById,
      taxAmount,
      total,
    };
  }

  /**
   * Compute the order-level discount against the post-line-discount subtotal and
   * enforce the role limit (over-limit needs a covering manager approval token).
   */
  private async resolveOrderDiscount(
    tenantId: string,
    actor: AuthenticatedUser,
    base: number,
    input?: OrderDiscountInput,
  ): Promise<{
    type: DiscountType | null;
    value: number | null;
    amount: number;
    reason: string | null;
    approvedById: string | null;
  }> {
    const type = input?.type ?? null;
    const value = input?.value ?? null;
    if (!type || value == null || value <= 0 || base <= 0) {
      return { type: null, value: null, amount: 0, reason: null, approvedById: null };
    }

    const amount = computeDiscount(base, type, value);
    const effectivePercent = base > 0 ? (amount / base) * 100 : 0;
    const approvedById = await this.discountsService.resolveApproval({
      tenantId,
      actorRole: actor.role,
      productId: ORDER_DISCOUNT_KEY,
      discountType: type,
      discountValue: value,
      effectivePercent,
      approvalToken: input?.approvalToken,
      existingApproverId: input?.approvedById,
    });

    return { type, value, amount, reason: input?.reason?.trim() || null, approvedById };
  }

  private async assertLocations(
    tenantId: string,
    branchId: string,
    registerId?: string | null,
    customerId?: string | null,
  ): Promise<void> {
    if (!(await this.salesRepository.branchExists(tenantId, branchId))) {
      throw new BadRequestException(`Unknown branch ${branchId}`);
    }
    if (registerId && !(await this.salesRepository.registerExists(tenantId, registerId))) {
      throw new BadRequestException(`Unknown register ${registerId}`);
    }
    if (customerId && !(await this.salesRepository.customerExists(tenantId, customerId))) {
      throw new BadRequestException(`Unknown customer ${customerId}`);
    }
  }

  /**
   * Enforce a customer's credit terms for a sale that leaves `newBalance`
   * outstanding: they must be allowed credit, and (when a limit is set) their
   * existing outstanding balance plus this sale must not exceed it. A null
   * limit with credit allowed means unlimited.
   */
  private async assertWithinCreditLimit(
    tenantId: string,
    customerId: string,
    newBalance: number,
  ): Promise<void> {
    const credit = await this.credit.forCustomer(tenantId, customerId);
    if (!credit) return; // existence already validated by assertLocations

    if (!credit.creditAllowed) {
      throw new BadRequestException(
        'This customer is not approved for credit. Take full payment to complete the sale.',
      );
    }

    if (credit.creditLimit != null) {
      const projected = round2(credit.outstanding + newBalance);
      if (projected > credit.creditLimit) {
        const available = Math.max(0, credit.available ?? 0);
        throw new BadRequestException(
          `Credit limit exceeded. Limit ${CURRENCY_SYMBOL} ${credit.creditLimit.toFixed(2)}, ` +
            `already outstanding ${CURRENCY_SYMBOL} ${credit.outstanding.toFixed(2)}, ` +
            `so only ${CURRENCY_SYMBOL} ${available.toFixed(2)} of credit is available for this sale ` +
            `(this sale needs ${CURRENCY_SYMBOL} ${round2(newBalance).toFixed(2)}).`,
        );
      }
    }
  }
}

export function toSaleListItem(row: SaleListRow): SaleListItem {
  return {
    id: row.id,
    saleNumber: row.saleNumber,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    customerName: row.customer?.name ?? null,
    cashierName: row.cashier?.name ?? null,
    itemCount: row._count.items,
    subtotal: Number(row.subtotal),
    totalDiscount: Number(row.totalDiscount),
    orderDiscountAmount: Number(row.orderDiscountAmount),
    taxAmount: Number(row.taxAmount),
    total: Number(row.total),
    paidAmount: Number(row.paidAmount),
    balanceAmount: Number(row.balanceAmount),
    paymentStatus: row.paymentStatus,
    paymentMethods: [...new Set(row.payments.map((p) => p.method))],
    paymentDueDate: row.paymentDueDate,
    // Set when the customer's account was cleared, covering this invoice. The
    // list reads it as "Paid" without the invoice's own figures being rewritten.
    creditSettledAt: row.creditSettledAt,
    // Derived from the payments already joined for the method chips, so the list
    // needs no extra query and no denormalised column to keep in step.
    lastPaymentAt: row.payments.reduce<Date | null>(
      (latest, p) => (latest === null || p.createdAt > latest ? p.createdAt : latest),
      null,
    ),
    returnStatus: row.returnStatus,
    returnedAmount: Number(row.returnedAmount),
    quickbooksDocumentType: row.quickbooksDocumentType,
    syncStatus: row.syncStatus,
  };
}

function toCartItem(dto: SaleItemInputDto): CartItemInput {
  return {
    productId: dto.productId,
    quantity: dto.quantity,
    unitPrice: dto.unitPrice,
    discountType: dto.discountType,
    discountValue: dto.discountValue,
    discountReason: dto.discountReason,
    approvalToken: dto.approvalToken,
  };
}

function computeDiscount(
  lineSubtotal: number,
  type: DiscountType | null | undefined,
  value: number | null | undefined,
): number {
  if (!type || value == null || value <= 0) {
    return 0;
  }
  if (type === 'PERCENTAGE') {
    return Math.min(lineSubtotal, round2((lineSubtotal * value) / 100));
  }
  return Math.min(lineSubtotal, round2(value));
}
