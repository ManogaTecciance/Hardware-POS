import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  RestaurantOrderChannel,
  RestaurantTableStatus,
  TableSessionStatus,
  TakeawayOrderStatus,
  FulfilmentKind,
  OrderChannel,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { KitchenService } from '../kitchen/kitchen.service';
import { computeRestaurantTotals } from '../restaurant/restaurant-totals';
import { assertProjectionMatchesSubtotal } from '../restaurant/settlement-projection';
import { resolveMenuItemPricing } from '../menu/menu-item-pricing';
import { TableServiceFulfilmentProvider } from '../providers/fulfilment/table-service-fulfilment.provider';
import { SettingsService } from '../settings/settings.service';
import { CreateTakeawayDto, UpdateTakeawayStatusDto } from './dto/takeaway.dto';

export interface TakeawayView {
  id: string;
  orderId: string;
  orderNumber: string;
  status: TakeawayOrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  pickupAt: string | null;
  handoverAt: string | null;
  notes: string | null;
  createdAt: string;
  /**
   * The Sale row created when the session closes on `HANDED_OVER`. Null
   * before handover. Exposed so the counter POS can collect payment
   * (`/bills/:saleId/payments`) without a second round-trip to look up
   * `session.finalSaleId`. Pilot Change 3.
   */
  finalSaleId: string | null;
}

/**
 * Phase 7. Takeaway rides on the existing RestaurantOrder / TableSession
 * machinery — a synthetic "walk-in" table per branch keeps the D1 junction
 * (closing a session produces a Sale) intact for the takeaway flow.
 */
@Injectable()
export class TakeawayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kitchen: KitchenService,
    private readonly settings: SettingsService,
      private readonly fulfilment: TableServiceFulfilmentProvider,
  ) {}

  async create(
    tenantId: string,
    dto: CreateTakeawayDto,
    actorUserId: string,
  ): Promise<TakeawayView> {
    const config = await this.prisma.restaurantBranchConfig.findUnique({
      where: { branchId: dto.branchId },
      select: { takeawayEnabled: true },
    });
    if (config && !config.takeawayEnabled) {
      throw new BadRequestException('Takeaway is disabled on this branch');
    }

    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: dto.branchId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Branch not found');

      const table = await this.ensureWalkInTable(tx, tenantId, dto.branchId);

      const sequence = await nextDocumentNumber(tx, tenantId, 'TABLE_SESSION');
      const session = await tx.tableSession.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          tableId: table.id,
          sessionNumber: `TS-${padSequence(sequence)}`,
          status: TableSessionStatus.OPEN,
          waiterUserId: actorUserId,
        },
      });

      const orderSeq = await nextDocumentNumber(tx, tenantId, 'RESTAURANT_ORDER');
      const order = await tx.restaurantOrder.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          sessionId: session.id,
          orderNumber: `RO-${padSequence(orderSeq)}`,
          channel: RestaurantOrderChannel.TAKEAWAY,
          status: 'DRAFT',
        },
      });

      // Attach items via the same round machinery so KOTs are printed.
      const round = await tx.orderRound.create({
        data: {
          tenantId,
          orderId: order.id,
          roundNumber: 1,
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedByUserId: actorUserId,
          idempotencyKey: dto.idempotencyKey,
        },
      });

      // Takeaway is still MENU_ITEM-only (the counter POS's D46 widening
      // is scoped to the dine-in `submitRound` path). If a client sends a
      // PRODUCT-sourced item to the takeaway endpoint we refuse up front
      // — that path would otherwise crash with a Prisma NOT NULL error
      // because `menuItemId` is optional on the shared DTO now.
      for (const input of dto.items) {
        if (input.sourceKind && input.sourceKind !== 'MENU_ITEM') {
          throw new BadRequestException(
            'Takeaway does not yet accept Product-sourced items',
          );
        }
        if (!input.menuItemId) {
          throw new BadRequestException('menuItemId is required');
        }
      }
      // D60 — the same transitional pricing rule the dine-in path uses:
      // placement override ?? product price ?? frozen basePrice, with the
      // product reference stamped for routing and reporting.
      const pricing = await resolveMenuItemPricing(
        tx,
        tenantId,
        dto.items.map((i) => i.menuItemId!),
      );
      for (const input of dto.items) {
        const resolved = pricing.get(input.menuItemId!);
        if (!resolved) throw new NotFoundException(`Menu item ${input.menuItemId} not found`);
        await tx.restaurantOrderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            roundId: round.id,
            menuItemId: resolved.menuItem.id,
            menuItemName: resolved.menuItem.name,
            unitPrice: resolved.unitPrice,
            productId: resolved.productId,
            modifierTotal: new Prisma.Decimal(0),
            quantity: new Prisma.Decimal(input.quantity),
            specialInstructions: input.specialInstructions ?? null,
            status: 'SENT',
          },
        });
      }
      await this.kitchen.generateTicketsForRound(tx, tenantId, dto.branchId, round.id);

      const profile = await tx.takeawayOrderProfile.create({
        data: {
          tenantId,
          orderId: order.id,
          customerName: dto.customerName ?? null,
          customerPhone: dto.customerPhone ?? null,
          pickupAt: dto.pickupAt ? new Date(dto.pickupAt) : null,
          notes: dto.notes ?? null,
        },
      });

      await tx.restaurantOrder.update({
        where: { id: order.id },
        data: { status: 'SUBMITTED' },
      });

      // A freshly-created takeaway has no Sale yet — it lands on handover.
      return this.toView(profile, order.orderNumber, null);
    });
  }

  async list(tenantId: string, branchId: string): Promise<TakeawayView[]> {
    const rows = await this.prisma.takeawayOrderProfile.findMany({
      where: { tenantId, order: { branchId } },
      include: {
        order: {
          select: {
            orderNumber: true,
            session: { select: { finalSaleId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) =>
      this.toView(r, r.order.orderNumber, r.order.session?.finalSaleId ?? null),
    );
  }

  async updateStatus(
    tenantId: string,
    profileId: string,
    dto: UpdateTakeawayStatusDto,
    actorUserId: string,
  ): Promise<TakeawayView> {
    const existing = await this.prisma.takeawayOrderProfile.findFirst({
      where: { id: profileId, tenantId },
      include: { order: { select: { orderNumber: true, sessionId: true, branchId: true } } },
    });
    if (!existing) throw new NotFoundException('Takeaway order not found');

    return this.prisma.$transaction(async (tx) => {
      const nextStatus = dto.status as TakeawayOrderStatus;
      const handoverAt =
        nextStatus === 'HANDED_OVER' && !existing.handoverAt ? new Date() : existing.handoverAt;
      const updated = await tx.takeawayOrderProfile.update({
        where: { id: existing.id },
        data: { status: nextStatus, handoverAt },
        include: { order: { select: { orderNumber: true, sessionId: true, branchId: true } } },
      });
      let finalSaleId: string | null = null;
      // On handover, close the underlying session into a Sale (D1 junction).
      if (nextStatus === 'HANDED_OVER' && updated.order.sessionId) {
        const session = await tx.tableSession.findUniqueOrThrow({
          where: { id: updated.order.sessionId },
          include: {
            orders: {
              include: {
                // Subtotal only — the provider queries its own rows for the
                // projection (see the dine-in close for why).
                items: { where: { status: { not: 'VOIDED' } } },
              },
            },
          },
        });
        finalSaleId = session.finalSaleId;
        if (session.status !== 'CLOSED') {
          let subtotal = new Prisma.Decimal(0);
          for (const order of session.orders) {
            for (const item of order.items) {
              subtotal = subtotal.plus(item.unitPrice.plus(item.modifierTotal).mul(item.quantity));
            }
          }
          // D52: deterministic register, and the authenticated actor as the
          // cashier — this used to pick "first active user in the tenant",
          // which was not branch-scoped.
          const register = await tx.register.findFirst({
            where: { branchId: session.branchId, isActive: true },
            orderBy: { code: 'asc' },
            select: { id: true },
          });
          if (!register) throw new NotFoundException('No active register on this branch');
          const cashier = session.waiterUserId ?? actorUserId;

          // D52: the same calculator dine-in uses. Takeaway previously wrote
          // `total: subtotal` — no service charge, no packaging, no tax.
          const branchConfig = await tx.restaurantBranchConfig.findUnique({
            where: { branchId: session.branchId },
            select: {
              serviceChargePercent: true,
              serviceChargeChannels: true,
              serviceChargeTaxable: true,
              packagingChargeAmount: true,
              taxRatePercent: true,
            },
          });
          const appSettings = this.settings.getSettings(tenantId);
          const totals = computeRestaurantTotals(subtotal, RestaurantOrderChannel.TAKEAWAY, {
            serviceChargePercent: branchConfig?.serviceChargePercent ?? new Prisma.Decimal(0),
            serviceChargeChannels: branchConfig?.serviceChargeChannels ?? [RestaurantOrderChannel.DINE_IN],
            serviceChargeTaxable: branchConfig?.serviceChargeTaxable ?? true,
            packagingChargeAmount: branchConfig?.packagingChargeAmount ?? new Prisma.Decimal(0),
            // D59/Q5: branch override wins when set; NULL inherits.
            taxRatePercent:
              branchConfig?.taxRatePercent != null
                ? branchConfig.taxRatePercent.toNumber()
                : appSettings.taxRatePercent,
          });

          // D58/D61: collection via the fulfilment provider — the same
          // projection and sum invariant the dine-in close uses, from an
          // independent query over the same rows.
          const projected = await this.fulfilment.collectSettlementLines(tx, tenantId, {
            kind: 'TABLE_SESSION',
            sessionId: session.id,
          });
          assertProjectionMatchesSubtotal(projected, subtotal);
          const sale = await tx.sale.create({
            data: {
              tenantId,
              branchId: session.branchId,
              registerId: register.id,
              cashierId: cashier,
              saleNumber: `S-${padSequence(await nextDocumentNumber(tx, tenantId, 'SALE'))}`,
              subtotal,
              serviceChargeAmount: totals.serviceChargeAmount,
              packagingCharge: totals.packagingCharge,
              taxAmount: totals.taxAmount,
              total: totals.total,
              balanceAmount: totals.total,
              paymentStatus: 'UNPAID',
              status: 'COMPLETED',
              completedAt: new Date(),
              fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
              channel: OrderChannel.TAKEAWAY,
              sourceRefKind: 'TABLE_SESSION',
              sourceRefId: session.id,
              // Who served: the waiter who owns the session when there is one,
              // else the operator handing the order over.
              servedByUserId: session.waiterUserId ?? actorUserId,
            },
          });
          for (const line of projected) {
            const { modifiers, ...data } = line;
            const saleItem = await tx.saleItem.create({ data: { saleId: sale.id, ...data } });
            if (modifiers.length > 0) {
              await tx.saleItemModifier.createMany({
                data: modifiers.map((m) => ({ tenantId, saleItemId: saleItem.id, ...m })),
              });
            }
          }
          await tx.tableSession.update({
            where: { id: session.id },
            data: { status: 'CLOSED', closedAt: new Date(), finalSaleId: sale.id },
          });
          // D61: release via the provider (a takeaway session sits on the
          // synthetic walk-in table; the provider frees whatever kind it is).
          await this.fulfilment.releaseResources(tx, tenantId, {
            kind: 'TABLE_SESSION',
            sessionId: session.id,
          });
          finalSaleId = sale.id;
        }
      }
      return this.toView(updated, updated.order.orderNumber, finalSaleId);
    });
  }

  private async ensureWalkInTable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<{ id: string }> {
    // Look up or create a synthetic "walk-in" area + table for this branch.
    let area = await tx.diningArea.findFirst({
      where: { tenantId, branchId, name: '__walk_in__' },
      select: { id: true },
    });
    if (!area) {
      area = await tx.diningArea.create({
        data: { tenantId, branchId, name: '__walk_in__', isActive: true, position: 999 },
      });
    }
    let table = await tx.restaurantTable.findFirst({
      where: { tenantId, branchId, areaId: area.id, code: 'WALK-IN' },
      select: { id: true },
    });
    if (!table) {
      table = await tx.restaurantTable.create({
        data: {
          tenantId,
          branchId,
          areaId: area.id,
          code: 'WALK-IN',
          capacity: 1,
          status: RestaurantTableStatus.AVAILABLE,
        },
      });
    }
    return table;
  }

  private toView(
    row: Prisma.TakeawayOrderProfileGetPayload<Record<string, never>>,
    orderNumber: string,
    finalSaleId: string | null,
  ): TakeawayView {
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber,
      status: row.status,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      pickupAt: row.pickupAt?.toISOString() ?? null,
      handoverAt: row.handoverAt?.toISOString() ?? null,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      finalSaleId,
    };
  }
}
