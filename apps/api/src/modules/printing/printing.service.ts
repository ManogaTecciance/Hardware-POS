import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrintJobStatus, PrintJobType, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { EscPosBuilder } from './escpos';
import { PrintDispatcherService, toTarget } from './print-dispatcher.service';
import { sendToPrinter } from './printer-drivers';

/**
 * D67 — enqueueing side of auto-printing, plus the operator's manual
 * controls (test page, retry).
 *
 * Enqueue methods take the caller's transaction client where one exists, so
 * "the order closed" and "a bill is queued" commit together — a bill job
 * that survived a rolled-back close would print a sale that does not exist.
 */
@Injectable()
export class PrintingService {
  private readonly logger = new Logger(PrintingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: PrintDispatcherService,
  ) {}

  /**
   * Queue the finalised bill for a settled Sale, inside the caller's
   * transaction.
   *
   * Returns silently when the branch has auto-bill off or no cashier printer
   * is resolvable: "nothing to print" is a configuration state, not an
   * error, and must never bubble into the close path (D53).
   */
  async enqueueBillForSale(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      branchId: string;
      saleId: string;
      createdByUserId?: string | null;
    },
  ): Promise<void> {
    try {
      const config = await tx.restaurantBranchConfig.findUnique({
        where: { branchId: input.branchId },
        select: { autoPrintBill: true, billCopies: true, defaultReceiptPrinterId: true },
      });
      if (config && !config.autoPrintBill) return;

      const printerId = await resolveCashierPrinterId(tx, {
        tenantId: input.tenantId,
        branchId: input.branchId,
        userId: input.createdByUserId ?? null,
        branchDefaultId: config?.defaultReceiptPrinterId ?? null,
      });
      if (!printerId) return;

      const printer = await tx.kitchenPrinter.findFirst({
        where: { id: printerId, tenantId: input.tenantId, isActive: true },
        select: { id: true },
      });
      if (!printer) return;

      await tx.printJob.create({
        data: {
          tenantId: input.tenantId,
          saleId: input.saleId,
          branchId: input.branchId,
          printerId: printer.id,
          type: PrintJobType.ORDER_BILL,
          status: PrintJobStatus.PENDING,
          // The ESC/POS payload is rendered at print time from the settled
          // Sale (see PrintDispatcherService); `html` stays empty for this
          // type rather than carrying a second, divergent rendering.
          html: '',
          copies: Math.min(Math.max(config?.billCopies ?? 1, 1), 3),
          createdByUserId: input.createdByUserId ?? null,
        },
      });
    } catch (err) {
      // Never fail a close because printing could not be queued.
      this.logger.error(
        `Could not queue bill for sale ${input.saleId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * D67 — queue the bill for an order that has NOT settled yet (PO request,
   * 2026-08-20).
   *
   * A takeaway is taken by the cashier, so the bill and the kitchen ticket
   * both belong on paper the moment the order is placed — and at that moment
   * there is no Sale (a takeaway settles on handover). The job points at the
   * order; the renderer prices it with the same calculator the close uses.
   *
   * Idempotent per order: a second call finds the existing job and does
   * nothing, which is what stops the handover path printing a duplicate.
   */
  async enqueueOrderBill(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      branchId: string;
      orderId: string;
      createdByUserId?: string | null;
    },
  ): Promise<void> {
    try {
      const existing = await tx.printJob.findFirst({
        where: { tenantId: input.tenantId, orderId: input.orderId, type: PrintJobType.ORDER_BILL },
        select: { id: true },
      });
      if (existing) return;

      const config = await tx.restaurantBranchConfig.findUnique({
        where: { branchId: input.branchId },
        select: { autoPrintBill: true, billCopies: true, defaultReceiptPrinterId: true },
      });
      if (config && !config.autoPrintBill) return;

      const printerId = await resolveCashierPrinterId(tx, {
        tenantId: input.tenantId,
        branchId: input.branchId,
        userId: input.createdByUserId ?? null,
        branchDefaultId: config?.defaultReceiptPrinterId ?? null,
      });
      if (!printerId) return;

      const printer = await tx.kitchenPrinter.findFirst({
        where: { id: printerId, tenantId: input.tenantId, isActive: true },
        select: { id: true },
      });
      if (!printer) return;

      await tx.printJob.create({
        data: {
          tenantId: input.tenantId,
          orderId: input.orderId,
          branchId: input.branchId,
          printerId: printer.id,
          type: PrintJobType.ORDER_BILL,
          status: PrintJobStatus.PENDING,
          html: '',
          copies: Math.min(Math.max(config?.billCopies ?? 1, 1), 3),
          createdByUserId: input.createdByUserId ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Could not queue bill for order ${input.orderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Has a bill already been queued/printed for this order? */
  async orderBillExists(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
    const existing = await tx.printJob.findFirst({
      where: { orderId, type: PrintJobType.ORDER_BILL },
      select: { id: true },
    });
    return existing !== null;
  }

  /** Nudge the dispatcher after a commit. Never throws into the caller. */
  kick(): void {
    this.dispatcher.kick();
  }

  /**
   * Print a self-test page NOW (synchronously) and report the outcome — the
   * one place an operator gets a straight answer about whether a printer is
   * reachable, without placing a real order.
   */
  async testPrint(tenantId: string, printerId: string): Promise<{ ok: boolean; error?: string }> {
    const printer = await this.prisma.kitchenPrinter.findFirst({
      where: { id: printerId, tenantId },
    });
    if (!printer) throw new NotFoundException('Printer not found');

    const b = new EscPosBuilder(printer.columns);
    b.init()
      .align('center')
      .bold(true)
      .doubleSize(true)
      .line('AXLO POS')
      .doubleSize(false)
      .line('Printer test page')
      .bold(false)
      .line()
      .align('left')
      .hr()
      .row('Printer', printer.name)
      .row('Code', printer.code)
      .row('Role', printer.role)
      .row('Kind', printer.kind)
      .row('Address', printer.address)
      .row('Columns', String(printer.columns))
      .row('Printed', new Date().toISOString().slice(0, 19).replace('T', ' '))
      .hr()
      .line('If you can read this, the server can reach this printer.')
      .cut();

    const outcome = await sendToPrinter(toTarget(printer), b.build());
    if (!outcome.ok) {
      this.logger.warn(`Test print failed for ${printer.name}: ${outcome.error}`);
    }
    return outcome;
  }

  /** Re-queue a failed bill job (the operator's retry). */
  async retryJob(tenantId: string, jobId: string): Promise<void> {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, tenantId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException('Print job not found');
    await this.prisma.printJob.update({
      where: { id: job.id },
      data: { status: PrintJobStatus.PENDING, attemptCount: 0, lastError: null },
    });
    this.kick();
  }

  /**
   * D67 — the signed-in user's own printer choices, with the branch
   * fallbacks alongside so the settings screen can show what is actually in
   * force ("Kitchen: Grill printer (your choice)" vs "(branch default)").
   */
  async getMyPrinters(tenantId: string, userId: string, branchId: string) {
    const [preference, config] = await Promise.all([
      this.prisma.userPrinterPreference.findUnique({
        where: { userId },
        select: { kitchenPrinterId: true, cashierPrinterId: true },
      }),
      this.prisma.restaurantBranchConfig.findUnique({
        where: { branchId },
        select: {
          defaultReceiptPrinterId: true,
          defaultKitchenPrinterId: true,
          autoPrintKot: true,
          autoPrintBill: true,
        },
      }),
    ]);
    return {
      kitchenPrinterId: preference?.kitchenPrinterId ?? null,
      cashierPrinterId: preference?.cashierPrinterId ?? null,
      branchDefaultCashierPrinterId: config?.defaultReceiptPrinterId ?? null,
      branchDefaultKitchenPrinterId: config?.defaultKitchenPrinterId ?? null,
      autoPrintKot: config?.autoPrintKot ?? true,
      autoPrintBill: config?.autoPrintBill ?? true,
    };
  }

  /**
   * Set (or clear) this user's printers. `null` clears a choice and returns
   * the user to the branch routing — which is why the DTO distinguishes an
   * explicit null from an omitted field.
   */
  async setMyPrinters(
    tenantId: string,
    userId: string,
    input: { kitchenPrinterId?: string | null; cashierPrinterId?: string | null },
  ): Promise<void> {
    for (const id of [input.kitchenPrinterId, input.cashierPrinterId]) {
      if (!id) continue;
      const printer = await this.prisma.kitchenPrinter.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      // A printer from another tenant must not be selectable even if its id
      // is guessed: scoped lookup, 404 rather than a silent cross-tenant link.
      if (!printer) throw new NotFoundException('Printer not found');
    }
    const data = {
      ...(input.kitchenPrinterId !== undefined ? { kitchenPrinterId: input.kitchenPrinterId } : {}),
      ...(input.cashierPrinterId !== undefined ? { cashierPrinterId: input.cashierPrinterId } : {}),
    };
    await this.prisma.userPrinterPreference.upsert({
      where: { userId },
      update: data,
      create: { tenantId, userId, ...data },
    });
  }

  /** Queue depth + recent failures for the printing settings screen. */
  async queueStatus(tenantId: string, branchId: string) {
    const [pendingKot, failedKot, pendingBills, failedBills] = await Promise.all([
      this.prisma.kitchenPrintAttempt.count({
        where: { tenantId, status: 'PENDING', ticket: { branchId } },
      }),
      this.prisma.kitchenTicket.count({ where: { tenantId, branchId, status: 'FAILED' } }),
      this.prisma.printJob.count({
        where: { tenantId, branchId, type: PrintJobType.ORDER_BILL, status: PrintJobStatus.PENDING },
      }),
      this.prisma.printJob.findMany({
        where: { tenantId, branchId, type: PrintJobType.ORDER_BILL, status: PrintJobStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, saleId: true, lastError: true, attemptCount: true, updatedAt: true },
      }),
    ]);
    return {
      pendingKitchenAttempts: pendingKot,
      failedKitchenTickets: failedKot,
      pendingBillJobs: pendingBills,
      failedBillJobs: failedBills.map((j) => ({
        id: j.id,
        saleId: j.saleId,
        error: j.lastError,
        attempts: j.attemptCount,
        at: j.updatedAt.toISOString(),
      })),
    };
  }
}


/**
 * D67 — which CASHIER printer a bill goes to: the acting user's own choice
 * first, then the branch default. One function so the close path and the
 * settings screen can never describe different routing.
 */
export async function resolveCashierPrinterId(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    branchId: string;
    userId: string | null;
    branchDefaultId: string | null;
  },
): Promise<string | null> {
  if (input.userId) {
    const preference = await tx.userPrinterPreference.findUnique({
      where: { userId: input.userId },
      select: { cashierPrinterId: true },
    });
    if (preference?.cashierPrinterId) return preference.cashierPrinterId;
  }
  return input.branchDefaultId;
}

/**
 * D67 — which KITCHEN printer(s) a round's tickets go to.
 *
 * The user's choice WINS over station links, deliberately: a waiter who has
 * picked "the upstairs printer" means it, and the alternative (union of both)
 * prints the same ticket twice. With no preference the station links decide,
 * exactly as before — so nothing changes for a branch that routes by station.
 */
export async function resolveKitchenPrinterIdForUser(
  tx: Prisma.TransactionClient,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const preference = await tx.userPrinterPreference.findUnique({
    where: { userId },
    select: { kitchenPrinterId: true },
  });
  return preference?.kitchenPrinterId ?? null;
}
