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

/*
 * D152 — the station every unlinked item routes to, per branch.
 *
 * Named here rather than inline because three things have to agree on it: the
 * upsert below, the seed, and the specs that prove an unlinked item reaches
 * it. `MAIN` is the `code` — `@@unique([branchId, code])` is what makes the
 * upsert safe — and 'Main' is only the name it is BORN with; an operator may
 * rename it, and the code is what identifies it afterwards.
 */
export const MAIN_STATION_CODE = 'MAIN';
export const MAIN_STATION_NAME = 'Main';
export const MAIN_STATION_CATEGORY = 'KITCHEN';

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
    /*
     * D152 — which station received it, back with the split. NULL only for an
     * item whose ticket was cut during the D147 window, when a ticket belonged
     * to no station to annotate from.
     */
    stationName: string | null;
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

/**
 * D154 — what ONE tick of the board reads: the open lane's tickets and all
 * three chips' numbers together.
 *
 * The board polls every five seconds and used to spend TWO requests on each
 * tick — the list, then the counts. Riding the counts along halves that, and
 * the transaction below turns "the cards and the chips agree" from something
 * the timing usually gives us into something the read guarantees.
 *
 * `counts` is the BRANCH's, not the filter's: D142b's rule is that every lane
 * chip carries its number whichever lane is open, so these must not move when
 * `?status=` does.
 *
 * D174 — and the STATION's, when the read is pinned to one. The counts still
 * do not move with `?status=`; they move with `?stationId=`, together with the
 * list, so a chip over a lane showing one station's cards counts that station
 * and not the branch. D152 had blanked the off-lane chips under a station cut
 * rather than show the branch's number there; the PO ruled that every chip
 * carries its number under a station cut too, and that it be the right one.
 */
export interface KitchenTicketListView {
  items: KitchenTicketView[];
  counts: KitchenLaneCounts;
}

export interface KitchenTicketView {
  id: string;
  ticketNumber: string;
  branchId: string;
  roundId: string;
  /*
   * D152 — a REAL station on every ticket written from now on: the split is
   * back, and a ticket is one station's slice of the round.
   *
   * Both fields stay nullable, and the column with them. The tickets cut
   * during the D147 window belong to no station and there is no backfill —
   * inventing one for them would be a claim about where food went that nobody
   * can make — so the screens tolerate null rather than assuming it away.
   */
  stationId: string | null;
  stationName: string | null;
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
   * D152 — ONE TICKET PER STATION the round's items route to. This restores
   * the split D147 removed, and supersedes it.
   *
   * D147's objection was not to the split but to the routing under it: the
   * only place to link a dish to a station was a wizard step that renders
   * empty when no branch is selected, so dishes were created linked to
   * nothing — and an unlinked item at a multi-station branch reached NO
   * ticket at all. Ordered, billed, never cooked. Routing on those links was
   * routing on an accident.
   *
   * Both halves of that objection are gone. The station is CHOSEN when the
   * menu item is created, so a link is the normal case; and every branch has
   * a `MAIN` station that anything still unlinked routes to.
   *
   * NOTHING IS EVER DROPPED. There is no path through this method on which a
   * round item fails to reach a ticket: `mainStationId` is resolved before the
   * grouping and is what an empty link list falls back to, so the target list
   * is never empty and no item can be skipped. This REPLACES D67's
   * `soleStationId`/`unrouted` pair, which routed unlinked items only when the
   * branch happened to have exactly one active station and silently discarded
   * them — with a warning nobody reads — at every branch with two or more.
   *
   * Returns one id per ticket written. Empty for a round with no items: a
   * round with nothing on it must not burn a KOT number or put an empty card
   * on the pass.
   */
  async generateTicketsForRound(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    roundId: string,
  ): Promise<string[]> {
    const items = await tx.restaurantOrderItem.findMany({
      where: { tenantId, roundId },
      /*
       * The round's own order — the sequence the waiter keyed the lines in is
       * the sequence the kitchen reads them in, on each station's ticket.
       * `createdAt` alone cannot give it: a round's items are all written
       * inside ONE transaction, so Postgres stamps every one of them with the
       * same instant. The id tiebreak restores the insertion order (a cuid's
       * timestamp+counter prefix increments per row) and, more importantly,
       * makes the order TOTAL — without it two lines could swap places
       * between two reads.
       */
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        menuItemId: true,
        menuItemName: true,
        quantity: true,
        specialInstructions: true,
        // D60 — the Product is what routing keys off when the line carries
        // one; D46 — the variant snapshot is what the ticket prints.
        productId: true,
        variantNameSnapshot: true,
        modifiers: { select: { optionName: true } },
      },
    });
    if (items.length === 0) return [];

    /*
     * D60 — routing keys off the PRODUCT whenever the line carries one,
     * regardless of sourceKind: the catalogue-convergence backfill stamps
     * `productId` onto MENU_ITEM-sourced lines and copies their station
     * links to `ProductStationLink`, so one junction serves everything. The
     * MenuItemStationLink lookup remains only as the fallback for an
     * unmigrated legacy line (productId null), and dies with the deferred
     * drop.
     */
    const menuItemIds = [
      ...new Set(items.filter((i) => i.productId === null).map((i) => i.menuItemId)),
    ];
    const productIds = [
      ...new Set(
        items
          .filter((i): i is typeof i & { productId: string } => i.productId !== null)
          .map((i) => i.productId),
      ),
    ];
    /*
     * D152 — a link only counts if its station is one THIS branch can cook at.
     *
     * Both junctions are tenant-wide and neither is rewritten when a station
     * changes, so a link can point at a station belonging to another branch,
     * or at one that has since been archived. Left unfiltered, either makes
     * `stationIds` non-empty, so Main never fires and the ticket is written to
     * a station this branch's board cannot select — the chip strip lists only
     * the branch's ACTIVE stations, and a board pinned to a station shows
     * nothing else. The dish would be ordered, billed and never seen: exactly
     * the failure D147 was created to stop, arriving through a different door.
     *
     * Filtering here rather than after the fact is what keeps the no-drop rule
     * structural: a link that does not survive this `where` leaves the item
     * with no station, and the line below sends it to Main like any other
     * unrouted dish.
     */
    const usableStation = { station: { branchId, isActive: true } };
    const [menuItemStationLinks, productStationLinks] = await Promise.all([
      menuItemIds.length
        ? tx.menuItemStationLink.findMany({
            where: { menuItemId: { in: menuItemIds }, ...usableStation },
            select: { menuItemId: true, stationId: true },
          })
        : Promise.resolve([]),
      productIds.length
        ? tx.productStationLink.findMany({
            where: { productId: { in: productIds }, ...usableStation },
            select: { productId: true, stationId: true },
          })
        : Promise.resolve([]),
    ]);
    const stationsByMenuItem = new Map<string, string[]>();
    for (const link of menuItemStationLinks) {
      const list = stationsByMenuItem.get(link.menuItemId) ?? [];
      list.push(link.stationId);
      stationsByMenuItem.set(link.menuItemId, list);
    }
    const stationsByProduct = new Map<string, string[]>();
    for (const link of productStationLinks) {
      const list = stationsByProduct.get(link.productId) ?? [];
      list.push(link.stationId);
      stationsByProduct.set(link.productId, list);
    }

    const mainStationId = await this.resolveMainStation(tx, tenantId, branchId);

    // Aggregate items per station.
    const perStation = new Map<string, typeof items>();
    for (const item of items) {
      // Look up in the junction that matches the item's source (D60).
      const stationIds = item.productId
        ? stationsByProduct.get(item.productId) ?? []
        : stationsByMenuItem.get(item.menuItemId) ?? [];
      /*
       * D152 — Main is the answer whenever the links give none, and the
       * reason this list can never be empty. "No item is dropped" is
       * structural here, not a promise: there is no `continue`, no filter and
       * no conditional between this line and the write below.
       */
      const targets = stationIds.length > 0 ? stationIds : [mainStationId];
      for (const stationId of targets) {
        const list = perStation.get(stationId) ?? [];
        list.push(item);
        perStation.set(stationId, list);
      }
    }

    const ticketIds: string[] = [];
    for (const [stationId, stationItems] of perStation) {
      // One document number PER TICKET: two stations cooking one round are two
      // cards on the pass, and two cards sharing a KOT number cannot be told
      // apart by the people calling them out.
      const seq = await nextDocumentNumber(tx, tenantId, 'RESTAURANT_ORDER');
      const ticketNumber = `KOT-${padSequence(seq)}`;
      const ticket = await tx.kitchenTicket.create({
        data: {
          tenantId,
          branchId,
          roundId,
          stationId,
          ticketNumber,
          status: KitchenTicketStatus.QUEUED,
        },
      });
      for (const item of stationItems) {
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
      ticketIds.push(ticket.id);
    }
    return ticketIds;
  }

  /**
   * D152 — the branch's Main station, created if it is not there.
   *
   * UPSERTED rather than read, because Main must exist wherever a round is
   * submitted and there is no migration that put it in: a tenant provisioned
   * before D152, or one whose seed never ran, has no MAIN row, and a read that
   * came back empty would leave the fallback with nowhere to send an unlinked
   * item — the exact failure D152 exists to end. `@@unique([branchId, code])`
   * is what makes doing this on every submit safe and idempotent.
   *
   * `isActive` is restated on the way through: an archived Main disappears
   * from the board's station filter while still receiving tickets, and Main is
   * the one station in a branch that must never be unreachable. The NAME is
   * deliberately NOT restated — an operator who renames Main to "Hot line"
   * meant it, and this is not the place to argue.
   */
  private async resolveMainStation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<string> {
    const main = await tx.kitchenStation.upsert({
      where: { branchId_code: { branchId, code: MAIN_STATION_CODE } },
      update: { isActive: true },
      create: {
        tenantId,
        branchId,
        code: MAIN_STATION_CODE,
        name: MAIN_STATION_NAME,
        category: MAIN_STATION_CATEGORY,
      },
      select: { id: true },
    });
    return main.id;
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
   *
   * D174 — `stationId` narrows every branch of the ladder to one station's
   * slice, and it is threaded through HERE, on the one `where` both the list
   * and the counts are built from, rather than added to either caller: a
   * station clause on the list alone is precisely the disagreement D174 was
   * raised to end — a chip reading the branch's seven over a lane showing the
   * grill's two.
   */
  private whereForFilter(
    tenantId: string,
    branchId: string,
    filter?: KitchenTicketStatus | 'OUTSTANDING' | 'CANCELLED' | 'COMPLETED_TODAY',
    stationId?: string,
  ): Prisma.KitchenTicketWhereInput {
    /*
     * D174 — the scope every branch below opens with. The station key is
     * spread in only when one was asked for: an explicit `stationId:
     * undefined` is the same query to Prisma but not the same object to the
     * specs that pin the shape, and "omitted is byte-for-byte what it was" is
     * the contract. An empty string counts as omitted for the same reason a
     * blank search does — a client that sent `?stationId=` asked for nothing.
     *
     * A ticket cut during the D147 window carries a null `stationId`.
     * Equality matches nothing null, so such a ticket belongs to NO station's
     * count or list — only to the "All stations" numbers, where the scope is
     * absent. That is the truth about the row, not an oversight: inventing a
     * station for it is the backfill D152 declined to write.
     */
    const scope: Prisma.KitchenTicketWhereInput = {
      tenantId,
      branchId,
      ...(stationId ? { stationId } : {}),
    };
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
            ...scope,
            status: { not: KitchenTicketStatus.COMPLETED },
            ...notCancelled,
          }
        : filter === 'CANCELLED'
          ? { ...scope, ...cancelledWork }
          : filter === 'COMPLETED_TODAY'
            ? {
                ...scope,
                status: KitchenTicketStatus.COMPLETED,
                completedAt: this.todayWindow(tenantId),
                ...notCancelled,
              }
            : filter === KitchenTicketStatus.COMPLETED
              ? { ...scope, status: filter, ...notCancelled }
              : { ...scope, ...(filter ? { status: filter } : {}) };
    return where;
  }

  /**
   * D142b — the three lane counts, as the ONE definition both readers use.
   *
   * `To make` and `Preparing` are the client's split of the OUTSTANDING lane
   * (not started / started), so they are counted the same way here: the
   * outstanding `where`, narrowed by status. `Done` is the day-scoped lane.
   *
   * D154 — extracted so the standalone counts route and the board's list read
   * cannot drift apart. Two copies of "what is preparing" is how a chip comes
   * to promise three tickets the list does not have, and having them written
   * out twice in one file is the shortest road there.
   *
   * Returns the queries UNAWAITED, as a fixed-length tuple, because both
   * callers hand them straight to `$transaction` — a caller that awaited one
   * here would be taking its own snapshot, which is the thing D154 removed.
   *
   * D174 — `stationId` is one more `where` clause on these SAME three
   * queries, not a second set of station-scoped ones beside them. It reaches
   * them through `whereForFilter`, the way the list's own scope does, so the
   * station chips and the station lists are one definition narrowed the same
   * way — which is the only reason a chip can be trusted over a pinned lane.
   */
  private laneCountQueries(
    tenantId: string,
    branchId: string,
    stationId?: string,
  ): [Prisma.PrismaPromise<number>, Prisma.PrismaPromise<number>, Prisma.PrismaPromise<number>] {
    const outstanding = this.whereForFilter(tenantId, branchId, 'OUTSTANDING', stationId);
    return [
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
        where: this.whereForFilter(tenantId, branchId, 'COMPLETED_TODAY', stationId),
      }),
    ];
  }

  /**
   * D68/D115/D142 — the board's read, one lane at a time.
   *
   * D154 — and the three lane counts with it, in ONE transaction.
   *
   * The counts used to be a second request on a second snapshot, five seconds
   * of polling apart from nothing in particular: a ticket bumped between the
   * two reads left the card gone while the chip still counted it, or the card
   * on the pass while the chip had already moved on. One snapshot makes the
   * cards and the numbers agree BY CONSTRUCTION rather than by luck, and it is
   * the half of D154 that is a correctness fix rather than a traffic cut.
   *
   * The counts are the BRANCH's and do not vary with `filter` (D142b): the
   * board shows all three chips whichever lane is open. `waiterNames` still
   * runs afterwards — it needs the rows before it knows which users to read,
   * and user names are not what a ticket snapshot is protecting.
   *
   * D174 — `stationId` scopes the LIST and the COUNTS together, in the same
   * snapshot. The board passes its selected station on every poll, so the
   * three chips read that station's lanes while the cards show that station's
   * slice of the open one; omitted, this read is exactly what it was. The
   * station chips under the lanes are a different question (D152's "where is
   * the work?") and are counted by the client over the whole lane, unchanged.
   */
  async listTicketsForBranch(
    tenantId: string,
    branchId: string,
    filter?: KitchenTicketStatus | 'OUTSTANDING' | 'CANCELLED' | 'COMPLETED_TODAY',
    stationId?: string,
  ): Promise<KitchenTicketListView> {
    const where = this.whereForFilter(tenantId, branchId, filter, stationId);

    const [rows, toMake, preparing, doneToday] = await this.prisma.$transaction([
      this.prisma.kitchenTicket.findMany({
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
      }),
      ...this.laneCountQueries(tenantId, branchId, stationId),
      ],
      /*
       * D154 — REPEATABLE READ, or the promise above is not one.
       *
       * Prisma's batch transaction runs at the connection default, which is
       * Postgres READ COMMITTED, where every statement takes its OWN snapshot.
       * A bump committing between the list and the first count would still be
       * seen by one and not the other — the same disagreement two HTTP reads
       * had, narrowed to microseconds but not removed. One snapshot for all
       * four statements is what makes "the cards and the chips cannot
       * disagree" true rather than merely likely.
       *
       * Free here: four read-only statements against one branch's tickets take
       * no locks and have nothing to serialise against.
       */
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const waiters = await this.waiterNames(rows);
    return {
      items: rows.map((row) => toView(row, waiters)),
      counts: { toMake, preparing, doneToday },
    };
  }

  /**
   * D142b — the three lane counts in one round trip.
   *
   * D154 folded these into the list read so a board tick costs one request,
   * and this route STAYS: it is the cheap read for anything that wants only
   * the numbers, and the board is not the only caller a kitchen ever has.
   * Both paths now share `laneCountQueries`, so "the counts" has exactly one
   * definition — and one transaction, so the three numbers are consistent
   * with each other as well as with the lists. A ticket bumped between two
   * separate queries would otherwise be counted twice or not at all.
   *
   * D174 — the same optional `stationId` the list read takes, so the two
   * exposures of "the counts" stay pinned to each other under a station cut
   * as well as without one.
   */
  async laneCountsForBranch(
    tenantId: string,
    branchId: string,
    stationId?: string,
  ): Promise<KitchenLaneCounts> {
    const [toMake, preparing, doneToday] = await this.prisma.$transaction(
      this.laneCountQueries(tenantId, branchId, stationId),
      /*
       * D174 — the same REPEATABLE READ the list read takes (D154). Under a
       * station cut this route now feeds a chip on the board, so its three
       * numbers have to agree among themselves: at READ COMMITTED each count
       * takes its own snapshot and a bump landing between two of them leaves
       * "To make" and "Done" both claiming the ticket for a tick. Three
       * read-only statements against one branch take no locks, so it is free.
       */
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { toMake, preparing, doneToday };
  }

  /**
   * D142/D150 — every ticket the branch holds, whatever lane it is in.
   *
   * The board's Done lane answers "what did we finish today"; this answers
   * "what has this kitchen had on, when was it finished, and who was on it" —
   * a different question, asked days or weeks later, over a set that only
   * grows. So it pages in SQL and searches in SQL rather than handing the pass
   * a list that reaches a thousand rows and stops being scrollable.
   *
   * TODAY'S TICKETS ARE IN IT. The lane and this list overlap deliberately:
   * splitting them by date would make "the ticket I bumped an hour ago"
   * findable in neither place once the lane scrolled, which is the failure the
   * screen exists to prevent.
   *
   * D150 — AND UNFINISHED TICKETS ARE IN IT. This read narrowed to `COMPLETED`
   * until now, so a ticket that was still To make or Preparing appeared on no
   * row of the history screen at all: the one list in the product that carries
   * no date bound could not be used to find live work. The screen was always
   * built for it — it badges every row with its own status and prints "—" for
   * a null `completedAt` and a missing completer — and this clause was the
   * only thing keeping those rows out.
   *
   * Cancelled work is still excluded, on the same reasoning as `COMPLETED`
   * (D115): it has its own lane on the board, and a history of what the
   * kitchen COOKED should not be padded with what it was told to stop cooking.
   * D150 widened the STATUS filter and nothing else — the round, order and
   * takeaway cancellation clauses below are exactly as they were.
   *
   * D175 — station and table are STRUCTURED filters now, not legs of the
   * search. Each is a set of ids; a ticket matches when its station is in the
   * station set AND its session's table is in the table set, and an empty set
   * is no filter on that axis. Typing "grill" into a box that also matched a
   * dish called "Grilled prawns" was the wrong tool for "what did the grill
   * have on", and a table code is something a person picks off a list, not
   * something they remember the spelling of.
   */
  async listHistoryForBranch(
    tenantId: string,
    branchId: string,
    query: {
      page: number;
      pageSize: number;
      skip: number;
      take: number;
      search?: string;
      stationIds?: string[];
      tableIds?: string[];
    },
  ): Promise<Paginated<KitchenTicketView>> {
    const search = query.search?.trim() || undefined;
    const stationIds = query.stationIds ?? [];
    const tableIds = query.tableIds ?? [];
    const where: Prisma.KitchenTicketWhereInput = {
      tenantId,
      branchId,
      /*
       * D175 — `in` the set, and only when the set has members. An empty `in`
       * is a legal clause that matches NOTHING, so spreading it in
       * unconditionally would turn "no station filter" into "no rows"; the key
       * is absent instead, and the specs pin that absence. A D147-window ticket
       * has a null `stationId` and `IN` never matches null, so it is in no
       * station's filter — the same truth D174 states for the lane counts.
       */
      ...(stationIds.length > 0 ? { stationId: { in: stationIds } } : {}),
      /*
       * D150 — no `status` narrowing, deliberately. Queued, in progress and
       * completed are one list here; the lanes are the BOARD's split of the
       * work in front of the pass, not a division of the kitchen's record.
       */
      round: {
        status: { not: OrderRoundStatus.CANCELLED },
        order: {
          status: { not: 'CANCELLED' },
          OR: [
            { takeawayProfile: null },
            { takeawayProfile: { status: { not: TakeawayOrderStatus.CANCELLED } } },
          ],
          /*
           * D175 — the table filter reaches through the SESSION, which is
           * where a dine-in ticket's table lives; a ticket carries no table of
           * its own. Nested beside the cancellation clauses rather than joined
           * with a second `round:` key, because an object literal keeps only
           * the last of two equal keys and Prisma would never see the first.
           *
           * D175 says a takeaway ticket "has no table" and matches only while
           * the table axis is unfiltered. In the rows it is subtler: a
           * takeaway session sits on the branch's synthetic WALK-IN table, so
           * a non-empty set admits it only if that one table's id is in the
           * set. The clause is deliberately no cleverer than `IN` — a second
           * "is this takeaway?" test here would be a second definition of
           * takeaway beside the cancellation pair above, and whether the
           * walk-in row is ever offered as a chip is the picker's decision.
           */
          ...(tableIds.length > 0 ? { session: { tableId: { in: tableIds } } } : {}),
        },
      },
      /*
       * The three things a person remembers about a ticket and would TYPE:
       * its own number, the order it belonged to, and what was on it.
       * Searching the dish name matters most: "which table had the lamprais
       * that came back" is the question this screen gets asked, and no ticket
       * number is remembered alongside it.
       *
       * D175 — the station-name leg (D152) and the tab/table/area leg are gone
       * from here: both became the structured filters above. Left in, a
       * search for "T4" would have kept matching table T4 beside the picker
       * that now selects it, and the two would have disagreed about what "T4"
       * means the moment a dish name contained it.
       */
      ...(search
        ? {
            OR: [
              { ticketNumber: { contains: search, mode: 'insensitive' } },
              { round: { order: { orderNumber: { contains: search, mode: 'insensitive' } } } },
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
         * late belongs where the kitchen finished it.
         *
         * D150 — an unfinished ticket has NO `completedAt` to sort by, so
         * `nulls: 'first'` decides where it lands rather than leaving it to the
         * engine's default. Live work goes to the TOP rather than being
         * interleaved by when it was raised: the list pages twenty at a time,
         * and a ticket still sitting on the pass, buried three pages back by
         * its raise time, is precisely what this screen was asked to surface.
         * A stuck ticket at the top of the history is useful, not noise.
         *
         * `createdAt` then orders that pending block newest-raised first — the
         * rows share a null sort key and would otherwise come back in whatever
         * order the plan produced — and the id keeps the whole order TOTAL, so
         * a page boundary can never repeat or skip a row.
         */
        orderBy: [
          { completedAt: { sort: 'desc', nulls: 'first' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
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
   * D152 restored the split, and with it the per-item station annotation: a
   * ticket is one station's slice of one round again, so what a reader gains
   * here is both the order's OTHER rounds and the other STATIONS' work on
   * this one. (D147 had removed the annotation, there being no station to
   * annotate from; that is no longer true.)
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

    /*
     * Which station each item went to, read back from the tickets rather
     * than re-derived from the routing links: the links can be edited after
     * the fact, and the ticket is what the kitchen actually received.
     *
     * D152 — a ticket cut during the D147 window carries no station, so it
     * annotates nothing and its items keep the null the view type allows.
     * Borrowing another ticket's name for them would be a claim about where
     * food went that no row in the database supports.
     */
    const tickets = await this.prisma.kitchenTicket.findMany({
      where: { tenantId, round: { orderId: round.orderId } },
      select: { station: { select: { name: true } }, items: { select: { menuItemName: true } } },
    });
    const stationByName = new Map<string, string>();
    for (const t of tickets) {
      if (!t.station) continue;
      for (const item of t.items) stationByName.set(item.menuItemName, t.station.name);
    }

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
        stationName: stationByName.get(item.menuItemName) ?? null,
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
  // D152 — the station is joined again: the board's card ribbon, its station
  // filter, the history table and the ticket dialog all name one. Optional in
  // the schema, so the projection reads it through `?.` — a D147-window ticket
  // joins nothing here and lands as null.
  station: { select: { name: true } },
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
    stationName: row.station?.name ?? null,
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
