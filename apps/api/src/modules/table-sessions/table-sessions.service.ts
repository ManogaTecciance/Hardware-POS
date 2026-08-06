import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RestaurantOrderChannel,
  RestaurantOrderStatus,
  OrderRoundStatus,
  RestaurantOrderItemStatus,
  RestaurantTableStatus,
  TableSessionStatus,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { KitchenService } from '../kitchen/kitchen.service';
import {
  CloseSessionDto,
  OpenSessionDto,
  SubmitRoundDto,
  VoidItemDto,
} from './dto/table-sessions.dto';
import {
  BranchNotFoundError,
  ItemAlreadySentError,
  MenuItemInactiveError,
  MenuItemNotFoundError,
  OrderNotFoundError,
  RoundAlreadySubmittedError,
  SessionAlreadyClosedError,
  SessionNotFoundError,
  SessionNotOpenError,
  TableAlreadyOpenError,
  TableNotFoundError,
} from './table-sessions.errors';

export interface TableSessionView {
  id: string;
  branchId: string;
  tableId: string;
  sessionNumber: string;
  status: TableSessionStatus;
  waiterUserId: string | null;
  guestCount: number | null;
  openedAt: string;
  closedAt: string | null;
  finalSaleId: string | null;
  version: number;
}

export interface OrderView {
  id: string;
  sessionId: string;
  branchId: string;
  orderNumber: string;
  channel: RestaurantOrderChannel;
  status: RestaurantOrderStatus;
  version: number;
}

export interface RoundView {
  id: string;
  orderId: string;
  roundNumber: number;
  status: OrderRoundStatus;
  submittedAt: string | null;
  itemIds: string[];
}

@Injectable()
export class TableSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kitchen: KitchenService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Sessions
  // ─────────────────────────────────────────────────────────────

  async openSession(
    tenantId: string,
    branchId: string,
    dto: OpenSessionDto,
  ): Promise<TableSessionView> {
    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: branchId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!branch) throw new BranchNotFoundError();

      const table = await tx.restaurantTable.findFirst({
        where: { id: dto.tableId, tenantId, branchId, isActive: true },
        select: { id: true, status: true },
      });
      if (!table) throw new TableNotFoundError();

      const openSessionExists = await tx.tableSession.findFirst({
        where: { tableId: table.id, status: TableSessionStatus.OPEN },
        select: { id: true },
      });
      if (openSessionExists) throw new TableAlreadyOpenError();

      const sequence = await nextDocumentNumber(tx, tenantId, 'TABLE_SESSION');
      const sessionNumber = `TS-${padSequence(sequence)}`;

      const session = await tx.tableSession.create({
        data: {
          tenantId,
          branchId,
          tableId: table.id,
          sessionNumber,
          waiterUserId: dto.waiterUserId ?? null,
          guestCount: dto.guestCount ?? null,
          status: TableSessionStatus.OPEN,
        },
      });
      await tx.restaurantTable.update({
        where: { id: table.id },
        data: { status: RestaurantTableStatus.SEATED },
      });
      return this.sessionToView(session);
    });
  }

  async getSession(tenantId: string, sessionId: string): Promise<TableSessionView> {
    const row = await this.prisma.tableSession.findFirst({
      where: { id: sessionId, tenantId },
    });
    if (!row) throw new SessionNotFoundError();
    return this.sessionToView(row);
  }

  // ─────────────────────────────────────────────────────────────
  // Orders
  // ─────────────────────────────────────────────────────────────

  async createOrder(
    tenantId: string,
    sessionId: string,
    channel: RestaurantOrderChannel = RestaurantOrderChannel.DINE_IN,
  ): Promise<OrderView> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.tableSession.findFirst({
        where: { id: sessionId, tenantId },
        select: { id: true, branchId: true, status: true },
      });
      if (!session) throw new SessionNotFoundError();
      if (session.status !== TableSessionStatus.OPEN) throw new SessionNotOpenError();

      const seq = await nextDocumentNumber(tx, tenantId, 'RESTAURANT_ORDER');
      const orderNumber = `RO-${padSequence(seq)}`;
      const order = await tx.restaurantOrder.create({
        data: {
          tenantId,
          branchId: session.branchId,
          sessionId: session.id,
          orderNumber,
          channel,
          status: RestaurantOrderStatus.DRAFT,
        },
      });
      return this.orderToView(order);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Rounds — idempotent per key (scenario 11)
  // ─────────────────────────────────────────────────────────────

  async submitRound(
    tenantId: string,
    orderId: string,
    dto: SubmitRoundDto,
    actorUserId: string,
  ): Promise<RoundView> {
    // Idempotency check outside the transaction: if a round with this key
    // already exists for this tenant, return it verbatim. Scenario 11 requires
    // a duplicate request to NOT create a duplicate round.
    const existing = await this.prisma.orderRound.findUnique({
      where: {
        tenantId_idempotencyKey: { tenantId, idempotencyKey: dto.idempotencyKey },
      },
      include: { items: { select: { id: true } } },
    });
    if (existing) {
      if (existing.orderId !== orderId) throw new RoundAlreadySubmittedError();
      return this.roundToView(existing);
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.restaurantOrder.findFirst({
        where: { id: orderId, tenantId },
        select: { id: true, sessionId: true, status: true, session: { select: { status: true } } },
      });
      if (!order) throw new OrderNotFoundError();
      if (order.session.status !== TableSessionStatus.OPEN) throw new SessionNotOpenError();

      // Validate every menu item up front and snapshot their names/prices.
      const menuItemIds = dto.items.map((it) => it.menuItemId);
      const menuItems = await tx.menuItem.findMany({
        where: { id: { in: menuItemIds }, tenantId },
        include: { modifierGroups: true },
      });
      const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));
      for (const inputItem of dto.items) {
        const mi = menuItemMap.get(inputItem.menuItemId);
        if (!mi) throw new MenuItemNotFoundError();
        if (!mi.isActive) throw new MenuItemInactiveError(mi.name);
      }

      // Modifier options (if any) — snapshot their names + deltas.
      const modifierOptionIds = dto.items.flatMap(
        (it) => it.modifiers?.map((m) => m.modifierOptionId) ?? [],
      );
      const modifierOptions = modifierOptionIds.length
        ? await tx.modifierOption.findMany({
            where: { id: { in: modifierOptionIds }, tenantId },
            include: { group: { select: { name: true } } },
          })
        : [];
      const modifierMap = new Map(modifierOptions.map((o) => [o.id, o]));

      const previousRoundCount = await tx.orderRound.count({ where: { orderId: order.id } });
      const round = await tx.orderRound.create({
        data: {
          tenantId,
          orderId: order.id,
          roundNumber: previousRoundCount + 1,
          status: OrderRoundStatus.SUBMITTED,
          submittedAt: new Date(),
          submittedByUserId: actorUserId,
          idempotencyKey: dto.idempotencyKey,
        },
      });

      for (const inputItem of dto.items) {
        const mi = menuItemMap.get(inputItem.menuItemId)!;
        const selectedMods = (inputItem.modifiers ?? []).map((m) => modifierMap.get(m.modifierOptionId));
        const modifierTotal = selectedMods.reduce(
          (sum, m) => sum + (m ? Number(m.priceDelta) : 0),
          0,
        );
        const item = await tx.restaurantOrderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            roundId: round.id,
            menuItemId: mi.id,
            menuItemName: mi.name,
            unitPrice: mi.basePrice,
            modifierTotal: new Prisma.Decimal(modifierTotal),
            quantity: new Prisma.Decimal(inputItem.quantity),
            specialInstructions: inputItem.specialInstructions ?? null,
            status: RestaurantOrderItemStatus.SENT,
          },
        });
        for (const modOpt of selectedMods) {
          if (!modOpt) continue;
          await tx.restaurantOrderItemModifier.create({
            data: {
              tenantId,
              itemId: item.id,
              modifierOptionId: modOpt.id,
              optionName: modOpt.name,
              groupName: modOpt.group.name,
              priceDelta: modOpt.priceDelta,
            },
          });
        }
      }

      // Order status transitions from DRAFT to SUBMITTED on first round.
      if (order.status === RestaurantOrderStatus.DRAFT) {
        await tx.restaurantOrder.update({
          where: { id: order.id },
          data: { status: RestaurantOrderStatus.SUBMITTED, version: { increment: 1 } },
        });
        await tx.restaurantOrderStatusHistory.create({
          data: {
            tenantId,
            orderId: order.id,
            fromStatus: RestaurantOrderStatus.DRAFT,
            toStatus: RestaurantOrderStatus.SUBMITTED,
            changedByUserId: actorUserId,
          },
        });
      }

      // Table transitions to OCCUPIED once at least one round is sent.
      const session = await tx.tableSession.findUniqueOrThrow({
        where: { id: order.sessionId },
        select: { tableId: true, branchId: true },
      });
      await tx.restaurantTable.updateMany({
        where: { tenantId, id: session.tableId },
        data: { status: RestaurantTableStatus.OCCUPIED },
      });

      // Phase 6: generate KOTs inside the same transaction so a round and
      // its tickets are visible together. Scenario 20 requires the round
      // to be persisted even if printer wiring later fails; the tickets
      // themselves are QUEUED and the print attempt driver handles retry.
      await this.kitchen.generateTicketsForRound(tx, tenantId, session.branchId, round.id);

      const roundFull = await tx.orderRound.findUniqueOrThrow({
        where: { id: round.id },
        include: { items: { select: { id: true } } },
      });
      return this.roundToView(roundFull);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Void a sent item (scenario 15: cannot silently delete)
  // ─────────────────────────────────────────────────────────────

  async voidItem(
    tenantId: string,
    itemId: string,
    dto: VoidItemDto,
    actorUserId: string,
  ): Promise<void> {
    const existing = await this.prisma.restaurantOrderItem.findFirst({
      where: { id: itemId, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) throw new OrderNotFoundError();
    if (existing.status === RestaurantOrderItemStatus.VOIDED) {
      // Idempotent no-op.
      return;
    }
    await this.prisma.restaurantOrderItem.update({
      where: { id: existing.id },
      data: {
        status: RestaurantOrderItemStatus.VOIDED,
        voidReason: dto.reason,
        voidedByUserId: actorUserId,
        voidedAt: new Date(),
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Close session → Sale (D1 junction point)
  // ─────────────────────────────────────────────────────────────

  async closeSession(
    tenantId: string,
    sessionId: string,
    _dto: CloseSessionDto,
  ): Promise<{ session: TableSessionView; saleId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.tableSession.findFirst({
        where: { id: sessionId, tenantId },
        include: {
          orders: { include: { items: { where: { status: { not: RestaurantOrderItemStatus.VOIDED } } } } },
        },
      });
      if (!session) throw new SessionNotFoundError();
      if (session.status === TableSessionStatus.CLOSED) throw new SessionAlreadyClosedError();

      // Sum all non-voided items. Money is Decimal(12,2); use Prisma.Decimal
      // arithmetic to preserve precision.
      let subtotal = new Prisma.Decimal(0);
      for (const order of session.orders) {
        for (const item of order.items) {
          const lineTotal = item.unitPrice
            .plus(item.modifierTotal)
            .mul(item.quantity);
          subtotal = subtotal.plus(lineTotal);
        }
      }

      // Phase 8: apply the branch's service charge (D8). Default is 0
      // (disabled), so a tenant that has never configured it pays only the
      // subtotal. Rounded to 2 decimals to match money precision.
      const config = await tx.restaurantBranchConfig.findUnique({
        where: { branchId: session.branchId },
        select: { serviceChargePercent: true },
      });
      const serviceChargePercent = config?.serviceChargePercent ?? new Prisma.Decimal(0);
      const serviceChargeAmount = subtotal
        .mul(serviceChargePercent)
        .div(100)
        .toDecimalPlaces(2);
      const total = subtotal.plus(serviceChargeAmount);

      // Register lookup: use the branch's first active register (matches
      // resolveLocation() in auth.repository).
      const register = await tx.register.findFirstOrThrow({
        where: { branchId: session.branchId, isActive: true },
        select: { id: true },
      });

      // The Sale needs a `cashierId` even though this is a restaurant close.
      // Use the waiter as the natural cashier; if none is recorded on the
      // session, fall back to the first active user in the tenant so the FK
      // is satisfied. Phase 8 will introduce a proper billing user.
      const cashierId =
        session.waiterUserId ??
        (
          await tx.user.findFirstOrThrow({
            where: { tenantId, isActive: true },
            select: { id: true },
          })
        ).id;

      const saleNumber = `S-${padSequence(await nextDocumentNumber(tx, tenantId, 'SALE'))}`;
      const sale = await tx.sale.create({
        data: {
          tenantId,
          branchId: session.branchId,
          registerId: register.id,
          cashierId,
          saleNumber,
          subtotal,
          totalDiscount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          serviceChargeAmount,
          packagingCharge: new Prisma.Decimal(0),
          total,
          paidAmount: new Prisma.Decimal(0),
          balanceAmount: total,
          paymentStatus: 'UNPAID',
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      const updated = await tx.tableSession.update({
        where: { id: session.id },
        data: {
          status: TableSessionStatus.CLOSED,
          closedAt: new Date(),
          finalSaleId: sale.id,
          version: { increment: 1 },
        },
      });
      // Release the physical table.
      await tx.restaurantTable.update({
        where: { id: session.tableId },
        data: { status: RestaurantTableStatus.AVAILABLE },
      });

      return { session: this.sessionToView(updated), saleId: sale.id };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Converters
  // ─────────────────────────────────────────────────────────────
  private sessionToView(
    row: Prisma.TableSessionGetPayload<Record<string, never>>,
  ): TableSessionView {
    return {
      id: row.id,
      branchId: row.branchId,
      tableId: row.tableId,
      sessionNumber: row.sessionNumber,
      status: row.status,
      waiterUserId: row.waiterUserId,
      guestCount: row.guestCount,
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      finalSaleId: row.finalSaleId,
      version: row.version,
    };
  }

  private orderToView(row: Prisma.RestaurantOrderGetPayload<Record<string, never>>): OrderView {
    return {
      id: row.id,
      sessionId: row.sessionId,
      branchId: row.branchId,
      orderNumber: row.orderNumber,
      channel: row.channel,
      status: row.status,
      version: row.version,
    };
  }

  private roundToView(
    row: Prisma.OrderRoundGetPayload<{ include: { items: { select: { id: true } } } }>,
  ): RoundView {
    return {
      id: row.id,
      orderId: row.orderId,
      roundNumber: row.roundNumber,
      status: row.status,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      itemIds: row.items.map((i) => i.id),
    };
  }
}
