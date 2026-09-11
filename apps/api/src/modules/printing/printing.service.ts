import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { KitchenPrinterKind, PrintJobStatus, PrintJobType, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { PrintDispatcherService, renderOptions, toTarget } from './print-dispatcher.service';
import { probeEscPos, sendToPrinter } from './printer-drivers';
import { renderTestPage } from './templates/test.template';

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

      const printerId = config?.defaultReceiptPrinterId ?? null;
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

      const printerId = config?.defaultReceiptPrinterId ?? null;
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
   * Print a self-test page — the one place an operator gets a straight
   * answer about whether a printer is reachable, without placing a real
   * order.
   *
   * D174 — transport-aware, because the answer depends on WHO can see the
   * printer. A branch served by an on-site agent gets a queued PRINTER_TEST
   * job (the API is in the cloud and cannot reach the device; the agent
   * leases the job like any other and the outcome lands on the row, which
   * the settings screen polls). A branch with no agent prints synchronously
   * from this process, which on an on-prem install IS the shop LAN.
   */
  async testPrint(
    tenantId: string,
    printerId: string,
  ): Promise<{ ok: boolean; error?: string; warning?: string; queued?: boolean; jobId?: string }> {
    const printer = await this.prisma.kitchenPrinter.findFirst({
      where: { id: printerId, tenantId },
    });
    if (!printer) throw new NotFoundException('Printer not found');

    if (await this.dispatcher.servedByAgent(printer.branchId)) {
      const job = await this.prisma.printJob.create({
        data: {
          tenantId,
          branchId: printer.branchId,
          printerId: printer.id,
          type: PrintJobType.PRINTER_TEST,
          status: PrintJobStatus.PENDING,
          html: '',
          copies: 1,
        },
        select: { id: true },
      });
      this.kick();
      return { ok: true, queued: true, jobId: job.id };
    }

    const outcome = await sendToPrinter(
      toTarget(printer),
      renderTestPage({ ...printer, via: 'SERVER', printedAt: new Date() }, renderOptions(printer)),
    );
    if (!outcome.ok) {
      this.logger.warn(`Test print failed for ${printer.name}: ${outcome.error}`);
      return outcome;
    }
    // Delivered — but to what? An office printer takes the bytes on the same
    // port and prints nothing; say so beside the success rather than let
    // "printed" stand for a page that never came out.
    if (printer.kind === KitchenPrinterKind.ESC_POS_NETWORK) {
      const verdict = await probeEscPos(printer.address);
      if (verdict !== 'ESC_POS') {
        return {
          ok: true,
          warning:
            'The device accepted the data but did not answer as a receipt printer. ' +
            'An office printer answers on the same port and prints nothing — check that ' +
            printer.address +
            ' is the thermal printer. If a page did come out, ignore this.',
        };
      }
    }
    return outcome;
  }

  /** One job's delivery state, for the settings screen to poll a test page. */
  async jobStatus(tenantId: string, jobId: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, tenantId },
      select: {
        id: true,
        type: true,
        status: true,
        attemptCount: true,
        lastError: true,
        printedAt: true,
        updatedAt: true,
      },
    });
    if (!job) throw new NotFoundException('Print job not found');
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attemptCount,
      error: job.lastError,
      printedAt: job.printedAt?.toISOString() ?? null,
      updatedAt: job.updatedAt.toISOString(),
    };
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
   * D174 — the branch's printing configuration as the settings screen shows
   * it. Read-only here: the switches are written through the restaurant
   * branch config PUT, which is the one authority for that row (its
   * optimistic version must not be bypassed by a second writer).
   */
  async branchPrinting(tenantId: string, branchId: string) {
    const config = await this.prisma.restaurantBranchConfig.findFirst({
      where: { branchId, tenantId },
      select: {
        defaultReceiptPrinterId: true,
        defaultKitchenPrinterId: true,
        autoPrintKot: true,
        autoPrintBill: true,
        billCopies: true,
      },
    });
    return {
      defaultReceiptPrinterId: config?.defaultReceiptPrinterId ?? null,
      defaultKitchenPrinterId: config?.defaultKitchenPrinterId ?? null,
      autoPrintKot: config?.autoPrintKot ?? true,
      autoPrintBill: config?.autoPrintBill ?? true,
      billCopies: config?.billCopies ?? 1,
    };
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
 * D174 — which printer(s) a station's ticket comes out of.
 *
 * D152 decides the STATION; this only decides the DEVICE. Precedence:
 *   1. the station's linked printers, primary first (a shop that routes grill
 *      and bar separately means it);
 *   2. the branch's default kitchen printer, when the station links none —
 *      the owner's one-time setting, so a branch with one printer never has
 *      to link it to every station by hand.
 * Empty means the ticket is queued with no attempt: it is still on the board
 * and D153 can print it by hand, which is strictly better than inventing a
 * target. D67's per-user override is gone with `UserPrinterPreference`; a
 * grill dish belongs on the grill printer regardless of who keyed it in.
 *
 * Only ACTIVE printers of this tenant are returned, so a link left pointing
 * at a retired device produces no attempt rather than three failed ones.
 */
export async function resolveStationPrinterIds(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; branchId: string; stationId: string },
): Promise<string[]> {
  const linked = await tx.kitchenStationPrinter.findMany({
    where: { stationId: input.stationId },
    orderBy: { isPrimary: 'desc' },
    select: { printerId: true },
  });
  let candidates = linked.map((l) => l.printerId);
  if (candidates.length === 0) {
    const config = await tx.restaurantBranchConfig.findUnique({
      where: { branchId: input.branchId },
      select: { defaultKitchenPrinterId: true },
    });
    if (config?.defaultKitchenPrinterId) candidates = [config.defaultKitchenPrinterId];
  }
  if (candidates.length === 0) return [];

  const active = await tx.kitchenPrinter.findMany({
    where: { id: { in: candidates }, tenantId: input.tenantId, isActive: true },
    select: { id: true },
  });
  const activeIds = new Set(active.map((p) => p.id));
  // Preserve the primary-first order the link query gave us.
  return candidates.filter((id) => activeIds.has(id));
}
