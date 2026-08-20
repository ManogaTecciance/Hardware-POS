import { Injectable, Logger } from '@nestjs/common';
import {
  KitchenPrintAttemptStatus,
  KitchenTicketStatus,
  Prisma,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { resolveKitchenPrinterIdForUser } from '../printing/printing.service';
import { nextDocumentNumber, padSequence } from '../../common/document-sequence';

export interface KitchenTicketView {
  id: string;
  ticketNumber: string;
  branchId: string;
  roundId: string;
  stationId: string;
  primaryPrinterId: string | null;
  status: KitchenTicketStatus;
  items: {
    id: string;
    menuItemName: string;
    /**
     * D46 — variant selection printed on the KOT ("MEDIUM", "LARGE").
     * NULL for legacy MENU_ITEM rows and for non-variant Products.
     */
    variantName: string | null;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
  }[];
  attempts: {
    id: string;
    printerId: string;
    status: KitchenPrintAttemptStatus;
    error: string | null;
    attemptedAt: string;
    completedAt: string | null;
  }[];
  createdAt: string;
}

/**
 * Phase 6. Kitchen ticket generation and print-queue tracking.
 *
 * Called from `TableSessionsService.submitRound` (Phase 5) after the round
 * itself has been committed. Failure here does NOT rollback the round —
 * scenario 20 requires that the order stays recorded even if printing
 * fails.
 */
@Injectable()
export class KitchenService {
  private readonly logger = new Logger(KitchenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate one KOT per unique station referenced by the round's items.
   * The service is called INSIDE the round's transaction so a KOT and its
   * items are visible together; the actual print attempts (which may hit a
   * network printer) are queued as PENDING rows and are not driven here.
   */
  async generateTicketsForRound(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    roundId: string,
    /**
     * D67 — who submitted the round. When that user has picked their own
     * kitchen printer, the tickets print there instead of on the station's
     * printers (see `resolveKitchenPrinterIdForUser`). Optional so existing
     * callers and tests are unaffected.
     */
    actorUserId?: string | null,
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
          `print — link them to a station in Settings → Printing (${unrouted.join(', ')})`,
      );
    }

    /*
     * D67 — the printer this round's tickets go to, in precedence order:
     *   1. the acting user's own default (their tablet, their printer);
     *   2. the station's configured printers (a shop that routes grill vs
     *      bar means it, and that routing is per-item, not per-person);
     *   3. the branch's default kitchen printer (the owner's one-time
     *      workspace setting, so a user who picked nothing still prints).
     * The user's choice REPLACES the station list rather than adding to it —
     * printing the same ticket twice is a duplicate, not redundancy.
     */
    const userPrinterId = await resolveKitchenPrinterIdForUser(tx, actorUserId ?? null);
    const branchConfig = await tx.restaurantBranchConfig.findUnique({
      where: { branchId },
      select: { defaultKitchenPrinterId: true },
    });
    const fallbackPrinterId = userPrinterId ?? branchConfig?.defaultKitchenPrinterId ?? null;
    const fallbackPrinter = fallbackPrinterId
      ? await tx.kitchenPrinter.findFirst({
          where: { id: fallbackPrinterId, tenantId, isActive: true },
          select: { id: true },
        })
      : null;
    const userPrinter = userPrinterId && fallbackPrinter?.id === userPrinterId ? fallbackPrinter : null;

    const ticketIds: string[] = [];
    for (const [stationId, stationItems] of perStation) {
      /*
       * Printer targets for this ticket: the user's own choice when they
       * have one, else the station's configured printers (primary first).
       * A user preference REPLACES the station list rather than adding to
       * it — printing the same ticket on both is a duplicate, not
       * redundancy.
       */
      const linked = userPrinter
        ? [{ printerId: userPrinter.id, isPrimary: true }]
        : await tx.kitchenStationPrinter.findMany({
            where: { stationId },
            orderBy: { isPrimary: 'desc' },
            select: { printerId: true, isPrimary: true },
          });
      // Nothing linked and no personal choice → the branch default, if the
      // owner set one. Empty means the ticket is queued with no attempt:
      // it shows on the KDS and can be printed by hand, which is strictly
      // better than inventing a target.
      const stationPrinters =
        linked.length > 0
          ? linked
          : fallbackPrinter
            ? [{ printerId: fallbackPrinter.id, isPrimary: true }]
            : [];
      const primaryPrinterId = stationPrinters[0]?.printerId ?? null;

      const seq = await nextDocumentNumber(tx, tenantId, 'RESTAURANT_ORDER');
      const ticketNumber = `KOT-${padSequence(seq)}`;
      const ticket = await tx.kitchenTicket.create({
        data: {
          tenantId,
          branchId,
          roundId,
          stationId,
          primaryPrinterId,
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
      // Queue a PENDING attempt for every configured printer on the station.
      // The redundancy pair (D6) means the same ticket lands on the primary
      // and any secondary; whichever prints first flips the ticket status.
      for (const sp of stationPrinters) {
        await tx.kitchenPrintAttempt.create({
          data: {
            tenantId,
            ticketId: ticket.id,
            printerId: sp.printerId,
          },
        });
      }
      ticketIds.push(ticket.id);
    }
    return ticketIds;
  }

  async listTicketsForBranch(
    tenantId: string,
    branchId: string,
    status?: KitchenTicketStatus,
  ): Promise<KitchenTicketView[]> {
    const rows = await this.prisma.kitchenTicket.findMany({
      where: { tenantId, branchId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { items: true, attempts: true },
    });
    return rows.map(this.toView);
  }

  /**
   * Mark a ticket as printed on the given printer. Idempotent — a second
   * mark-printed for the same attempt is a no-op.
   */
  async markPrinted(
    tenantId: string,
    ticketId: string,
    printerId: string,
  ): Promise<KitchenTicketView> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.kitchenPrintAttempt.findFirst({
        where: {
          tenantId,
          ticketId,
          printerId,
          status: { not: KitchenPrintAttemptStatus.SUCCEEDED },
        },
        orderBy: { attemptedAt: 'desc' },
      });
      if (attempt) {
        await tx.kitchenPrintAttempt.update({
          where: { id: attempt.id },
          data: {
            status: KitchenPrintAttemptStatus.SUCCEEDED,
            completedAt: new Date(),
          },
        });
      }
      // Ticket transitions on any successful attempt.
      await tx.kitchenTicket.update({
        where: { id: ticketId },
        data: { status: KitchenTicketStatus.PRINTED },
      });
      const full = await tx.kitchenTicket.findFirstOrThrow({
        where: { id: ticketId, tenantId },
        include: { items: true, attempts: true },
      });
      return this.toView(full);
    });
  }

  /**
   * Record a printer failure. If retries remain, the caller re-queues; the
   * ticket is only marked FAILED when every printer has exhausted its
   * attempts (that policy lives with whichever process drives the queue,
   * which is out of scope for the API).
   */
  async markFailed(
    tenantId: string,
    ticketId: string,
    printerId: string,
    error: string,
  ): Promise<KitchenTicketView> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.kitchenPrintAttempt.findFirst({
        where: { tenantId, ticketId, printerId, status: KitchenPrintAttemptStatus.PENDING },
      });
      if (attempt) {
        await tx.kitchenPrintAttempt.update({
          where: { id: attempt.id },
          data: {
            status: KitchenPrintAttemptStatus.FAILED,
            error,
            completedAt: new Date(),
          },
        });
      }
      const full = await tx.kitchenTicket.findFirstOrThrow({
        where: { id: ticketId, tenantId },
        include: { items: true, attempts: true },
      });
      return this.toView(full);
    });
  }

  private toView(
    row: Prisma.KitchenTicketGetPayload<{ include: { items: true; attempts: true } }>,
  ): KitchenTicketView {
    return {
      id: row.id,
      ticketNumber: row.ticketNumber,
      branchId: row.branchId,
      roundId: row.roundId,
      stationId: row.stationId,
      primaryPrinterId: row.primaryPrinterId,
      status: row.status,
      items: row.items.map((i) => ({
        id: i.id,
        menuItemName: i.menuItemName,
        variantName: i.variantName,
        quantity: i.quantity.toFixed(3),
        modifierNames: i.modifierNames,
        specialInstructions: i.specialInstructions,
      })),
      attempts: row.attempts.map((a) => ({
        id: a.id,
        printerId: a.printerId,
        status: a.status,
        error: a.error,
        attemptedAt: a.attemptedAt.toISOString(),
        completedAt: a.completedAt?.toISOString() ?? null,
      })),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
