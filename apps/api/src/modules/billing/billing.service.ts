import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import {
  BillSplitInputDto,
  CollectPaymentDto,
  ItemSplitInputDto,
} from './dto/billing.dto';
import { allocateSplitShares, lineTotal } from './split-shares';

/** D51 — one orderable line on the bill, and how much of it is spoken for. */
export interface BillLineItem {
  orderItemId: string;
  name: string;
  /** Variant snapshot ("LARGE") when the line came from a Product variant. */
  variantName: string | null;
  /** Unit price INCLUDING snapshotted modifier deltas — what a unit costs here. */
  unitPrice: string;
  quantity: string;
  lineTotal: string;
  /** Quantity already assigned to splits; `quantity` minus this is unassigned. */
  assignedQuantity: string;
  /**
   * D72 — what the guest asked for on this line ("no onions", "extra
   * crispy"). It belongs on the printed bill: a guest checking a charge
   * reads the line they remember ordering, and a kitchen note is often the
   * only thing distinguishing two otherwise identical lines.
   */
  specialInstructions: string | null;
}

export interface BillView {
  saleId: string;
  saleNumber: string;
  subtotal: string;
  /** D72 — discount taken off the bill. Zero today for a restaurant close
   *  (D52 defers promotion pricing), but a printed bill must show one the
   *  moment one exists rather than silently absorbing it into the total. */
  totalDiscount: string;
  serviceChargeAmount: string;
  packagingCharge: string;
  /** D72 — the tax the branch charged. Was omitted from this view entirely,
   *  so a bill printed for a taxed branch could not add up. */
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceAmount: string;
  paymentStatus: PaymentStatus;
  /** D72 — receipt header: who served it, where, and when it was settled. */
  servedByName: string | null;
  /** "T7 · Terrace", or "Takeaway" for the synthetic walk-in table. */
  placeLabel: string | null;
  closedAt: string;
  /** D51 — the lines behind the totals, so a bill can be split by what was eaten. */
  items: BillLineItem[];
  splits: {
    id: string;
    label: string | null;
    share: string;
    paidAmount: string;
    /** D51 — the lines this split covers. Empty for an amount-only split. */
    items: { orderItemId: string; name: string; quantity: string; lineTotal: string }[];
  }[];
  payments: {
    id: string;
    amount: string;
    method: PaymentMethod;
    reference: string | null;
  }[];
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getBill(tenantId: string, saleId: string): Promise<BillView> {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: {
        billSplits: {
          orderBy: { createdAt: 'asc' },
          include: { items: { include: { orderItem: true } } },
        },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    /*
     * D72 — "Served By" on the printed bill. `servedByUserId` is the waiter
     * who worked the table (D58); `cashierId` is whoever closed it. Prefer
     * the former: the guest reading the bill is thinking of the person who
     * brought their food, not the till operator.
     */
    const servedById = sale.servedByUserId ?? sale.cashierId;
    const servedBy = servedById
      ? await this.prisma.user.findUnique({
          where: { id: servedById },
          select: { name: true },
        })
      : null;
    /*
     * `TableSession.finalSaleId` is a plain unique column, not a relation, so
     * the table is a second lookup. The synthetic WALK-IN table backs every
     * counter and takeaway order; the guest wants to read "Takeaway", not a
     * table code that exists only in the schema.
     */
    const session = await this.prisma.tableSession.findFirst({
      where: { finalSaleId: saleId, tenantId },
      select: { table: { select: { code: true, area: { select: { name: true } } } } },
    });
    const table = session?.table ?? null;
    const placeLabel = table
      ? table.code === 'WALK-IN'
        ? 'Takeaway'
        : `${table.code}${table.area?.name ? ` · ${table.area.name}` : ''}`
      : null;

    return this.toView(
      sale,
      await this.loadOrderItems(tenantId, sale.id),
      servedBy?.name ?? null,
      placeLabel,
    );
  }

  /**
   * D51 — the bill's line items.
   *
   * A restaurant Sale carries no SaleItem rows: `closeSession` writes only
   * totals, and the lines live on the session's orders. So the bill reads them
   * back through `TableSession.finalSaleId`, excluding voided items exactly as
   * the close-time subtotal did — otherwise the lines would not add up to the
   * money.
   */
  private async loadOrderItems(tenantId: string, saleId: string) {
    const session = await this.prisma.tableSession.findFirst({
      where: { finalSaleId: saleId, tenantId },
      select: {
        orders: {
          select: {
            items: {
              where: { status: { not: 'VOIDED' } },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    return session?.orders.flatMap((o) => o.items) ?? [];
  }

  async collectPayment(
    tenantId: string,
    saleId: string,
    dto: CollectPaymentDto,
    actorUserId: string,
  ): Promise<BillView> {
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: { id: true, total: true, paidAmount: true, billingVersion: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');

      const paymentAmount = new Prisma.Decimal(dto.amount);
      const newPaid = sale.paidAmount.plus(paymentAmount);
      if (newPaid.greaterThan(sale.total)) {
        throw new BadRequestException(
          `Payment ${paymentAmount.toFixed(2)} exceeds balance ${sale.total
            .minus(sale.paidAmount)
            .toFixed(2)}`,
        );
      }

      // D51 — allocate to one split when asked. Until this, the bill screen's
      // "Collect for split" button captured a split id it never sent, so a
      // split's paidAmount could never leave zero.
      let split: { id: string; share: Prisma.Decimal; paidAmount: Prisma.Decimal } | null = null;
      if (dto.splitId) {
        split = await tx.billSplit.findFirst({
          where: { id: dto.splitId, saleId: sale.id, tenantId },
          select: { id: true, share: true, paidAmount: true },
        });
        if (!split) throw new NotFoundException('Split not found on this bill');
        const splitRemaining = split.share.minus(split.paidAmount);
        if (paymentAmount.greaterThan(splitRemaining)) {
          throw new BadRequestException(
            `Payment ${paymentAmount.toFixed(2)} exceeds this split's balance ${splitRemaining.toFixed(2)}`,
          );
        }
      }
      const newBalance = sale.total.minus(newPaid);
      const nextStatus: PaymentStatus =
        newBalance.equals(0) ? PaymentStatus.PAID : PaymentStatus.PARTIAL;

      await tx.payment.create({
        data: {
          tenantId,
          saleId: sale.id,
          receivedByUserId: actorUserId,
          method: dto.method as PaymentMethod,
          amount: paymentAmount,
          reference: dto.reference ?? null,
        },
      });
      // Two-phase update — check billingVersion to catch concurrent
      // cashiers (scenario 18: two users cannot complete the same payment).
      const updated = await tx.sale.updateMany({
        where: { id: sale.id, billingVersion: sale.billingVersion },
        data: {
          paidAmount: newPaid,
          balanceAmount: newBalance,
          paymentStatus: nextStatus,
          billingVersion: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new BadRequestException('Bill was modified concurrently; reload and retry');
      }
      if (split) {
        await tx.billSplit.update({
          where: { id: split.id },
          data: { paidAmount: split.paidAmount.plus(paymentAmount) },
        });
      }
    });
    // See splitByItems — read after commit, not inside the transaction.
    return this.getBill(tenantId, saleId);
  }

  /**
   * D51 — split a bill by the lines each party ate.
   *
   * Shares are derived here, never supplied: each split gets its own line
   * totals plus a pro-rata slice of everything else on the bill, and the
   * allocator guarantees the shares sum to the total exactly. Every unit of
   * every line must be assigned, because "shares sum to total" is the
   * invariant the payment path already relies on.
   */
  async splitByItems(
    tenantId: string,
    saleId: string,
    splits: ItemSplitInputDto[],
  ): Promise<BillView> {
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: {
          id: true,
          subtotal: true,
          total: true,
          paidAmount: true,
          billingVersion: true,
        },
      });
      if (!sale) throw new NotFoundException('Sale not found');
      // Reallocating shares under a recorded tender has no honest answer:
      // money has already been attributed. Split first, then collect.
      if (sale.paidAmount.greaterThan(0)) {
        throw new BadRequestException(
          'This bill already has payments — reopen or refund before re-splitting',
        );
      }

      const orderItems = await this.loadOrderItems(tenantId, sale.id);
      if (orderItems.length === 0) {
        throw new BadRequestException('This bill has no line items to split');
      }
      const byId = new Map(orderItems.map((it) => [it.id, it]));

      // Every assigned id must belong to THIS bill — otherwise a caller could
      // price one bill's split from another bill's lines.
      const assignedTotals = new Map<string, Prisma.Decimal>();
      for (const split of splits) {
        for (const row of split.items) {
          if (!byId.has(row.orderItemId)) {
            throw new BadRequestException(`Item ${row.orderItemId} is not on this bill`);
          }
          assignedTotals.set(
            row.orderItemId,
            (assignedTotals.get(row.orderItemId) ?? new Prisma.Decimal(0)).plus(row.quantity),
          );
        }
      }

      // Full assignment, exactly — over-assigning invents money, under-assigning
      // leaves a share of the bill that no split will ever pay.
      for (const item of orderItems) {
        const assigned = assignedTotals.get(item.id) ?? new Prisma.Decimal(0);
        if (!assigned.equals(item.quantity)) {
          throw new BadRequestException(
            `"${item.menuItemName}": ${assigned.toFixed(3)} of ${item.quantity.toFixed(3)} assigned — every item must be fully assigned`,
          );
        }
      }

      const itemSubtotals = splits.map((split) =>
        split.items.reduce((acc, row) => {
          const item = byId.get(row.orderItemId)!;
          return acc.plus(lineTotal(item.unitPrice, item.modifierTotal, new Prisma.Decimal(row.quantity)));
        }, new Prisma.Decimal(0)),
      );
      const shares = allocateSplitShares({
        itemSubtotals,
        subtotal: sale.subtotal,
        total: sale.total,
      });

      // Replace wholesale: editing splits is re-describing the whole division,
      // and a partial update would leave orphaned assignments behind.
      await tx.billSplit.deleteMany({ where: { saleId: sale.id } });
      for (const [i, split] of splits.entries()) {
        const created = await tx.billSplit.create({
          data: {
            tenantId,
            saleId: sale.id,
            label: split.label?.trim() || null,
            share: shares[i]!,
          },
        });
        await tx.billSplitItem.createMany({
          data: split.items.map((row) => ({
            tenantId,
            billSplitId: created.id,
            orderItemId: row.orderItemId,
            quantity: new Prisma.Decimal(row.quantity),
          })),
        });
      }
      await tx.sale.update({
        where: { id: sale.id },
        data: { billingVersion: { increment: 1 } },
      });
    });
    // Read AFTER the transaction commits. `getBill` runs on `this.prisma`, so
    // calling it inside would read pre-commit state and hand the client a bill
    // without the splits it just created.
    return this.getBill(tenantId, saleId);
  }

  async setSplits(
    tenantId: string,
    saleId: string,
    splits: BillSplitInputDto[],
  ): Promise<BillView> {
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: { id: true, total: true, billingVersion: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');

      const sum = splits.reduce(
        (acc, s) => acc.plus(new Prisma.Decimal(s.share)),
        new Prisma.Decimal(0),
      );
      if (!sum.equals(sale.total)) {
        throw new BadRequestException(
          `Splits sum ${sum.toFixed(2)} must equal total ${sale.total.toFixed(2)}`,
        );
      }
      await tx.billSplit.deleteMany({ where: { saleId: sale.id } });
      await tx.billSplit.createMany({
        data: splits.map((s) => ({
          tenantId,
          saleId: sale.id,
          label: s.label ?? null,
          share: new Prisma.Decimal(s.share),
        })),
      });
      await tx.sale.update({
        where: { id: sale.id },
        data: { billingVersion: { increment: 1 } },
      });
    });
    // See splitByItems — read after commit, not inside the transaction.
    return this.getBill(tenantId, saleId);
  }

  async reopen(
    tenantId: string,
    saleId: string,
    _reason: string,
  ): Promise<BillView> {
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: { id: true, paymentStatus: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.paymentStatus === PaymentStatus.PAID) {
        // Reopening a fully-paid bill implies a refund path; that's out of
        // scope here. Refuse cleanly.
        throw new BadRequestException(
          'Bill is fully paid — issue a return via /returns instead',
        );
      }
      // For UNPAID/PARTIAL bills, "reopen" is a no-op state-wise; the
      // audit record from the controller captures the who/why.
    });
    // Read after the transaction like every other method here, so no future
    // write added above can silently return pre-commit state.
    return this.getBill(tenantId, saleId);
  }

  private toView(
    sale: Prisma.SaleGetPayload<{
      include: {
        billSplits: { include: { items: { include: { orderItem: true } } } };
        payments: true;
      };
    }>,
    orderItems: Array<{
      id: string;
      menuItemName: string;
      variantNameSnapshot: string | null;
      unitPrice: Prisma.Decimal;
      modifierTotal: Prisma.Decimal;
      quantity: Prisma.Decimal;
      specialInstructions: string | null;
    }> = [],
    /** D72 — resolved by the caller; `toView` stays a pure projection. */
    servedByName: string | null = null,
    placeLabel: string | null = null,
  ): BillView {
    const assignedByItem = new Map<string, Prisma.Decimal>();
    for (const split of sale.billSplits) {
      for (const row of split.items ?? []) {
        assignedByItem.set(
          row.orderItemId,
          (assignedByItem.get(row.orderItemId) ?? new Prisma.Decimal(0)).plus(row.quantity),
        );
      }
    }
    return {
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      subtotal: sale.subtotal.toFixed(2),
      totalDiscount: sale.totalDiscount.toFixed(2),
      serviceChargeAmount: sale.serviceChargeAmount.toFixed(2),
      packagingCharge: sale.packagingCharge.toFixed(2),
      taxAmount: sale.taxAmount.toFixed(2),
      total: sale.total.toFixed(2),
      paidAmount: sale.paidAmount.toFixed(2),
      balanceAmount: sale.balanceAmount.toFixed(2),
      paymentStatus: sale.paymentStatus,
      servedByName,
      placeLabel,
      closedAt: sale.createdAt.toISOString(),
      items: orderItems.map((it) => ({
        orderItemId: it.id,
        name: it.menuItemName,
        variantName: it.variantNameSnapshot ?? null,
        unitPrice: it.unitPrice.plus(it.modifierTotal).toFixed(2),
        quantity: it.quantity.toFixed(3),
        lineTotal: lineTotal(it.unitPrice, it.modifierTotal, it.quantity).toFixed(2),
        assignedQuantity: (assignedByItem.get(it.id) ?? new Prisma.Decimal(0)).toFixed(3),
        specialInstructions: it.specialInstructions,
      })),
      splits: sale.billSplits.map((s) => ({
        id: s.id,
        label: s.label,
        share: s.share.toFixed(2),
        paidAmount: s.paidAmount.toFixed(2),
        items: (s.items ?? []).map((row) => ({
          orderItemId: row.orderItemId,
          name: row.orderItem.menuItemName,
          quantity: row.quantity.toFixed(3),
          lineTotal: lineTotal(
            row.orderItem.unitPrice,
            row.orderItem.modifierTotal,
            row.quantity,
          ).toFixed(2),
        })),
      })),
      payments: sale.payments.map((p) => ({
        id: p.id,
        amount: p.amount.toFixed(2),
        method: p.method,
        reference: p.reference ?? null,
      })),
    };
  }
}
