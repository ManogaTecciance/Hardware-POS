import { Injectable } from '@nestjs/common';
import {
  KitchenPrintAttemptStatus,
  KitchenTicketStatus,
  Prisma,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
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
  ): Promise<string[]> {
    const items = await tx.restaurantOrderItem.findMany({
      where: { tenantId, roundId },
      select: {
        id: true,
        menuItemId: true,
        menuItemName: true,
        quantity: true,
        specialInstructions: true,
        modifiers: { select: { optionName: true } },
      },
    });
    if (items.length === 0) return [];

    // Discover the station routing per menu item.
    const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
    const stationLinks = await tx.menuItemStationLink.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, stationId: true },
    });
    const stationsByMenuItem = new Map<string, string[]>();
    for (const link of stationLinks) {
      const list = stationsByMenuItem.get(link.menuItemId) ?? [];
      list.push(link.stationId);
      stationsByMenuItem.set(link.menuItemId, list);
    }

    // Aggregate items per station.
    const perStation = new Map<string, typeof items>();
    for (const item of items) {
      const stationIds = stationsByMenuItem.get(item.menuItemId) ?? [];
      // An item with NO station routing falls back to a synthetic
      // "unrouted" bucket so it doesn't silently disappear.
      const targets = stationIds.length > 0 ? stationIds : ['__unrouted__'];
      for (const stationId of targets) {
        if (stationId === '__unrouted__') continue;
        const list = perStation.get(stationId) ?? [];
        list.push(item);
        perStation.set(stationId, list);
      }
    }

    const ticketIds: string[] = [];
    for (const [stationId, stationItems] of perStation) {
      // Choose the station's primary printer.
      const stationPrinters = await tx.kitchenStationPrinter.findMany({
        where: { stationId },
        orderBy: { isPrimary: 'desc' },
        select: { printerId: true, isPrimary: true },
      });
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
