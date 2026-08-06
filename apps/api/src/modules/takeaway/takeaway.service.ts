import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  RestaurantOrderChannel,
  RestaurantTableStatus,
  TableSessionStatus,
  TakeawayOrderStatus,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { KitchenService } from '../kitchen/kitchen.service';
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

      const menuItems = await tx.menuItem.findMany({
        where: { id: { in: dto.items.map((i) => i.menuItemId) }, tenantId },
      });
      const map = new Map(menuItems.map((m) => [m.id, m]));
      for (const input of dto.items) {
        const mi = map.get(input.menuItemId);
        if (!mi) throw new NotFoundException(`Menu item ${input.menuItemId} not found`);
        await tx.restaurantOrderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            roundId: round.id,
            menuItemId: mi.id,
            menuItemName: mi.name,
            unitPrice: mi.basePrice,
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

      return this.toView(profile, order.orderNumber);
    });
  }

  async list(tenantId: string, branchId: string): Promise<TakeawayView[]> {
    const rows = await this.prisma.takeawayOrderProfile.findMany({
      where: { tenantId, order: { branchId } },
      include: { order: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r, r.order.orderNumber));
  }

  async updateStatus(
    tenantId: string,
    profileId: string,
    dto: UpdateTakeawayStatusDto,
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
      // On handover, close the underlying session into a Sale (D1 junction).
      if (nextStatus === 'HANDED_OVER' && updated.order.sessionId) {
        const session = await tx.tableSession.findUniqueOrThrow({
          where: { id: updated.order.sessionId },
          include: {
            orders: {
              include: { items: { where: { status: { not: 'VOIDED' } } } },
            },
          },
        });
        if (session.status !== 'CLOSED') {
          let subtotal = new Prisma.Decimal(0);
          for (const order of session.orders) {
            for (const item of order.items) {
              subtotal = subtotal.plus(item.unitPrice.plus(item.modifierTotal).mul(item.quantity));
            }
          }
          const register = await tx.register.findFirstOrThrow({
            where: { branchId: session.branchId, isActive: true },
            select: { id: true },
          });
          const cashier = session.waiterUserId ?? (
            await tx.user.findFirstOrThrow({ where: { tenantId, isActive: true }, select: { id: true } })
          ).id;
          const sale = await tx.sale.create({
            data: {
              tenantId,
              branchId: session.branchId,
              registerId: register.id,
              cashierId: cashier,
              saleNumber: `S-${padSequence(await nextDocumentNumber(tx, tenantId, 'SALE'))}`,
              subtotal,
              total: subtotal,
              balanceAmount: subtotal,
              paymentStatus: 'UNPAID',
              status: 'COMPLETED',
              completedAt: new Date(),
            },
          });
          await tx.tableSession.update({
            where: { id: session.id },
            data: { status: 'CLOSED', closedAt: new Date(), finalSaleId: sale.id },
          });
          await tx.restaurantTable.update({
            where: { id: session.tableId },
            data: { status: RestaurantTableStatus.AVAILABLE },
          });
        }
      }
      return this.toView(updated, updated.order.orderNumber);
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
    };
  }
}
