import { Injectable, Logger } from '@nestjs/common';
import { KitchenTicketStatus, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';

export interface KitchenTicketView {
  id: string;
  ticketNumber: string;
  branchId: string;
  roundId: string;
  stationId: string;
  stationName: string;
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
  private readonly logger = new Logger(KitchenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate one ticket per unique station referenced by the round's items.
   */
  async generateTicketsForRound(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    roundId: string,
  ): Promise<string[]> {
    const items = await tx.restaurantOrderItem.findMany({
      where: { tenantId, roundId },
      select: {
        id: true,
        menuItemId: true,
        menuItemName: true,
        quantity: true,
        specialInstructions: true,
        // D46 — source + Product + variant snapshot so the routing lookup
        // reads from the correct junction (MenuItem vs Product) and the
        // printed ticket carries the operator-selected variant verbatim.
        sourceKind: true,
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
    const [menuItemStationLinks, productStationLinks] = await Promise.all([
      menuItemIds.length
        ? tx.menuItemStationLink.findMany({
            where: { menuItemId: { in: menuItemIds } },
            select: { menuItemId: true, stationId: true },
          })
        : Promise.resolve([]),
      productIds.length
        ? tx.productStationLink.findMany({
            where: { productId: { in: productIds } },
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

    /*
     * D67 — the single-station fallback.
     *
     * An item with no station link used to be dropped silently: no ticket,
     * nothing on the pass, and the kitchen never learns the dish was
     * ordered. That is indefensible once tickets print automatically. When
     * the branch has exactly ONE active station there is no routing decision
     * to make, so unrouted items go there. With two or more stations the
     * choice is a real one the operator must configure — guessing would send
     * food to the wrong line — so those items stay unrouted and are logged
     * by name, which is how an operator finds the missing link.
     *
     * D68 keeps this: the consequence of an unrouted item is now a dish
     * missing from the BOARD, which is no less severe than a missing
     * printout.
     */
    const branchStations = await tx.kitchenStation.findMany({
      where: { tenantId, branchId, isActive: true },
      select: { id: true },
    });
    const soleStationId = branchStations.length === 1 ? branchStations[0]!.id : null;

    // Aggregate items per station.
    const perStation = new Map<string, typeof items>();
    const unrouted: string[] = [];
    for (const item of items) {
      // Look up in the junction that matches the item's source.
      const stationIds = item.productId
        ? stationsByProduct.get(item.productId) ?? []
        : stationsByMenuItem.get(item.menuItemId) ?? [];
      const targets =
        stationIds.length > 0 ? stationIds : soleStationId ? [soleStationId] : [];
      if (targets.length === 0) {
        unrouted.push(item.menuItemName);
        continue;
      }
      for (const stationId of targets) {
        const list = perStation.get(stationId) ?? [];
        list.push(item);
        perStation.set(stationId, list);
      }
    }
    if (unrouted.length > 0) {
      this.logger.warn(
        `Round ${roundId}: ${unrouted.length} item(s) reached no kitchen station and will not ` +
          `appear on the kitchen board — link them to a station (${unrouted.join(', ')})`,
      );
    }

    const ticketIds: string[] = [];
    for (const [stationId, stationItems] of perStation) {
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
   * D68 — the board's read. `OUTSTANDING` is a filter, not a status: it means
   * "not COMPLETED", so a ticket left on one of the retired print statuses by
   * a pre-D68 round still shows as work to do rather than silently
   * disappearing from the pass.
   */
  async listTicketsForBranch(
    tenantId: string,
    branchId: string,
    filter?: KitchenTicketStatus | 'OUTSTANDING',
  ): Promise<KitchenTicketView[]> {
    const where: Prisma.KitchenTicketWhereInput =
      filter === 'OUTSTANDING'
        ? { tenantId, branchId, status: { not: KitchenTicketStatus.COMPLETED } }
        : { tenantId, branchId, ...(filter ? { status: filter } : {}) };

    const rows = await this.prisma.kitchenTicket.findMany({
      where,
      // Oldest first while outstanding: a kitchen works a queue, and the
      // dish that has been waiting longest is the one that goes next.
      orderBy: { createdAt: filter === KitchenTicketStatus.COMPLETED ? 'desc' : 'asc' },
      include: TICKET_INCLUDE,
    });
    const waiters = await this.waiterNames(rows);
    return rows.map((row) => toView(row, waiters));
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
        select: { id: true, status: true },
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
      }

      const full = await tx.kitchenTicket.findFirstOrThrow({
        where: { id: ticketId, tenantId },
        include: TICKET_INCLUDE,
      });
      return toView(full, await this.waiterNames([full]));
    });
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
    stationName: row.station.name,
    status: row.status,
    orderNumber: row.round?.order?.orderNumber ?? null,
    // The synthetic walk-in table backs every counter and takeaway order;
    // the pass wants to read "Takeaway", not a table code nobody can find.
    placeLabel: table
      ? table.code === 'WALK-IN'
        ? 'Takeaway'
        : `${table.code}${table.area?.name ? ` \u00b7 ${table.area.name}` : ''}`
      : null,
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
