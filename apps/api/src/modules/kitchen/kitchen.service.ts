import { Injectable } from '@nestjs/common';
import {
  KitchenTicketStatus,
  OrderRoundStatus,
  Prisma,
  RestaurantOrderItemStatus,
  TakeawayOrderStatus,
} from '@hardware-pos/database';

import { lastNDaysInTimeZone, safeTimeZone, type Paginated } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { paginate } from '../../common/pagination';
import { withTabName } from '../../common/place-label';
import { SettingsService } from '../settings/settings.service';

/** D83 — every item on the order a ticket belongs to, for the kitchen. */
export interface KitchenOrderView {
  ticketId: string;
  ticketNumber: string;
  orderNumber: string | null;
  placeLabel: string | null;
  waiterName: string | null;
  placedAt: string;
  items: {
    id: string;
    name: string;
    variantName: string | null;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
    roundNumber: number | null;
  }[];
}

/**
 * D142b — what each lane chip says, for ALL THREE lanes at once.
 *
 * The board fetches one lane's tickets at a time, so it can only count the
 * lane it is looking at; the other two chips had no number to show. These are
 * counted server-side over the same `where` the lists use, so a chip and its
 * lane can never disagree.
 */
export interface KitchenLaneCounts {
  toMake: number;
  preparing: number;
  doneToday: number;
}

export interface KitchenTicketView {
  id: string;
  ticketNumber: string;
  branchId: string;
  roundId: string;
  /*
   * D147 — NULL on every ticket cut since the per-station split was removed:
   * a round is ONE ticket now, and a ticket that belongs to no station must
   * not claim one. Non-null only on tickets raised BEFORE D147, which keep
   * the station they were genuinely routed to.
   */
  stationId: string | null;
  status: KitchenTicketStatus;
  /*
   * D68 — the board is the ONLY place this ticket is ever delivered, so it
   * carries what a printed KOT used to: where the food is going, whose order
   * it is, and which round. A station screen showing dish names alone cannot
   * tell the pass which table to plate for.
   */
  orderNumber: string | null;
  placeLabel: string | null;
  roundNumber: number | null;
  waiterName: string | null;
  items: {
    id: string;
    menuItemName: string;
    /**
     * D46 — variant selection shown on the ticket ("MEDIUM", "LARGE").
     * NULL for legacy MENU_ITEM rows and for non-variant Products.
     */
    variantName: string | null;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
  }[];
  completedAt: string | null;
  completedByName: string | null;
  createdAt: string;
}

/**
 * Phase 6, rewritten by D68. Kitchen tickets — for the BOARD, not a printer.
 *
 * Called from `TableSessionsService.submitRound` INSIDE the round's
 * transaction, so a ticket and its items become visible together and a
 * committed round can never be missing from the kitchen's queue. There is
 * no delivery step after this: writing the row IS the delivery, which is
 * the whole reason D68 dropped printing — a ticket cannot fail to reach a
 * screen that reads it from the database.
 */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The zone the business reckons its days in — the same read the dashboard's
   * "today" makes (D142). Cutting the Done lane on the SERVER's midnight would,
   * on a UTC host serving a Colombo kitchen, empty the lane at half past five
   * in the morning and keep the last of the night's tickets on it until then.
   */
  private tz(tenantId: string): string {
    return safeTimeZone(this.settings.getSettings(tenantId).timezone);
  }

  /**
   * Half-open `[midnight, next midnight)` in the shop's zone, resolved PER
   * CALL. The board polls every five seconds and a kitchen screen is never
   * closed, so a window captured once at mount would keep last night's
   * tickets on the lane until somebody reloaded the page; recomputing here
   * means the lane empties itself at the shop's midnight, unattended.
   */
  private todayWindow(tenantId: string): { gte: Date; lt: Date } {
    const { from, to } = lastNDaysInTimeZone(1, this.tz(tenantId));
    return { gte: from, lt: to };
  }

  /**
   * D147 — ONE ticket per round, carrying every item of that round.
   *
   * It used to be one ticket per KITCHEN STATION the round's items routed to,
   * so a single order for a single round arrived on the board as several
   * separate cards (RO-000026, one round of 15 lines, became KOT-000027 with
   * 13 of them and KOT-000028 with 2). The split is gone because the routing
   * it rested on was never reachable: the only place to link a dish to a
   * station is the product wizard's Step 3 multi-select, which is
   * branch-scoped and renders EMPTY when no branch is selected, so products
   * are created with no station link at all.
   *
   * WHAT THIS FIXES, and it is worse than the duplicate cards: the old
   * routing DROPPED an item with no station link unless the branch happened
   * to have exactly one active station (the D67 fallback). The affected
   * branch has four, so an unlinked dish reached the kitchen board on NO
   * ticket whatsoever — ordered, billed, and never cooked. Every item of the
   * round is now on the one ticket, so there is nothing left to drop.
   *
   * The station catalogue and both link junctions (MenuItemStationLink,
   * ProductStationLink) stay in the schema and in the wizard; they simply no
   * longer influence what the kitchen receives.
   *
   * Returns the new ticket's id, or null for a round with no items — a round
   * with nothing on it must not burn a KOT number or put an empty card on the
   * pass.
   */
  async generateTicketForRound(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    roundId: string,
  ): Promise<string | null> {
    const items = await tx.restaurantOrderItem.findMany({
      where: { tenantId, roundId },
      /*
       * The round's own order — the sequence the waiter keyed the lines in is
       * the sequence the kitchen reads them in. `createdAt` alone cannot give
       * it: a round's items are all written inside ONE transaction, so
       * Postgres stamps every one of them with the same instant. The id
       * tiebreak restores the insertion order (a cuid's timestamp+counter
       * prefix increments per row) and, more importantly, makes the order
       * TOTAL — without it two lines could swap places between two reads.
       */
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        menuItemName: true,
        quantity: true,
        specialInstructions: true,
        // D46 — the operator-selected variant, snapshotted at submit.
        variantNameSnapshot: true,
        modifiers: { select: { optionName: true } },
      },
    });
    if (items.length === 0) return null;

    // One document number for the round, not one per station.
    const seq = await nextDocumentNumber(tx, tenantId, 'RESTAURANT_ORDER');
    const ticketNumber = `KOT-${padSequence(seq)}`;
    const ticket = await tx.kitchenTicket.create({
      data: {
        tenantId,
        branchId,
        roundId,
        // D147 — written explicitly rather than left to the column default,
        // because "this ticket belongs to no station" is the claim being
        // made, not an omission.
        stationId: null,
        ticketNumber,
        status: KitchenTicketStatus.QUEUED,
      },
    });
    for (const item of items) {
      await tx.kitchenTicketItem.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          menuItemName: item.menuItemName,
          // D46 — print the variant selection ("MEDIUM", "LARGE") on
          // the KOT verbatim from the round-item snapshot. NULL when
          // the round item has no variant (a MENU_ITEM row or a
          // non-variant Product); the kitchen must not infer the
          // variant from selling price.
          variantName: item.variantNameSnapshot,
          quantity: item.quantity,
          modifierNames: item.modifiers.map((m) => m.optionName),
          specialInstructions: item.specialInstructions,
        },
      });
    }
    return ticket.id;
  }

  /**
   * D68 — the board's read. `OUTSTANDING` is a filter, not a status: it means
   * "not COMPLETED", so a ticket left on one of the retired print statuses by
   * a pre-D68 round still shows as work to do rather than silently
   * disappearing from the pass.
   *
   * D115 — cancellation lives on the ORDER side (a cancelled takeaway
   * profile, or a round/order cancelled outright — tickets themselves have
   * no such status), and until now it never reached this read: the kitchen
   * kept cooking food nobody was coming for. `OUTSTANDING` and `COMPLETED`
   * now exclude cancelled work, and the `CANCELLED` pseudo-filter collects
   * it (any ticket status, newest first) so the pass can SEE what was
   * called off rather than having it vanish mid-cook.
   *
   * D142 — `COMPLETED_TODAY` is the third pseudo-filter, and it is what the
   * board's Done lane asks for now: the same set as `COMPLETED`, cut to the
   * shop's calendar day. `COMPLETED` itself is UNCHANGED — the KDS route, a
   * bookmarked query and the history screen all still mean "every ticket ever
   * bumped" by it. Widening the lane's meaning in place would have left the
   * integration assertions green while they stopped proving anything, because
   * their tickets are completed seconds before they are read (D30).
   *
   * D142b — extracted from the list so the lane COUNTS are counted over
   * exactly the rows the lane lists. Two copies of "what is outstanding" is
   * how a chip comes to promise three tickets the list does not have.
   */
  private whereForFilter(
    tenantId: string,
    branchId: string,
    filter?: KitchenTicketStatus | 'OUTSTANDING' | 'CANCELLED' | 'COMPLETED_TODAY',
  ): Prisma.KitchenTicketWhereInput {
    /*
     * "This ticket's work was called off", spelled from the ticket's point
     * of view. Only the takeaway path writes a cancellation today; the
     * round/order clauses are the same claim at the levels a future cancel
     * verb will write, so this read will not need to change again.
     */
    const cancelledWork: Prisma.KitchenTicketWhereInput = {
      OR: [
        { round: { status: OrderRoundStatus.CANCELLED } },
        { round: { order: { status: 'CANCELLED' } } },
        { round: { order: { takeawayProfile: { status: TakeawayOrderStatus.CANCELLED } } } },
      ],
    };
    const notCancelled: Prisma.KitchenTicketWhereInput = {
      round: {
        status: { not: OrderRoundStatus.CANCELLED },
        order: {
          status: { not: 'CANCELLED' },
          OR: [
            { takeawayProfile: null },
            { takeawayProfile: { status: { not: TakeawayOrderStatus.CANCELLED } } },
          ],
        },
      },
    };

    const where: Prisma.KitchenTicketWhereInput =
      filter === 'OUTSTANDING'
        ? {
            tenantId,
            branchId,
            status: { not: KitchenTicketStatus.COMPLETED },
            ...notCancelled,
          }
        : filter === 'CANCELLED'
          ? { tenantId, branchId, ...cancelledWork }
          : filter === 'COMPLETED_TODAY'
            ? {
                tenantId,
                branchId,
                status: KitchenTicketStatus.COMPLETED,
                completedAt: this.todayWindow(tenantId),
                ...notCancelled,
              }
            : filter === KitchenTicketStatus.COMPLETED
              ? { tenantId, branchId, status: filter, ...notCancelled }
              : { tenantId, branchId, ...(filter ? { status: filter } : {}) };
    return where;
  }

  /**
   * D68/D115/D142 — the board's read, one lane at a time.
   */
  async listTicketsForBranch(
    tenantId: string,
    branchId: string,
    filter?: KitchenTicketStatus | 'OUTSTANDING' | 'CANCELLED' | 'COMPLETED_TODAY',
  ): Promise<KitchenTicketView[]> {
    const where = this.whereForFilter(tenantId, branchId, filter);

    const rows = await this.prisma.kitchenTicket.findMany({
      where,
      /*
       * Oldest first while outstanding: a kitchen works a queue, and the dish
       * that has been waiting longest is the one that goes next.
       *
       * Done and Cancelled read newest first — they answer "what just
       * happened", not "what is next". D142: the day-scoped lane sorts by when
       * the food was FINISHED, because that is now what the lane is about; a
       * ticket raised at 11:00 and bumped at 14:00 belongs above one raised at
       * 13:00 and bumped at 13:30, which sorting by `createdAt` got backwards.
       * The unscoped COMPLETED list keeps `createdAt` so nothing that reads it
       * today changes underneath.
       */
      orderBy:
        filter === 'COMPLETED_TODAY'
          ? [{ completedAt: 'desc' as const }, { id: 'desc' as const }]
          : {
              createdAt:
                filter === KitchenTicketStatus.COMPLETED || filter === 'CANCELLED'
                  ? ('desc' as const)
                  : ('asc' as const),
            },
      include: TICKET_INCLUDE,
    });
    const waiters = await this.waiterNames(rows);
    return rows.map((row) => toView(row, waiters));
  }

  /**
   * D142b — the three lane counts in one round trip.
   *
   * `To make` and `Preparing` are the client's split of the OUTSTANDING lane
   * (not started / started), so they are counted the same way here: the
   * outstanding `where`, narrowed by status. `Done` is the day-scoped lane.
   * Three counts in one transaction, so the numbers are consistent with each
   * other as well as with the lists — a ticket bumped between two separate
   * queries would otherwise be counted twice or not at all.
   */
  async laneCountsForBranch(tenantId: string, branchId: string): Promise<KitchenLaneCounts> {
    const outstanding = this.whereForFilter(tenantId, branchId, 'OUTSTANDING');
    const [toMake, preparing, doneToday] = await this.prisma.$transaction([
      this.prisma.kitchenTicket.count({
        where: {
          ...outstanding,
          // Narrower than the lane's own `not: COMPLETED`, and it replaces it:
          // "to make" is everything outstanding that nobody has started.
          status: {
            notIn: [KitchenTicketStatus.COMPLETED, KitchenTicketStatus.IN_PROGRESS],
          },
        },
      }),
      this.prisma.kitchenTicket.count({
        where: { ...outstanding, status: KitchenTicketStatus.IN_PROGRESS },
      }),
      this.prisma.kitchenTicket.count({
        where: this.whereForFilter(tenantId, branchId, 'COMPLETED_TODAY'),
      }),
    ]);
    return { toMake, preparing, doneToday };
  }

  /**
   * D142 — every ticket the branch has ever bumped, newest first.
   *
   * The board's Done lane answers "what did we finish today"; this answers
   * "when did we finish that, and who was on it" — a different question, asked
   * days or weeks later, over a set that only grows. So it pages in SQL and
   * searches in SQL rather than handing the pass a list that reaches a
   * thousand rows and stops being scrollable.
   *
   * TODAY'S TICKETS ARE IN IT. The lane and this list overlap deliberately:
   * splitting them by date would make "the ticket I bumped an hour ago"
   * findable in neither place once the lane scrolled, which is the failure the
   * screen exists to prevent.
   *
   * Cancelled work is excluded on the same reasoning as `COMPLETED` (D115):
   * it has its own lane on the board, and a history of what the kitchen
   * COOKED should not be padded with what it was told to stop cooking.
   */
  async listHistoryForBranch(
    tenantId: string,
    branchId: string,
    query: { page: number; pageSize: number; skip: number; take: number; search?: string },
  ): Promise<Paginated<KitchenTicketView>> {
    const search = query.search?.trim() || undefined;
    const where: Prisma.KitchenTicketWhereInput = {
      tenantId,
      branchId,
      status: KitchenTicketStatus.COMPLETED,
      round: {
        status: { not: OrderRoundStatus.CANCELLED },
        order: {
          status: { not: 'CANCELLED' },
          OR: [
            { takeawayProfile: null },
            { takeawayProfile: { status: { not: TakeawayOrderStatus.CANCELLED } } },
          ],
        },
      },
      /*
       * The four things a person actually remembers about a ticket: its own
       * number, the order it belonged to, where it was going, and what was on
       * it. Searching the dish name matters most — "which table had the
       * lamprais that came back" is the question this screen gets asked, and
       * no ticket number is remembered alongside it.
       */
      ...(search
        ? {
            OR: [
              { ticketNumber: { contains: search, mode: 'insensitive' } },
              { round: { order: { orderNumber: { contains: search, mode: 'insensitive' } } } },
              {
                round: {
                  order: {
                    session: {
                      OR: [
                        { tabName: { contains: search, mode: 'insensitive' } },
                        { table: { code: { contains: search, mode: 'insensitive' } } },
                        { table: { area: { name: { contains: search, mode: 'insensitive' } } } },
                      ],
                    },
                  },
                },
              },
              { items: { some: { menuItemName: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.kitchenTicket.findMany({
        where,
        /*
         * By when the food was DONE, not when the ticket was raised: this list
         * is read as a record of service, and a ticket raised early and bumped
         * late belongs where the kitchen finished it. `completedAt` is never
         * null on a COMPLETED row — `completeTicket` writes both in one update
         * and `reopenTicket` clears both — but the id tiebreak keeps the order
         * total anyway, so a page boundary can never repeat or skip a row.
         */
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.take,
        include: TICKET_INCLUDE,
      }),
      this.prisma.kitchenTicket.count({ where }),
    ]);
    const waiters = await this.waiterNames(rows);
    return paginate(
      rows.map((row) => toView(row, waiters)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /**
   * `TableSession.waiterUserId` carries no relation (it is a plain column),
   * so the names are one extra query for the whole page rather than an
   * include — and never one query per ticket.
   */
  private async waiterNames(
    rows: { round: { order: { session: { waiterUserId: string | null } | null } | null } | null }[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .map((r) => r.round?.order?.session?.waiterUserId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /**
   * D83 — the whole order behind one ticket.
   *
   * A ticket carries only ITS OWN ROUND, which is right for making the food
   * and wrong for timing it: the pass cannot tell whether it is plating alone
   * or alongside a starter that went in twenty minutes ago. This returns
   * every non-voided item on the order, labelled with the round it came in
   * on, so the pass can see the table as the guests will.
   *
   * D147 narrowed what this adds, and did not remove it: a ticket is now the
   * whole ROUND rather than one station's slice of it, so the extra a reader
   * gets here is the order's OTHER rounds. The per-item station annotation is
   * gone with the split — a ticket belongs to no station to annotate from.
   *
   * Read-only and KOT_VIEW gated, like the board itself. Deliberately NOT
   * routed through the table-session read: that one is scoped to the waiter
   * who owns the table (D70), and the kitchen owns no tables.
   */
  async orderForTicket(
    tenantId: string,
    branchId: string,
    ticketId: string,
  ): Promise<KitchenOrderView> {
    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id: ticketId, tenantId, branchId },
      select: { id: true, ticketNumber: true, roundId: true },
    });
    if (!ticket) throw new KitchenTicketNotFoundError();

    const round = await this.prisma.orderRound.findFirst({
      where: { id: ticket.roundId },
      select: { orderId: true },
    });
    if (!round) throw new KitchenTicketNotFoundError();

    const order = await this.prisma.restaurantOrder.findFirstOrThrow({
      where: { id: round.orderId, tenantId },
      select: {
        orderNumber: true,
        createdAt: true,
        session: {
          select: {
            waiterUserId: true,
            // D104 — two parties can share one arrangement, so the tab's name
            // is what keeps their tickets apart on the pass.
            tabName: true,
            table: { select: { code: true, area: { select: { name: true } } } },
          },
        },
        items: {
          where: { status: { not: RestaurantOrderItemStatus.VOIDED } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            menuItemName: true,
            variantNameSnapshot: true,
            quantity: true,
            specialInstructions: true,
            modifiers: { select: { optionName: true } },
            round: { select: { roundNumber: true } },
          },
        },
      },
    });

    const table = order.session?.table;
    const waiter = order.session?.waiterUserId
      ? await this.prisma.user.findUnique({
          where: { id: order.session.waiterUserId },
          select: { name: true },
        })
      : null;

    return {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      orderNumber: order.orderNumber,
      placeLabel: withTabName(
        table
          ? table.code === 'WALK-IN'
            ? 'Takeaway'
            : `${table.code}${table.area?.name ? ` \u00b7 ${table.area.name}` : ''}`
          : null,
        order.session?.tabName ?? null,
      ),
      waiterName: waiter?.name ?? null,
      placedAt: order.createdAt.toISOString(),
      items: order.items.map((item) => ({
        id: item.id,
        name: item.menuItemName,
        variantName: item.variantNameSnapshot,
        quantity: item.quantity.toFixed(3),
        modifierNames: item.modifiers.map((m) => m.optionName),
        specialInstructions: item.specialInstructions,
        roundNumber: item.round?.roundNumber ?? null,
      })),
    };
  }

  /**
   * D113 — the cook takes a ticket: QUEUED (or a retired print status) →
   * IN_PROGRESS, the KDS "Preparing" state every mainstream board has
   * between "new" and "bumped".
   *
   * Idempotent both ways, in the D68/D100 house style: starting a ticket
   * already in progress returns it unchanged, and starting a COMPLETED
   * ticket is a stale tap on a card that moved — also returned unchanged,
   * never un-completed (Recall is the verb for that, deliberately).
   */
  async startTicket(
    tenantId: string,
    branchId: string,
    ticketId: string,
  ): Promise<KitchenTicketView> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.kitchenTicket.findFirst({
        where: { id: ticketId, tenantId, branchId },
        select: { id: true, status: true, roundId: true },
      });
      if (!ticket) throw new KitchenTicketNotFoundError();

      if (
        ticket.status !== KitchenTicketStatus.COMPLETED &&
        ticket.status !== KitchenTicketStatus.IN_PROGRESS
      ) {
        await tx.kitchenTicket.update({
          where: { id: ticket.id },
          data: { status: KitchenTicketStatus.IN_PROGRESS },
        });
        await this.syncKitchenProgress(tx, ticket.roundId);
      }

      const full = await tx.kitchenTicket.findFirstOrThrow({
        where: { id: ticketId, tenantId },
        include: TICKET_INCLUDE,
      });
      return toView(full, await this.waiterNames([full]));
    });
  }

  /**
   * D68 — kitchen staff marking the food done.
   *
   * Idempotent: completing an already-completed ticket returns it unchanged
   * rather than rewriting who finished it. A busy pass double-taps, and the
   * second tap must not overwrite the first person's name on the record.
   */
  async completeTicket(
    tenantId: string,
    branchId: string,
    ticketId: string,
    actorUserId: string,
  ): Promise<KitchenTicketView> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.kitchenTicket.findFirst({
        where: { id: ticketId, tenantId, branchId },
        select: { id: true, status: true, roundId: true },
      });
      if (!ticket) throw new KitchenTicketNotFoundError();

      if (ticket.status !== KitchenTicketStatus.COMPLETED) {
        await tx.kitchenTicket.update({
          where: { id: ticket.id },
          data: {
            status: KitchenTicketStatus.COMPLETED,
            completedAt: new Date(),
            completedByUserId: actorUserId,
          },
        });
        await this.syncKitchenProgress(tx, ticket.roundId);
      }

      const full = await tx.kitchenTicket.findFirstOrThrow({
        where: { id: ticketId, tenantId },
        include: TICKET_INCLUDE,
      });
      return toView(full, await this.waiterNames([full]));
    });
  }

  /**
   * D100 — recall: pulling a bumped ticket back onto the pass.
   *
   * The bump control is optimistic and finger-sized; on a busy pass some
   * completions are simply wrong, and until now the only remedy was food
   * that existed on no screen. Reopening clears the completion record
   * entirely — a recalled ticket is work to do again, and a stale "done by"
   * name would say otherwise. Mirrors completeTicket's idempotency in the
   * other direction: recalling a ticket that was never completed returns it
   * unchanged.
   */
  async reopenTicket(
    tenantId: string,
    branchId: string,
    ticketId: string,
  ): Promise<KitchenTicketView> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.kitchenTicket.findFirst({
        where: { id: ticketId, tenantId, branchId },
        select: { id: true, status: true, roundId: true },
      });
      if (!ticket) throw new KitchenTicketNotFoundError();

      if (ticket.status === KitchenTicketStatus.COMPLETED) {
        await tx.kitchenTicket.update({
          where: { id: ticket.id },
          data: {
            status: KitchenTicketStatus.QUEUED,
            completedAt: null,
            completedByUserId: null,
          },
        });
        await this.syncKitchenProgress(tx, ticket.roundId);
      }

      const full = await tx.kitchenTicket.findFirstOrThrow({
        where: { id: ticketId, tenantId },
        include: TICKET_INCLUDE,
      });
      return toView(full, await this.waiterNames([full]));
    });
  }

  /**
   * D113 — after any ticket status change, restate what the tickets now say
   * onto the round and (for takeaway) the customer-facing profile, so the
   * Orders queue and the takeaway board move the moment the kitchen does —
   * the way mainstream KDS products drive order status from the bump bar.
   *
   * Both derivations are RESTATEMENTS, not steps: computed from the full
   * ticket set every time, so start/complete/recall in any order land on the
   * truth. The round moves freely among SUBMITTED/IN_PROGRESS/READY (a
   * recall genuinely un-readies it) but DELIVERED and CANCELLED are floor
   * verdicts the kitchen must not touch. The takeaway profile only moves
   * FORWARD along PLACED→IN_KITCHEN→READY — never backward past what the
   * cashier already told the customer — with ONE exception: READY falls back
   * to IN_KITCHEN when the kitchen recalls a dish, because "your food is
   * ready" has stopped being true. HANDED_OVER and CANCELLED are money/
   * cashier states and are never touched (handover settles the Sale).
   */
  private async syncKitchenProgress(tx: Prisma.TransactionClient, roundId: string): Promise<void> {
    const round = await tx.orderRound.findUnique({
      where: { id: roundId },
      select: {
        id: true,
        status: true,
        orderId: true,
        order: { select: { takeawayProfile: { select: { id: true, status: true } } } },
      },
    });
    if (!round) return; // ticket without a live round: nothing to restate

    const KITCHEN_OWNED: OrderRoundStatus[] = [
      OrderRoundStatus.SUBMITTED,
      OrderRoundStatus.IN_PROGRESS,
      OrderRoundStatus.READY,
    ];
    if (KITCHEN_OWNED.includes(round.status)) {
      const statuses = (
        await tx.kitchenTicket.findMany({ where: { roundId }, select: { status: true } })
      ).map((t) => t.status);
      const next =
        statuses.length > 0 && statuses.every((s) => s === KitchenTicketStatus.COMPLETED)
          ? OrderRoundStatus.READY
          : statuses.some(
                (s) => s === KitchenTicketStatus.IN_PROGRESS || s === KitchenTicketStatus.COMPLETED,
              )
            ? OrderRoundStatus.IN_PROGRESS
            : OrderRoundStatus.SUBMITTED;
      if (next !== round.status) {
        await tx.orderRound.update({ where: { id: round.id }, data: { status: next } });
      }
    }

    const profile = round.order.takeawayProfile;
    if (
      profile &&
      (profile.status === TakeawayOrderStatus.PLACED ||
        profile.status === TakeawayOrderStatus.IN_KITCHEN ||
        profile.status === TakeawayOrderStatus.READY)
    ) {
      // The profile reflects the ORDER's whole kitchen state, not one round's.
      const orderStatuses = (
        await tx.kitchenTicket.findMany({
          where: { round: { orderId: round.orderId } },
          select: { status: true },
        })
      ).map((t) => t.status);
      const derived =
        orderStatuses.length > 0 &&
        orderStatuses.every((s) => s === KitchenTicketStatus.COMPLETED)
          ? TakeawayOrderStatus.READY
          : orderStatuses.some(
                (s) => s === KitchenTicketStatus.IN_PROGRESS || s === KitchenTicketStatus.COMPLETED,
              )
            ? TakeawayOrderStatus.IN_KITCHEN
            : TakeawayOrderStatus.PLACED;
      const rank: Record<'PLACED' | 'IN_KITCHEN' | 'READY', number> = {
        PLACED: 0,
        IN_KITCHEN: 1,
        READY: 2,
      };
      const forward = rank[derived] > rank[profile.status as 'PLACED' | 'IN_KITCHEN' | 'READY'];
      const readyRetracted =
        profile.status === TakeawayOrderStatus.READY && derived !== TakeawayOrderStatus.READY;
      if (forward || readyRetracted) {
        await tx.takeawayOrderProfile.update({
          where: { id: profile.id },
          // A retracted READY lands on IN_KITCHEN even if nothing has started
          // again yet — the customer was told "being prepared", and PLACED
          // would read as the order going backwards past what was said.
          data: { status: readyRetracted ? TakeawayOrderStatus.IN_KITCHEN : derived },
        });
      }
    }
  }
}

/** Thrown for a ticket that is not this tenant's, or not in this branch. */
export class KitchenTicketNotFoundError extends Error {
  constructor() {
    super('Kitchen ticket not found');
  }
}

/*
 * One include, used by every read, so the board and the completion response
 * are the SAME shape — a ticket that gained a field in one and not the other
 * is how a screen ends up rendering `undefined` after an action.
 */
const TICKET_INCLUDE = {
  items: true,
  // D147 — no `station`: a ticket cut since the split was removed belongs to
  // none, and the board, the history table and the ticket dialog have all
  // stopped naming one.
  completedBy: { select: { name: true } },
  round: {
    select: {
      roundNumber: true,
      order: {
        select: {
          orderNumber: true,
          session: {
            select: {
              waiterUserId: true,
              // D104 — see the ticket-detail query above.
              tabName: true,
              table: { select: { code: true, area: { select: { name: true } } } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.KitchenTicketInclude;

function toView(
  row: Prisma.KitchenTicketGetPayload<{ include: typeof TICKET_INCLUDE }>,
  waiterNames: Map<string, string>,
): KitchenTicketView {
  const session = row.round?.order?.session;
  const table = session?.table;
  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    branchId: row.branchId,
    roundId: row.roundId,
    stationId: row.stationId,
    status: row.status,
    orderNumber: row.round?.order?.orderNumber ?? null,
    // The synthetic walk-in table backs every counter and takeaway order;
    // the pass wants to read "Takeaway", not a table code nobody can find.
    placeLabel: withTabName(
      table
        ? table.code === 'WALK-IN'
          ? 'Takeaway'
          : `${table.code}${table.area?.name ? ` \u00b7 ${table.area.name}` : ''}`
        : null,
      session?.tabName ?? null,
    ),
    roundNumber: row.round?.roundNumber ?? null,
    waiterName: session?.waiterUserId ? waiterNames.get(session.waiterUserId) ?? null : null,
    items: row.items.map((i) => ({
      id: i.id,
      menuItemName: i.menuItemName,
      variantName: i.variantName,
      quantity: i.quantity.toFixed(3),
      modifierNames: i.modifierNames,
      specialInstructions: i.specialInstructions,
    })),
    completedAt: row.completedAt?.toISOString() ?? null,
    completedByName: row.completedBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
