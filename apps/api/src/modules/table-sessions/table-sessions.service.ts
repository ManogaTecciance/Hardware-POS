import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RestaurantOrderChannel,
  RestaurantOrderStatus,
  KitchenTicketStatus,
  OrderRoundStatus,
  RestaurantOrderItemStatus,
  RestaurantTableKind,
  RestaurantTableStatus,
  TableSessionStatus,
  FulfilmentKind,
  OrderChannel,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { LIVE_SESSION_STATUSES } from '../../common/live-sessions';
import { DiningService, type OpenTableReleaseSummary } from '../dining/dining.service';
import type { PricedDocument } from '../promotions/promotion-pricing';
import { RestaurantPromotionPricingService } from '../promotions/restaurant-promotion-pricing.service';
import { computeRestaurantTotals } from '../restaurant/restaurant-totals';
import {
  assertProjectionMatchesSubtotal,
  type ProjectedPromotion,
} from '../restaurant/settlement-projection';
import { TableServiceFulfilmentProvider } from '../providers/fulfilment/table-service-fulfilment.provider';
import { RoundDepletionService } from '../providers/inventory/round-depletion.service';
import { SettingsService } from '../settings/settings.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { resolveRoundItemInputs, writeRoundItems } from './round-item-resolution';
import {
  CloseSessionDto,
  OpenSessionDto,
  SubmitRoundDto,
  VoidItemDto,
} from './dto/table-sessions.dto';
import {
  BranchNotFoundError,
  GuestCountRequiredError,
  OpenTableSeatsExhaustedError,
  OrderNotFoundError,
  RegisterNotFoundError,
  RoundAlreadySubmittedError,
  SessionAlreadyClosedError,
  SessionNotFoundError,
  SessionNotOpenError,
  TabNameRequiredError,
  TableAlreadyOpenError,
  TableNotFoundError,
  TableReservedForOpenTableError,
} from './table-sessions.errors';

export interface TableSessionView {
  id: string;
  branchId: string;
  tableId: string;
  sessionNumber: string;
  status: TableSessionStatus;
  waiterUserId: string | null;
  guestCount: number | null;
  /**
   * D104 — this tab's own name, when an arrangement carries several parties.
   * Null on every physical table's session and on a lone tab, where the table's
   * name is already unambiguous.
   */
  tabName: string | null;
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
  /**
   * D112 — ids of this session's COMPLETED (bumped) kitchen tickets. This is
   * how "food ready" reaches the floor plan WITHOUT `KOT_VIEW`: the waiter
   * has no business on the kitchen display (their template documents that),
   * but "your table's food is up" is exactly their business, and this route
   * is already scoped to the sessions they may see (D70). Ids, not a count,
   * so the client can ring once per NEW bump and stay silent on re-polls —
   * and a recalled-then-rebumped ticket rings again, because its id leaves
   * and re-enters the list.
   */
  readyTicketIds: string[];
}

/**
 * Full detail for one session (Frontend Phase D). Included on a dedicated
 * `/detail` route rather than mutating the existing `getSession` shape so
 * existing consumers (spec/integration harness) stay stable.
 */
/**
 * D71 — the running bill for a session that has NOT closed.
 *
 * The waiter is the one standing at the table when the guests ask "what do
 * we owe", so they need the same numbers the cashier will see, before the
 * close creates them. Priced by `computeRestaurantTotals` — the SAME
 * function the close uses (D52/D59) — so the paper the guests are shown and
 * the Sale written a minute later cannot disagree.
 *
 * `orderItemId` is the RestaurantOrderItem id, which is exactly what
 * `BillingService.splitByItems` assigns against. That is why a split
 * composed at the table survives the close unchanged.
 */
export interface SessionBillPreview {
  sessionId: string;
  items: {
    orderItemId: string;
    name: string;
    variantName: string | null;
    /** Unit price INCLUDING snapshotted modifier deltas, as the bill shows it. */
    unitPrice: string;
    quantity: string;
    /** NET of any promotion on this line, so the lines sum to the total. */
    lineTotal: string;
    /** What a promotion took off this line. "0.00" when none did. */
    promotionDiscount: string;
    promotionName: string | null;
    roundNumber: number | null;
    /** D72 — "no onions". Shown at the table and printed on the bill. */
    specialInstructions: string | null;
  }[];
  subtotal: string;
  /**
   * Every promotion on this bill, line-level and cart-level, as one figure —
   * which is what the footer shows and what `Sale.totalDiscount` will hold.
   */
  promotionDiscount: string;
  /** Named only when exactly one promotion applied; see `singlePromotionName`. */
  promotionName: string | null;
  serviceChargeAmount: string;
  packagingCharge: string;
  taxAmount: string;
  total: string;
}

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
        /** D71 — "Medium" vs "Large" is what a guest is being charged for. */
        variantName: string | null;
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
    private readonly settings: SettingsService,
      // D61 — the concrete provider, not the factory: this service IS the
    // table-service lifecycle; resolving by tenant would re-read the profile
    // per close to learn what this file already is.
    private readonly fulfilment: TableServiceFulfilmentProvider,
    // D65 — submit-time stock depletion (Q4): the round transaction is where
    // "the kitchen got the ticket" and "the shelf count moved" must coincide.
    private readonly roundDepletion: RoundDepletionService,
    // Promotions on the bill: the same applier retail charges through.
    private readonly promotionPricing: RestaurantPromotionPricingService,
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

      /*
       * D104 — the row lock. Everything below reads the table's live sessions
       * and then writes one more, so two waiters seating the same table at the
       * same moment must serialise. Under the pre-D104 one-tab rule the read
       * was advisory (the loser simply got a second session); with seats being
       * counted, an unserialised read overfills the arrangement instead. Same
       * shape as `DiningService.createOpenTable` and the reservation service.
       */
      await tx.$queryRaw`SELECT id FROM "RestaurantTable" WHERE id = ${dto.tableId} FOR UPDATE`;
      const table = await tx.restaurantTable.findFirst({
        where: { id: dto.tableId, tenantId, branchId, isActive: true },
        select: { id: true, status: true, kind: true, capacity: true },
      });
      if (!table) throw new TableNotFoundError();
      // D49: a physical table absorbed into an open table must not be seatable
      // on its own — otherwise reserving the members is decorative.
      if (table.status === RestaurantTableStatus.RESERVED) {
        throw new TableReservedForOpenTableError();
      }

      /*
       * D104 — how many tabs this table may carry, and how many chairs are
       * left.
       *
       * A tab waiting for its bill still occupies its chairs, so BILLING counts
       * as live here exactly as OPEN does. `LIVE_SESSION_STATUSES` is the one
       * list; adding a session status later forces a deliberate answer rather
       * than defaulting it to "not sitting here".
       */
      const liveTabs = await tx.tableSession.findMany({
        where: { tableId: table.id, status: { in: [...LIVE_SESSION_STATUSES] } },
        select: { id: true, guestCount: true },
      });

      if (table.kind !== RestaurantTableKind.OPEN) {
        // Unchanged for a physical table: one party, one tab. D104 relaxes this
        // for arrangements ONLY — a four-top with a party at it is not a thing
        // two unrelated parties can both be sold.
        if (liveTabs.length > 0) throw new TableAlreadyOpenError();
      } else {
        /*
         * D104 — several parties may share one arrangement, but they must be
         * tellable apart. Required only from the SECOND tab: naming a tab that
         * has no sibling is typing for nothing, and the arrangement's own name
         * already reads unambiguously while it stands alone.
         */
        if (liveTabs.length > 0 && !dto.tabName?.trim()) {
          throw new TabNameRequiredError();
        }
        /*
         * Seats are enforced only when the operator recorded them. D49 made an
         * arrangement's capacity optional on purpose — "seating as arranged" is
         * a real answer — and inventing a limit for those would refuse parties
         * on a number nobody stated.
         */
        if (table.capacity != null) {
          if (dto.guestCount == null) throw new GuestCountRequiredError();
          const taken = liveTabs.reduce((n, t) => n + (t.guestCount ?? 0), 0);
          const seatsFree = table.capacity - taken;
          if (dto.guestCount > seatsFree) throw new OpenTableSeatsExhaustedError(seatsFree);
        }
      }

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
          tabName: dto.tabName?.trim() || null,
          status: TableSessionStatus.OPEN,
        },
      });
      /*
       * D104 — only the FIRST tab moves the table. The unconditional write this
       * replaces would drag an arrangement that has been serving for an hour
       * back from OCCUPIED to SEATED the moment a second party sat down, which
       * reads on the floor as the kitchen having received nothing.
       */
      if (table.status === RestaurantTableStatus.AVAILABLE) {
        await tx.restaurantTable.update({
          where: { id: table.id },
          data: { status: RestaurantTableStatus.SEATED },
        });
      }
      return this.sessionToView(session);
    });
  }

  async getSession(
    tenantId: string,
    sessionId: string,
    onlyWaiterUserId: string | null = null,
  ): Promise<TableSessionView> {
    const row = await this.prisma.tableSession.findFirst({
      where: { id: sessionId, tenantId },
    });
    if (!row) throw new SessionNotFoundError();
    assertOwnedBy(row.waiterUserId, onlyWaiterUserId);
    return this.sessionToView(row);
  }

  /**
   * Frontend Phase D: cheap "which sessions are open on this branch" read
   * for the floor plan → session join. Deliberately does NOT walk orders
   * or items — the summary is small and cacheable; the order-entry screen
   * calls `getSessionDetail` for the full tree.
   */
  /**
   * D71 — the running bill, for the waiter standing at the table.
   *
   * Reads the same rows the close will read (non-voided items across every
   * order on the session) and prices them with the same calculator, so this
   * is a preview of the real number rather than a second opinion about it.
   * Nothing is written; the session stays open.
   */
  async previewBill(
    tenantId: string,
    sessionId: string,
    onlyWaiterUserId: string | null = null,
  ): Promise<SessionBillPreview> {
    const session = await this.prisma.tableSession.findFirst({
      where: { id: sessionId, tenantId },
      include: {
        orders: {
          include: {
            items: {
              where: { status: { not: RestaurantOrderItemStatus.VOIDED } },
              orderBy: { createdAt: 'asc' },
              include: { round: { select: { roundNumber: true } } },
            },
          },
        },
      },
    });
    if (!session) throw new SessionNotFoundError();
    assertOwnedBy(session.waiterUserId, onlyWaiterUserId);

    const items = session.orders.flatMap((order) => order.items);
    let subtotal = new Prisma.Decimal(0);
    for (const item of items) {
      subtotal = subtotal.plus(item.unitPrice.plus(item.modifierTotal).mul(item.quantity));
    }

    const config = await this.prisma.restaurantBranchConfig.findUnique({
      where: { branchId: session.branchId },
      select: {
        serviceChargePercent: true,
        serviceChargeChannels: true,
        serviceChargeTaxable: true,
        packagingChargeAmount: true,
        taxRatePercent: true,
      },
    });
    /*
     * Promotions, over the WHOLE session rather than any one round.
     *
     * A bundle spans rounds and a BOGO counts across them, so the only honest
     * evaluation set is every non-voided item on the table — which is exactly
     * the set the close will price. That is what makes this a preview of the
     * real number rather than a second opinion about it.
     */
    const promotion = await this.promotionPricing.priceOrderItems(
      tenantId,
      session.branchId,
      RestaurantOrderChannel.DINE_IN,
      items,
    );
    const promotionByItemId = new Map(promotion.lines.map((l) => [l.id, l]));

    const appSettings = this.settings.getSettings(tenantId);
    const totals = computeRestaurantTotals(
      subtotal,
      RestaurantOrderChannel.DINE_IN,
      {
        serviceChargePercent: config?.serviceChargePercent ?? new Prisma.Decimal(0),
        serviceChargeChannels: config?.serviceChargeChannels ?? [RestaurantOrderChannel.DINE_IN],
        serviceChargeTaxable: config?.serviceChargeTaxable ?? true,
        packagingChargeAmount: config?.packagingChargeAmount ?? new Prisma.Decimal(0),
        taxRatePercent:
          config?.taxRatePercent != null
            ? config.taxRatePercent.toNumber()
            : appSettings.taxRatePercent,
      },
      { lineDiscount: promotion.totalLineDiscount, orderDiscount: promotion.orderDiscountAmount },
    );

    return {
      sessionId: session.id,
      items: items.map((item) => {
        const won = promotionByItemId.get(item.id);
        const gross = item.unitPrice.plus(item.modifierTotal).mul(item.quantity);
        const discount = won?.promotionDiscountAmount ?? new Prisma.Decimal(0);
        return {
          orderItemId: item.id,
          name: item.menuItemName,
          variantName: item.variantNameSnapshot,
          // Modifiers are folded into the unit price, exactly as BillView does
          // it — the two surfaces show a guest the same number for a line.
          unitPrice: item.unitPrice.plus(item.modifierTotal).toFixed(2),
          quantity: item.quantity.toFixed(3),
          // Net of the promotion, so the lines a waiter reads out add up to
          // the total at the bottom of the same card.
          lineTotal: gross.minus(discount).toFixed(2),
          promotionDiscount: discount.toFixed(2),
          promotionName: won?.promotionNameSnapshot ?? null,
          roundNumber: item.round?.roundNumber ?? null,
          specialInstructions: item.specialInstructions,
        };
      }),
      subtotal: totals.subtotal.toFixed(2),
      promotionDiscount: totals.promotionLineDiscount
        .plus(totals.promotionOrderDiscount)
        .toFixed(2),
      promotionName: this.singlePromotionName(promotion),
      serviceChargeAmount: totals.serviceChargeAmount.toFixed(2),
      packagingCharge: totals.packagingCharge.toFixed(2),
      taxAmount: totals.taxAmount.toFixed(2),
      total: totals.total.toFixed(2),
    };
  }

  /**
   * The promotion to name on the bill footer, or null when more than one
   * applied — several stackable promotions have no single honest label, and
   * the per-line names carry the detail in that case.
   */
  private singlePromotionName(promotion: PricedDocument): string | null {
    const names = new Set(
      [
        ...promotion.lines.map((l) => l.promotionNameSnapshot),
        promotion.orderPromotionNameSnapshot,
      ].filter((n): n is string => n !== null),
    );
    return names.size === 1 ? [...names][0]! : null;
  }

  /**
   * D70 — open sessions on the branch.
   *
   * `onlyWaiterUserId` is the caller's own id when they lack
   * TABLE_SESSION_VIEW_ALL, and null when they hold it. The narrowing is a
   * WHERE clause, not a filter over the result: a waiter must not be able to
   * read another waiter's session number, guest count or order id out of a
   * response the client then hides.
   */
  async listOpenSessions(
    tenantId: string,
    branchId: string,
    onlyWaiterUserId: string | null = null,
  ): Promise<OpenSessionSummary[]> {
    const rows = await this.prisma.tableSession.findMany({
      where: {
        tenantId,
        branchId,
        status: TableSessionStatus.OPEN,
        ...(onlyWaiterUserId ? { waiterUserId: onlyWaiterUserId } : {}),
      },
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
    // D112 — one query for every listed session's bumped tickets, walked back
    // to its session id. Kept out of the include above: the ticket hangs off
    // round → order, not off the one most-recent order that include selects.
    const readyBySession = new Map<string, string[]>();
    if (rows.length > 0) {
      const tickets = await this.prisma.kitchenTicket.findMany({
        where: {
          tenantId,
          status: KitchenTicketStatus.COMPLETED,
          round: { order: { sessionId: { in: rows.map((r) => r.id) } } },
        },
        select: { id: true, round: { select: { order: { select: { sessionId: true } } } } },
      });
      for (const t of tickets) {
        const sid = t.round.order.sessionId;
        readyBySession.set(sid, [...(readyBySession.get(sid) ?? []), t.id]);
      }
    }
    return rows.map((row) => ({
      ...this.sessionToView(row),
      activeOrderId: row.orders[0]?.id ?? null,
      readyTicketIds: readyBySession.get(row.id) ?? [],
    }));
  }

  /**
   * Frontend Phase D: full session tree for the order-entry screen —
   * every non-cancelled order, its rounds, and each round's items with
   * modifier snapshots. Prices come through as strings (Decimal
   * precision preserved). Voided items are included so the running bill
   * can render them struck through.
   */
  async getSessionDetail(
    tenantId: string,
    sessionId: string,
    onlyWaiterUserId: string | null = null,
  ): Promise<SessionDetailView> {
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
    assertOwnedBy(row.waiterUserId, onlyWaiterUserId);
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
            variantName: item.variantNameSnapshot,
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
    onlyWaiterUserId: string | null = null,
  ): Promise<OrderView> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.tableSession.findFirst({
        where: { id: sessionId, tenantId },
        select: { id: true, branchId: true, status: true, waiterUserId: true },
      });
      if (!session) throw new SessionNotFoundError();
      assertOwnedBy(session.waiterUserId, onlyWaiterUserId);
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

    const view = await this.prisma.$transaction(async (tx) => {
      const order = await tx.restaurantOrder.findFirst({
        where: { id: orderId, tenantId },
        select: { id: true, sessionId: true, status: true, session: { select: { status: true } } },
      });
      if (!order) throw new OrderNotFoundError();
      if (order.session.status !== TableSessionStatus.OPEN) throw new SessionNotOpenError();

      // D46 — resolution and validation live in the shared resolver
      // (round-item-resolution.ts, 2026-08-18) so this path and takeaway
      // intake cannot drift: both accept the same MENU_ITEM / PRODUCT
      // sources, apply the same variant and modifier guards, and snapshot
      // the same fields.
      const resolvedItems = await resolveRoundItemInputs(tx, tenantId, dto.items);

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

      // One writer for both intake paths; returns the D65 depletion inputs.
      const { depletionItems } = await writeRoundItems(
        tx,
        { tenantId, orderId: order.id, roundId: round.id },
        resolvedItems,
      );

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

      // D65 — deplete stock for this round, same transaction (Q4: submit).
      // A tracked line the shelf cannot support refuses the WHOLE round,
      // exactly as a retail sale would refuse the cart.
      await this.roundDepletion.depleteSubmittedItems(
        tx,
        tenantId,
        session.branchId,
        depletionItems,
        actorUserId,
      );

      // Phase 6: generate the KOT inside the same transaction so a round and
      // its ticket are visible together. D68 — the ticket IS the delivery: it
      // lands QUEUED on the kitchen board the moment this transaction
      // commits, with nothing downstream to go wrong. D147 — one ticket for
      // the whole round, so no item of it can reach the board on none.
      await this.kitchen.generateTicketForRound(tx, tenantId, session.branchId, round.id);

      const roundFull = await tx.orderRound.findUniqueOrThrow({
        where: { id: round.id },
        include: { items: { select: { id: true } } },
      });
      return this.roundToView(roundFull);
    });
    return view;
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
    // D65 — one transaction: the status flip and the compensating stock
    // movement must not be observable apart, and the status check inside it
    // is what keeps a double-void from double-restoring.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.restaurantOrderItem.findFirst({
        where: { id: itemId, tenantId },
        select: { id: true, status: true },
      });
      if (!existing) throw new OrderNotFoundError();
      if (existing.status === RestaurantOrderItemStatus.VOIDED) {
        // Idempotent no-op.
        return;
      }
      await tx.restaurantOrderItem.update({
        where: { id: existing.id },
        data: {
          status: RestaurantOrderItemStatus.VOIDED,
          voidReason: dto.reason,
          voidedByUserId: actorUserId,
          voidedAt: new Date(),
        },
      });
      // Mirrors the item's RECORDED ORDER_ROUND movements (not a re-expansion
      // of the recipe, which may have changed since submit). No-ops for items
      // that never depleted.
      await this.roundDepletion.restoreVoidedItem(tx, tenantId, existing.id, actorUserId);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Close session → Sale (D1 junction point)
  // ─────────────────────────────────────────────────────────────

  async closeSession(
    tenantId: string,
    sessionId: string,
    dto: CloseSessionDto,
    actorUserId: string,
    onlyWaiterUserId: string | null = null,
  ): Promise<{
    session: TableSessionView;
    saleId: string;
    /** D50 — present only when an OPEN table closed; drives the billing reminder. */
    openTableRelease?: OpenTableReleaseSummary;
  }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.tableSession.findFirst({
        where: { id: sessionId, tenantId },
        include: {
          orders: {
            include: {
              items: {
                where: { status: { not: RestaurantOrderItemStatus.VOIDED } },
                // D58: the projection copies the frozen modifier snapshots too.
                include: { modifiers: true },
              },
            },
          },
        },
      });
      if (!session) throw new SessionNotFoundError();
      assertOwnedBy(session.waiterUserId, onlyWaiterUserId);
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

      // D52: every charge on the bill comes from one shared calculator, so
      // dine-in and takeaway cannot drift. Tax is the tenant's configured rate
      // — it was hardcoded to zero here while retail applied it correctly.
      const config = await tx.restaurantBranchConfig.findUnique({
        where: { branchId: session.branchId },
        select: {
          serviceChargePercent: true,
          serviceChargeChannels: true,
          serviceChargeTaxable: true,
          packagingChargeAmount: true,
          taxRatePercent: true,
        },
      });
      /*
       * Promotions, priced inside the transaction over the same rows the
       * projection below will settle. The preview the waiter showed the table
       * ran the identical call, so the guest is charged what they were quoted
       * unless the order itself changed in between.
       */
      const promotion = await this.promotionPricing.priceOrderItems(
        tenantId,
        session.branchId,
        RestaurantOrderChannel.DINE_IN,
        session.orders.flatMap((order) => order.items),
        tx,
      );
      const promotionByItemId: ReadonlyMap<string, ProjectedPromotion> = new Map(
        promotion.lines.map((l) => [l.id, l]),
      );

      const appSettings = this.settings.getSettings(tenantId);
      const totals = computeRestaurantTotals(
        subtotal,
        RestaurantOrderChannel.DINE_IN,
        {
          serviceChargePercent: config?.serviceChargePercent ?? new Prisma.Decimal(0),
          serviceChargeChannels: config?.serviceChargeChannels ?? [RestaurantOrderChannel.DINE_IN],
          serviceChargeTaxable: config?.serviceChargeTaxable ?? true,
          packagingChargeAmount: config?.packagingChargeAmount ?? new Prisma.Decimal(0),
          // D59/Q5: the branch override wins when set; NULL inherits the
          // tenant-wide rate. 0 is a real rate, which is why the column is
          // nullable rather than defaulted.
          taxRatePercent:
            config?.taxRatePercent != null
              ? config.taxRatePercent.toNumber()
              : appSettings.taxRatePercent,
        },
        { lineDiscount: promotion.totalLineDiscount, orderDiscount: promotion.orderDiscountAmount },
      );

      // D52: the till that took the money. An explicit registerId wins; the
      // fallback is ordered by code so it is at least deterministic — the
      // previous findFirstOrThrow had no orderBy and could return a different
      // register between two closes on the same branch.
      const register = dto.registerId
        ? await tx.register.findFirst({
            where: { id: dto.registerId, branchId: session.branchId, isActive: true },
            select: { id: true },
          })
        : await tx.register.findFirst({
            where: { branchId: session.branchId, isActive: true },
            orderBy: { code: 'asc' },
            select: { id: true },
          });
      if (!register) throw new RegisterNotFoundError();

      // D52: the human who closed the bill. Was "first active user in the
      // tenant" — not branch-scoped, so it booked untagged sales to whoever
      // the query returned, in practice the owner.
      const cashierId = session.waiterUserId ?? actorUserId;

      const saleNumber = `S-${padSequence(await nextDocumentNumber(tx, tenantId, 'SALE'))}`;
      /*
       * D58: the settled document carries its lines, projected from the order
       * items inside THIS transaction — a copy of the submit-time snapshots,
       * with the sum invariant asserted before anything persists.
       */
      // D61: collection goes through the fulfilment provider — an independent
      // query over the same rows the subtotal loop read, so the invariant
      // below compares two computations rather than one restated.
      const projected = await this.fulfilment.collectSettlementLines(
        tx,
        tenantId,
        { kind: 'TABLE_SESSION', sessionId: session.id },
        promotionByItemId,
      );
      assertProjectionMatchesSubtotal(projected, subtotal, totals.promotionLineDiscount);
      const sale = await tx.sale.create({
        data: {
          tenantId,
          branchId: session.branchId,
          registerId: register.id,
          cashierId,
          saleNumber,
          subtotal,
          /*
           * The line-level promotions, which is what `discountedSubtotal =
           * subtotal - totalDiscount` has to mean for the returns calculation
           * to reverse a refund correctly. A cart-level promotion is NOT here:
           * it lives in its own columns and comes off after tax, exactly as on
           * a retail sale.
           */
          totalDiscount: totals.promotionLineDiscount,
          promotionOrderDiscountAmount: totals.promotionOrderDiscount,
          promotionOrderId: promotion.orderPromotionId,
          promotionOrderNameSnapshot: promotion.orderPromotionNameSnapshot,
          taxAmount: totals.taxAmount,
          serviceChargeAmount: totals.serviceChargeAmount,
          packagingCharge: totals.packagingCharge,
          total: totals.total,
          paidAmount: new Prisma.Decimal(0),
          balanceAmount: totals.total,
          paymentStatus: 'UNPAID',
          status: 'COMPLETED',
          completedAt: new Date(),
          // D58 — what kind of sale this was, on the document itself.
          fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
          channel: OrderChannel.DINE_IN,
          sourceRefKind: 'TABLE_SESSION',
          sourceRefId: session.id,
          servedByUserId: session.waiterUserId,
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

      const updated = await tx.tableSession.update({
        where: { id: session.id },
        data: {
          status: TableSessionStatus.CLOSED,
          closedAt: new Date(),
          finalSaleId: sale.id,
          version: { increment: 1 },
        },
      });
      /*
       * D61: resource release belongs to the fulfilment provider — the same
       * transaction, so "bill closed" and "tables released" cannot be
       * observed apart. Physical tables go AVAILABLE; an open table (D49)
       * dissolves the whole arrangement.
       */
      const release = await this.fulfilment.releaseResources(tx, tenantId, {
        kind: 'TABLE_SESSION',
        sessionId: session.id,
      });

      if (release.openTableRelease !== undefined) {
        return {
          session: this.sessionToView(updated),
          saleId: sale.id,
          openTableRelease: release.openTableRelease,
        };
      }

      return { session: this.sessionToView(updated), saleId: sale.id };
    });
    return result;
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
      tabName: row.tabName,
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

/**
 * D70 — refuse a session that belongs to a different waiter.
 *
 * `onlyWaiterUserId` is null for a caller holding TABLE_SESSION_VIEW_ALL, in
 * which case nothing is refused. Otherwise the session must be theirs — and
 * an UNCLAIMED session (waiterUserId null, e.g. the synthetic walk-in table
 * behind counter and takeaway orders) is refused too: it is nobody's, and
 * "nobody's" must not read as "everybody's".
 *
 * Raised as not-found rather than forbidden, deliberately: a 403 on a
 * specific id confirms the session exists and that somebody else has it,
 * which is exactly the fact a waiter is not entitled to.
 */
function assertOwnedBy(sessionWaiterUserId: string | null, onlyWaiterUserId: string | null): void {
  if (onlyWaiterUserId === null) return;
  if (sessionWaiterUserId !== onlyWaiterUserId) throw new SessionNotFoundError();
}
