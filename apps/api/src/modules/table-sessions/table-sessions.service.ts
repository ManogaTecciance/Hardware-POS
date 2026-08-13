import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RestaurantOrderChannel,
  RestaurantOrderStatus,
  OrderRoundStatus,
  RestaurantOrderItemSourceKind,
  RestaurantOrderItemStatus,
  RestaurantTableStatus,
  TableSessionStatus,
  RestaurantTableKind,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { DiningService } from '../dining/dining.service';
import { KitchenService } from '../kitchen/kitchen.service';
import {
  CloseSessionDto,
  OpenSessionDto,
  OrderItemInputDto,
  RestaurantOrderItemSourceKindDto,
  SubmitRoundDto,
  VoidItemDto,
} from './dto/table-sessions.dto';
import {
  BranchNotFoundError,
  MenuItemInactiveError,
  MenuItemNotFoundError,
  ModifierOptionNotOnItemError,
  OrderNotFoundError,
  ProductInactiveError,
  ProductNotFoundError,
  ProductVariantInactiveError,
  ProductVariantNotFoundError,
  RoundAlreadySubmittedError,
  SessionAlreadyClosedError,
  SessionNotFoundError,
  SessionNotOpenError,
  TableAlreadyOpenError,
  TableNotFoundError,
  TableReservedForOpenTableError,
  VariantNotOnProductError,
  VariantSelectionRequiredError,
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

/**
 * Frontend Phase D needed a cheap "which sessions are open on this branch"
 * read for the floor plan → session join. Returned as a flat list of
 * TableSessionView + activeOrderId (the most recent non-cancelled order on
 * the session, if any).
 */
export interface OpenSessionSummary extends TableSessionView {
  activeOrderId: string | null;
}

/**
 * Full detail for one session (Frontend Phase D). Included on a dedicated
 * `/detail` route rather than mutating the existing `getSession` shape so
 * existing consumers (spec/integration harness) stay stable.
 */
export interface SessionDetailView {
  session: TableSessionView;
  orders: {
    order: OrderView;
    rounds: {
      round: RoundView;
      items: {
        id: string;
        menuItemId: string;
        menuItemName: string;
        unitPrice: string;
        modifierTotal: string;
        quantity: string;
        specialInstructions: string | null;
        status: RestaurantOrderItemStatus;
        modifiers: { optionName: string; groupName: string; priceDelta: string }[];
      }[];
    }[];
  }[];
}

@Injectable()
export class TableSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kitchen: KitchenService,
    private readonly dining: DiningService,
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
      // D49: a physical table absorbed into an open table must not be seatable
      // on its own — otherwise reserving the members is decorative.
      if (table.status === RestaurantTableStatus.RESERVED) {
        throw new TableReservedForOpenTableError();
      }

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

  /**
   * Frontend Phase D: cheap "which sessions are open on this branch" read
   * for the floor plan → session join. Deliberately does NOT walk orders
   * or items — the summary is small and cacheable; the order-entry screen
   * calls `getSessionDetail` for the full tree.
   */
  async listOpenSessions(tenantId: string, branchId: string): Promise<OpenSessionSummary[]> {
    const rows = await this.prisma.tableSession.findMany({
      where: { tenantId, branchId, status: TableSessionStatus.OPEN },
      include: {
        orders: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, createdAt: true },
          take: 1,
        },
      },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map((row) => ({
      ...this.sessionToView(row),
      activeOrderId: row.orders[0]?.id ?? null,
    }));
  }

  /**
   * Frontend Phase D: full session tree for the order-entry screen —
   * every non-cancelled order, its rounds, and each round's items with
   * modifier snapshots. Prices come through as strings (Decimal
   * precision preserved). Voided items are included so the running bill
   * can render them struck through.
   */
  async getSessionDetail(tenantId: string, sessionId: string): Promise<SessionDetailView> {
    const row = await this.prisma.tableSession.findFirst({
      where: { id: sessionId, tenantId },
      include: {
        orders: {
          orderBy: { createdAt: 'asc' },
          include: {
            rounds: {
              orderBy: { roundNumber: 'asc' },
              include: {
                items: {
                  orderBy: { createdAt: 'asc' },
                  include: { modifiers: true },
                },
              },
            },
          },
        },
      },
    });
    if (!row) throw new SessionNotFoundError();
    return {
      session: this.sessionToView(row),
      orders: row.orders.map((order) => ({
        order: this.orderToView(order),
        rounds: order.rounds.map((round) => ({
          round: {
            id: round.id,
            orderId: round.orderId,
            roundNumber: round.roundNumber,
            status: round.status,
            submittedAt: round.submittedAt?.toISOString() ?? null,
            itemIds: round.items.map((i) => i.id),
          },
          items: round.items.map((item) => ({
            id: item.id,
            menuItemId: item.menuItemId,
            menuItemName: item.menuItemName,
            unitPrice: item.unitPrice.toFixed(2),
            modifierTotal: item.modifierTotal.toFixed(2),
            quantity: item.quantity.toFixed(3),
            specialInstructions: item.specialInstructions,
            status: item.status,
            modifiers: item.modifiers.map((m) => ({
              optionName: m.optionName,
              groupName: m.groupName,
              priceDelta: m.priceDelta.toFixed(2),
            })),
          })),
        })),
      })),
    };
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

      // D46 — the round DTO now carries two sources of round items:
      // legacy MenuItem-sourced (default) and Product-sourced (with an
      // optional variant). Split up front so each authority is loaded in
      // its own tenant-scoped batch — one query per source, not one per
      // item — and rejected uniformly if the row is missing / inactive /
      // on the wrong parent.
      const sourceOf = (it: OrderItemInputDto): RestaurantOrderItemSourceKindDto =>
        it.sourceKind ?? RestaurantOrderItemSourceKindDto.MENU_ITEM;
      const menuInputs = dto.items.filter(
        (it) => sourceOf(it) === RestaurantOrderItemSourceKindDto.MENU_ITEM,
      );
      const productInputs = dto.items.filter(
        (it) => sourceOf(it) === RestaurantOrderItemSourceKindDto.PRODUCT,
      );

      const menuItemIds = menuInputs.map((it) => it.menuItemId!);
      const productIds = productInputs.map((it) => it.productId!);
      const productVariantIds = productInputs
        .map((it) => it.productVariantId)
        .filter((id): id is string => Boolean(id));

      // Three tenant-scoped batches in parallel. Each empty-set query is
      // skipped so an all-MENU_ITEM round never touches the Product tables
      // (and vice versa).
      const [menuItems, products, productVariants] = await Promise.all([
        menuItemIds.length
          ? tx.menuItem.findMany({
              where: { id: { in: menuItemIds }, tenantId },
              include: {
                modifierGroups: {
                  select: { modifierGroupId: true },
                },
              },
            })
          : Promise.resolve([]),
        productIds.length
          ? tx.product.findMany({
              where: { id: { in: productIds }, tenantId },
              include: {
                modifierGroups: {
                  select: { modifierGroupId: true },
                },
              },
            })
          : Promise.resolve([]),
        productVariantIds.length
          ? tx.productVariant.findMany({
              where: { id: { in: productVariantIds }, tenantId },
              include: {
                // Composed variant label ("Small / Red") for the snapshot
                // and for the KOT print. Falls back to SKU when the
                // variant was created without option values.
                optionValues: { include: { option: { select: { name: true } } } },
              },
            })
          : Promise.resolve([]),
      ]);

      const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));
      const productMap = new Map(products.map((p) => [p.id, p]));
      const variantMap = new Map(productVariants.map((v) => [v.id, v]));

      // Per-input resolution. Each iteration produces a `Resolved` record
      // the write loop below turns into a snapshot row — no second pass
      // over the DTO, no divergent field-population per source. This is
      // where every D46 rejection surfaces so no invalid row ever reaches
      // the write path.
      type ResolvedMenuItem = { kind: 'MENU_ITEM'; menuItem: (typeof menuItems)[number] };
      type ResolvedProduct = {
        kind: 'PRODUCT';
        product: (typeof products)[number];
        variant: (typeof productVariants)[number] | null;
      };
      type Resolved = ResolvedMenuItem | ResolvedProduct;
      const resolved: Resolved[] = [];
      for (const inputItem of dto.items) {
        const kind = sourceOf(inputItem);
        if (kind === RestaurantOrderItemSourceKindDto.MENU_ITEM) {
          const mi = menuItemMap.get(inputItem.menuItemId!);
          if (!mi) throw new MenuItemNotFoundError();
          if (!mi.isActive) throw new MenuItemInactiveError(mi.name);
          resolved.push({ kind: 'MENU_ITEM', menuItem: mi });
          continue;
        }
        const product = productMap.get(inputItem.productId!);
        if (!product) throw new ProductNotFoundError();
        if (!product.isActive) throw new ProductInactiveError(product.name);

        let variant: (typeof productVariants)[number] | null = null;
        if (inputItem.productVariantId) {
          variant = variantMap.get(inputItem.productVariantId) ?? null;
          if (!variant) throw new ProductVariantNotFoundError();
          if (variant.productId !== product.id) throw new VariantNotOnProductError();
          if (!variant.isActive) throw new ProductVariantInactiveError(variant.sku);
        } else {
          // No variantId sent. If the Product has any active variant, the
          // client MUST pick one — otherwise the price is ambiguous. We
          // ask the DB directly here (rather than trusting `hasVariants`)
          // because `hasVariants` can be true while every variant is
          // inactive, in which case the parent Product's `unitPrice`
          // legitimately applies.
          const activeVariantCount = await tx.productVariant.count({
            where: { productId: product.id, tenantId, isActive: true },
          });
          if (activeVariantCount > 0) {
            throw new VariantSelectionRequiredError(product.name);
          }
        }
        resolved.push({ kind: 'PRODUCT', product, variant });
      }

      // Modifier options (if any) — snapshot their names + deltas.
      const modifierOptionIds = dto.items.flatMap(
        (it) => it.modifiers?.map((m) => m.modifierOptionId) ?? [],
      );
      const modifierOptions = modifierOptionIds.length
        ? await tx.modifierOption.findMany({
            where: { id: { in: modifierOptionIds }, tenantId },
            include: { group: { select: { id: true, name: true } } },
          })
        : [];
      const modifierMap = new Map(modifierOptions.map((o) => [o.id, o]));

      // D46 — service-layer guard: a modifier option must belong to a
      // group that is actually attached to the ordered item. A
      // ModifierGroup is intentionally reusable across items, so the DB
      // cannot express "this option is valid for THIS item only". Without
      // this check a client could send any tenant-scoped modifier and
      // its priceDelta would silently flow into the snapshot.
      for (let i = 0; i < dto.items.length; i++) {
        const inputItem = dto.items[i];
        if (!inputItem.modifiers?.length) continue;
        const r = resolved[i];
        const allowedGroupIds = new Set(
          r.kind === 'MENU_ITEM'
            ? r.menuItem.modifierGroups.map((g) => g.modifierGroupId)
            : r.product.modifierGroups.map((g) => g.modifierGroupId),
        );
        for (const m of inputItem.modifiers) {
          const opt = modifierMap.get(m.modifierOptionId);
          // A missing option is treated as "not on the item" — same
          // effect for the caller: refuse the round, refuse the write.
          if (!opt || !allowedGroupIds.has(opt.groupId)) {
            throw new ModifierOptionNotOnItemError();
          }
        }
      }

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

      for (let i = 0; i < dto.items.length; i++) {
        const inputItem = dto.items[i];
        const r = resolved[i];
        const selectedMods = (inputItem.modifiers ?? []).map((m) =>
          modifierMap.get(m.modifierOptionId),
        );
        const modifierTotal = selectedMods.reduce(
          (sum, m) => sum + (m ? Number(m.priceDelta) : 0),
          0,
        );

        // Uniform snapshot fields — resolved to concrete values per
        // source so the write below is a single shape. `menuItemId` stays
        // a loose string reference for both sources (a PRODUCT-sourced
        // row stores the Product id there, matching D46's decision to
        // keep the legacy field for reprint / order-detail / KOT lookup).
        let refId: string;
        let refName: string;
        let unitPrice: Prisma.Decimal;
        let sourceKind: RestaurantOrderItemSourceKind;
        let productIdSnapshot: string | null;
        let productVariantIdSnapshot: string | null;
        let variantNameSnapshot: string | null;
        let variantPriceSnapshot: Prisma.Decimal | null;

        if (r.kind === 'MENU_ITEM') {
          refId = r.menuItem.id;
          refName = r.menuItem.name;
          unitPrice = r.menuItem.basePrice;
          sourceKind = RestaurantOrderItemSourceKind.MENU_ITEM;
          productIdSnapshot = null;
          productVariantIdSnapshot = null;
          variantNameSnapshot = null;
          variantPriceSnapshot = null;
        } else {
          refId = r.product.id;
          refName = r.product.name;
          sourceKind = RestaurantOrderItemSourceKind.PRODUCT;
          productIdSnapshot = r.product.id;
          if (r.variant) {
            unitPrice = r.variant.unitPrice;
            productVariantIdSnapshot = r.variant.id;
            // Compose "Small / Red"; fall back to SKU when the variant
            // has no option values (a wizard shortcut path). Mirrors the
            // pos-catalogue variant-name convention so what the operator
            // saw in the picker matches what prints on the KOT.
            const composed = r.variant.optionValues
              .map((ov) => ov.option?.name ?? '')
              .filter(Boolean)
              .join(' / ');
            variantNameSnapshot = composed.length > 0 ? composed : r.variant.sku;
            variantPriceSnapshot = r.variant.unitPrice;
          } else {
            unitPrice = r.product.unitPrice;
            productVariantIdSnapshot = null;
            variantNameSnapshot = null;
            variantPriceSnapshot = null;
          }
        }

        const item = await tx.restaurantOrderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            roundId: round.id,
            menuItemId: refId,
            menuItemName: refName,
            unitPrice,
            modifierTotal: new Prisma.Decimal(modifierTotal),
            quantity: new Prisma.Decimal(inputItem.quantity),
            specialInstructions: inputItem.specialInstructions ?? null,
            status: RestaurantOrderItemStatus.SENT,
            sourceKind,
            productId: productIdSnapshot,
            productVariantId: productVariantIdSnapshot,
            variantNameSnapshot,
            variantPriceSnapshot,
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
      // Release the table. For an open table (D49) that means the whole
      // arrangement: members back to AVAILABLE, memberships deleted, and the
      // open-table row archived — in THIS transaction, so "bill closed" and
      // "tables released" cannot be observed apart.
      const closedTable = await tx.restaurantTable.findUniqueOrThrow({
        where: { id: session.tableId },
        select: { kind: true },
      });
      if (closedTable.kind === RestaurantTableKind.OPEN) {
        await this.dining.releaseOpenTable(tx, tenantId, session.tableId);
      } else {
        await tx.restaurantTable.update({
          where: { id: session.tableId },
          data: { status: RestaurantTableStatus.AVAILABLE },
        });
      }

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
