import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma,
  AccountingProviderKind,
  DiscountType,
  PaymentStatus,
  QuickBooksDocumentType,
} from '@hardware-pos/database';
import { CURRENCY_SYMBOL, type Paginated } from '@hardware-pos/shared';

import { paginate } from '../../common/pagination';
import { round2, sum2 } from '../../common/money';
import { computeDocumentLine } from '../../common/money/document-totals';
import { variantDisplayName } from '../../common/variant-display';
import { AuthenticatedUser } from '../auth/auth.types';
import { DiscountsService, ORDER_DISCOUNT_KEY } from '../discounts/discounts.service';
import { AccountingProviderFactory } from '../providers/accounting/accounting-provider.factory';
import { InventoryProviderFactory } from '../providers/inventory/inventory-provider.factory';
import { InventoryProvider } from '../providers/inventory/inventory-provider';
import { ProviderOperationUnavailableError } from '../providers/provider.errors';
import { SettingsService } from '../settings/settings.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { QuerySalesDto } from './dto/query-sales.dto';
import { SaleItemInputDto } from './dto/sale-item.dto';
import { resolveCustomerDocumentKind } from './customer-document';
import {
  ExternalSaleDocument,
  PostAccounting,
  ReduceStock,
  SaleListRow,
  SaleWithRelations,
  SalesRepository,
} from './sales.repository';
import {
  CartItemInput,
  ComputedSale,
  OrderDiscountInput,
  PersistSaleInput,
  SaleListItem,
} from './sales.types';

/** D58 — see the draft-completion mapping below. */
function requireProductId(productId: string | null, saleItemId: string): string {
  if (productId === null) {
    throw new Error(`Draft sale item ${saleItemId} has no productId — refusing to complete`);
  }
  return productId;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly settingsService: SettingsService,
    private readonly discountsService: DiscountsService,
    private readonly accountingProviders: AccountingProviderFactory,
    private readonly inventoryProviders: InventoryProviderFactory,
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
    // A draft moves no stock, but it must not be built against availability the
    // tenant's provider cannot vouch for — an EXTERNAL tenant fails closed here
    // rather than at completion.
    const inventory = await this.inventoryProviders.forTenant(tenantId);
    const computed = await this.computeCart(
      tenantId,
      actor,
      dto.items.map(toCartItem),
      inventory,
      dto.branchId,
    );
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
        // D58: nullable only for PROJECTED restaurant lines. A retail draft's
        // lines were written by this module with a product, so a null here is
        // corruption, not a state — fail the completion rather than sell air.
        productId: requireProductId(it.productId, it.id),
        // D99 — a draft line already carries the variant chosen when the draft was
        // built; completing it must sell the same one, not fall back to product level.
        productVariantId: it.productVariantId,
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

    await this.assertLocations(tenantId, branchId, registerId, customerId);

    const orderDiscountInput: OrderDiscountInput = {
      type: dto.orderDiscountType,
      value: dto.orderDiscountValue,
      reason: dto.orderDiscountReason,
      approvalToken: dto.orderApprovalToken,
    };
    // Resolve BOTH providers once, from the authenticated tenant, before any work.
    // Independent of each other by design: inventory authority and accounting
    // destination are separate concepts (D29), and a tenant may legitimately keep
    // stock locally while filing documents in QuickBooks. Neither is derived from
    // the other, and no DTO field can name either.
    const inventory = await this.inventoryProviders.forTenant(tenantId);

    const computed = await this.computeCart(
      tenantId,
      actor,
      items,
      inventory,
      branchId,
      orderDiscountInput,
    );
    const paidAmount = sum2(dto.payments.map((p) => p.amount));
    const { total } = computed;
    const paymentStatus: PaymentStatus =
      paidAmount <= 0 ? 'UNPAID' : paidAmount >= total ? 'PAID' : 'PARTIAL';
    const balanceAmount = Math.max(0, round2(total - paidAmount));

    // Resolve the tenant's accounting provider ONCE, from the authenticated tenant.
    // The same instance decides the document type and performs the submission, so
    // the two can never come from different providers. `tenantId` reaches here from
    // `@TenantId()` — the verified session — and there is no DTO field a client
    // could use to name a provider.
    const accounting = await this.accountingProviders.forTenant(tenantId);
    const documentDecision = accounting.resolveSaleDocumentType({
      paymentStatus,
      hasCustomer: Boolean(customerId),
      total,
    });
    const quickbooksDocumentType = documentDecision.documentType;

    // The provider states the requirement; this raises the existing error with its
    // existing wording, so the behaviour Tile Shop users and tests see is unchanged.
    // A tenant with no accounting provider does not impose it — a QuickBooks Invoice
    // needs a CustomerRef, a local invoice does not.
    if (documentDecision.requiresCustomer && !customerId) {
      throw new BadRequestException('A customer is required for a credit/partial sale (Invoice)');
    }

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
      // Derived from the provider's own decision, not from its identity: a sale with
      // an external document is PENDING a push, one without was never queued and is
      // NOT_SYNCED. A `NONE` tenant left permanently "pending" would be showing a
      // QuickBooks state to someone who does not use QuickBooks.
      syncStatus: quickbooksDocumentType === null ? 'NOT_SYNCED' : 'PENDING',
    };

    const postAccounting: PostAccounting = (tx, saleId) =>
      accounting.postSale(tx, { tenantId, branchId }, saleId, quickbooksDocumentType);

    // Slice 6C-A: the same resolved instance that answered the availability question
    // performs the reduction, inside the repository's transaction. The conditional
    // write it contains — not the read above — is what prevents two concurrent sales
    // from both taking the last unit.
    const reduceStock: ReduceStock = (tx, lines, saleId) =>
      inventory.reduceStock(tx, { tenantId, branchId }, lines, {
        // 1a.21 — supplying metadata is what asks the provider to append the
        // stock ledger row. Only the Local provider records anything; QuickBooks
        // stock is a cache of an upstream ledger and NONE has no stock, so this
        // service never asks which mode it is in (D28).
        reason: 'SALE',
        refType: 'SALE',
        refId: saleId,
        createdByUserId: actor.id,
      });

    return dto.saleId
      ? this.salesRepository.completeDraft(tenantId, dto.saleId, persist, postAccounting, reduceStock)
      : this.salesRepository.createCompleted(persist, postAccounting, reduceStock);
  }

  /**
   * MOCK QuickBooks push for a completed sale (real QBO integration comes later).
   *
   * Slice 6A gated this on the tenant's accounting provider. A tenant with no
   * external accounting has nothing to push, so the request is refused outright
   * rather than being handed to a QuickBooks-specific code path that would invent an
   * identifier for it. Nothing is written on the refusal.
   *
   * For a QuickBooks tenant the behaviour is unchanged, mock and all: the identifiers
   * are still generated locally because there is still no real Intuit call here.
   * That remains open question O1, deferred to Phase 2 — this slice removes the
   * fabrication for tenants that should never have reached it, and makes the
   * repository refuse to invent one, but it does not resolve O1.
   */
  async syncToQuickBooks(tenantId: string, id: string): Promise<SaleWithRelations> {
    const sale = await this.salesRepository.findByIdForTenant(tenantId, id);
    if (!sale) {
      throw new NotFoundException(`Sale ${id} not found`);
    }
    if (sale.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed sales can be synced to QuickBooks');
    }

    const accounting = await this.accountingProviders.forTenant(tenantId);
    if (accounting.provider !== AccountingProviderKind.QUICKBOOKS) {
      throw new ProviderOperationUnavailableError(accounting.name, 'QuickBooks sale sync');
    }
    if (sale.quickbooksDocumentType === null) {
      // Belt and braces: a QuickBooks tenant's sales always carry a document type,
      // so this only fires on inconsistent data — and refusing beats guessing.
      throw new BadRequestException(
        `Sale ${sale.saleNumber} has no QuickBooks document type and cannot be synced`,
      );
    }

    return this.salesRepository.markSynced(sale, this.mockQuickBooksDocument(sale));
  }

  /**
   * The mock identifiers the QuickBooks push has always produced.
   *
   * Isolated into a named method so the fabrication is visible rather than buried in
   * a `??` inside the repository, and so the day a real Intuit call replaces it,
   * exactly one function disappears. The prefix branch is now exhaustive over a
   * non-null document type — it can no longer fall through to `INV` for a null.
   */
  private mockQuickBooksDocument(sale: SaleWithRelations): ExternalSaleDocument {
    const documentType = sale.quickbooksDocumentType as QuickBooksDocumentType;
    const prefix = documentType === 'SALES_RECEIPT' ? 'SR' : 'INV';
    return {
      documentId: sale.quickbooksDocumentId ?? `QBO-${prefix}-${sale.saleNumber}`,
      documentType,
      paymentIds: sale.payments.map((_, i) => `QBO-PMT-${sale.saleNumber}-${i + 1}`),
    };
  }

  // ── compute pipeline ───────────────────────────────────────────────────────

  /**
   * Validate and price a cart.
   *
   * `inventory` is the provider the *caller* already resolved, passed in rather
   * than resolved here so one operation cannot check availability against one
   * provider and then move stock through another.
   */
  private async computeCart(
    tenantId: string,
    actor: AuthenticatedUser,
    items: CartItemInput[],
    inventory: InventoryProvider,
    branchId: string,
    orderDiscountInput?: OrderDiscountInput,
  ): Promise<ComputedSale> {
    if (items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await this.salesRepository.findProductsByIds(tenantId, ids);
    const byId = new Map(products.map((p) => [p.id, p]));

    // D99 — resolve every named variant in one read, mirroring the product fetch
    // above. A cart that names no variant does no query at all, so the ordinary
    // single-SKU sale costs exactly what it did before.
    const variantIds = [
      ...new Set(items.map((i) => i.productVariantId).filter((v): v is string => Boolean(v))),
    ];
    const variants = variantIds.length
      ? await this.salesRepository.findVariantsByIds(tenantId, variantIds)
      : [];
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const settings = this.settingsService.getSettings(tenantId);

    // Availability comes from the provider, not from the product row. For
    // QUICKBOOKS and LOCAL that is still `Product.quantityOnHand`, read the same
    // way, so the answer is identical; for DISABLED every product is unlimited and
    // no sale is ever rejected for stock. Read-only, so it happens before the
    // transaction opens — it is a courtesy check, and `reduceStock`'s conditional
    // write remains the authority under concurrency.
    const availability = await inventory.getAvailability({ tenantId, branchId }, ids);

    // D99 — the same courtesy, at variant grain. Without it the two checks
    // disagree: the product total is 10 across four sizes, so the read passes, and
    // then `reduceStock` finds 0 on the Medium's row and refuses with the terser
    // transactional message. Optional on the provider — QuickBooks and DISABLED
    // cannot answer it, and for them the product-level check above is the right one.
    const variantAvailability =
      variantIds.length > 0 && inventory.getVariantAvailability
        ? await inventory.getVariantAvailability({ tenantId, branchId }, variantIds)
        : null;

    const lines = await Promise.all(
      items.map(async (item) => {
        const product = byId.get(item.productId);
        if (!product) {
          throw new BadRequestException(`Unknown product ${item.productId}`);
        }
        if (!product.isActive) {
          throw new BadRequestException(`Product ${product.name} is inactive`);
        }
        // D99 — resolve and vet the variant before any money is computed from it.
        const variant = item.productVariantId ? (variantById.get(item.productVariantId) ?? null) : null;
        if (item.productVariantId && !variant) {
          // Unknown id and another tenant's id give the same message on purpose:
          // the response must not reveal that a variant exists elsewhere.
          throw new BadRequestException(`Unknown variant ${item.productVariantId}`);
        }
        if (variant && variant.productId !== product.id) {
          // Without this a client could pair a cheap variant with a dear product
          // and pay the variant's price for the wrong thing.
          throw new BadRequestException(
            `Variant ${variant.sku} does not belong to ${product.name}`,
          );
        }
        if (variant && !variant.isActive) {
          throw new BadRequestException(`Variant ${variant.sku} is inactive`);
        }

        // A variant owns its price outright; the product price is NOT a fallback.
        // `ProductVariant.unitPrice` is non-nullable, and `sellable.service`
        // reports a variant product's own price as null for exactly this reason —
        // `??` here would let a variant priced at 0 silently charge the product's.
        const cachedPrice = variant ? Number(variant.unitPrice) : Number(product.unitPrice);
        if (item.unitPrice != null && round2(item.unitPrice) !== round2(cachedPrice)) {
          throw new BadRequestException(
            `Price for ${product.name} has changed; refresh the product cache`,
          );
        }

        const quantity = item.quantity;
        // `isUnlimited` is how a provider says "no ceiling" without inventing a
        // quantity. Absent from the map means the provider does not know the
        // product, which the `!product` guard above has already excluded.
        const stock = availability.get(product.id);
        if (stock && !stock.isUnlimited && stock.quantityOnHand !== null) {
          if (variant && variantAvailability) {
            // D99 — a variant line is checked against its own row. Absent means no
            // row, which is no stock (decision 8), so it reads as zero rather than
            // falling back to the product total: the product may hold plenty across
            // its other sizes while this one has none.
            const onHand = variantAvailability.get(variant.id)?.quantityOnHand ?? 0;
            if (quantity > onHand) {
              // Names the variant, unlike the product-level message below. The
              // cashier is looking at a four-size product and needs to know which
              // size is short; the wording below is asserted verbatim by existing
              // specs and must not move.
              const label = variantDisplayName(variant.optionValues, variant.sku);
              throw new BadRequestException(
                `Insufficient stock for ${product.name} (${label}) (on hand ${onHand}, requested ${quantity})`,
              );
            }
          } else {
            const onHand = stock.quantityOnHand;
            if (quantity > onHand) {
              // Wording preserved verbatim — this is the message the POS surfaces and
              // the Slice 3 characterisation spec asserts. Note it is deliberately
              // NOT the same string `reduceStock` throws; both are unchanged.
              throw new BadRequestException(
                `Insufficient stock for ${product.name} (on hand ${onHand}, requested ${quantity})`,
              );
            }
          }
        }

        // D59: line money runs in the shared Decimal engine; the number
        // boundary is exact because every engine output is a 2dp figure.
        const computedLine = computeDocumentLine({
          unitPrice: cachedPrice,
          quantity,
          discountType: item.discountType ?? null,
          discountValue: item.discountValue ?? null,
        });
        const lineSubtotal = computedLine.lineSubtotal.toNumber();
        const discountAmount = computedLine.discountAmount.toNumber();
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
          productVariantId: variant?.id ?? null,
          // D44 — frozen here, at sale time. A later rename or deactivation must
          // not be able to rewrite what this receipt said.
          variantSkuSnapshot: variant?.sku ?? null,
          variantNameSnapshot: variant ? variantDisplayName(variant.optionValues, variant.sku) : null,
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
          // Still 0. Splitting the order-level tax across lines is per-line
          // COMPUTATION, which is parked with grocery (D101). 3.9 records the
          // rate; it does not change a single figure.
          taxAmount: 0,
          /*
           * D101 (3.9) — the rate this line was charged at, frozen now.
           *
           * `taxable` defaults true, so for every existing product this is the
           * tenant rate — exactly what the order-level arithmetic below already
           * applies. Writing it down changes no money.
           *
           * An exempt product and a tenant configured at 0% BOTH snapshot 0.00,
           * and that is correct rather than a conflation: the column records
           * WHAT WAS CHARGED, and both charged nothing. Whether that was because
           * the product is exempt or because the tenant taxes nothing is a
           * question `Product.taxable` still answers, by joining. Recorded here
           * because two paths reaching the same value looks like a bug to
           * whoever reads it next.
           *
           * Never null on a new line. Null on `SaleItem.taxRatePercent` means
           * "written before 3.8", which is the signal 3.10 uses to fall back to
           * proportional refunding — so a new sale must never produce one.
           */
          taxRatePercent: product.taxable ? settings.taxRatePercent : 0,
          lineSubtotal,
          lineTotal: computedLine.lineTotal.toNumber(),
        };
      }),
    );

    // D59: sums and tax in Decimal. Line figures are 2dp, so these sums are
    // exact; sum2's float accumulation could drift a hair below a half.
    const subtotal = lines
      .reduce((acc, l) => acc.plus(l.lineSubtotal), new Prisma.Decimal(0))
      .toNumber();
    const totalDiscount = lines
      .reduce((acc, l) => acc.plus(l.discountAmount), new Prisma.Decimal(0))
      .toNumber();
    // Order-level discount applies to the subtotal AFTER per-line discounts.
    const discountedSubtotal = new Prisma.Decimal(subtotal).minus(totalDiscount).toNumber();
    const orderDiscount = await this.resolveOrderDiscount(
      tenantId,
      actor,
      discountedSubtotal,
      orderDiscountInput,
    );

    const taxableD = new Prisma.Decimal(discountedSubtotal).minus(orderDiscount.amount);
    const taxAmount =
      settings.taxRatePercent > 0
        ? taxableD.mul(settings.taxRatePercent).div(100).toDecimalPlaces(2).toNumber()
        : 0;
    const total = taxableD.plus(taxAmount).toNumber();

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
    const credit = await this.salesRepository.getCustomerCredit(tenantId, customerId);
    if (!credit) return; // existence already validated by assertLocations

    if (!credit.creditAllowed) {
      throw new BadRequestException(
        'This customer is not approved for credit. Take full payment to complete the sale.',
      );
    }

    if (credit.creditLimit != null) {
      const projected = round2(credit.outstanding + newBalance);
      if (projected > credit.creditLimit) {
        const available = round2(Math.max(0, credit.creditLimit - credit.outstanding));
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
    returnStatus: row.returnStatus,
    returnedAmount: Number(row.returnedAmount),
    quickbooksDocumentType: row.quickbooksDocumentType,
    syncStatus: row.syncStatus,
    // Always present, derived from local payment state — so a client never has to
    // fall back to the external type (or to nothing) to know what document this is.
    documentKind: resolveCustomerDocumentKind(row.paymentStatus),
  };
}

function toCartItem(dto: SaleItemInputDto): CartItemInput {
  return {
    productId: dto.productId,
    // D99 — forward the variant. Omitting it here would type-check cleanly and
    // silently drop every variant the till sent, since the field is optional on
    // both sides.
    productVariantId: dto.productVariantId ?? null,
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
  /*
   * D59: delegated to the one Decimal engine. Same signature, same
   * cannot-exceed-base rule; the float arithmetic this replaced mis-rounded
   * exact half-cent boundaries (10% of 19.85 → 1.98 instead of 1.99).
   */
  return computeDocumentLine({
    unitPrice: lineSubtotal,
    quantity: 1,
    discountType: type ?? null,
    discountValue: value ?? null,
  }).discountAmount.toNumber();
}
