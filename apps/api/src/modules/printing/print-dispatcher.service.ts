import { Injectable, Logger } from '@nestjs/common';
import {
  KitchenPrinterKind,
  KitchenPrintAttemptStatus,
  PrintJobStatus,
  PrintJobType,
  Prisma,
  RestaurantOrderChannel,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { computeRestaurantTotals } from '../restaurant/restaurant-totals';
import { SettingsService } from '../settings/settings.service';
import type { BuilderOptions } from './escpos';
import { renderBill, type BillTemplateData } from './templates/bill.template';
import { renderKotTicket, type KotOrderType, type KotTicketData } from './templates/kot.template';
import { renderTestPage } from './templates/test.template';
import { sendToPrinter, type PrinterTarget } from './printer-drivers';

/**
 * D67 — drains the print outbox: PENDING kitchen attempts and PENDING bill
 * jobs become bytes on a printer.
 *
 * ## Why a drainer and not a direct call at order time
 *
 * D53's rule stands: the order transaction never waits on hardware and can
 * never be failed by it. Intake writes rows (it already did for KOTs since
 * Phase 6) and returns; this service turns rows into paper afterwards.
 * A printer that is off, unplugged or out of paper therefore delays paper,
 * never an order.
 *
 * ## Rendering is lazy
 *
 * Payloads are rendered here, at print time, from the snapshotted ticket /
 * settled Sale — not stored as bytes on the row. The snapshots are already
 * immutable (KitchenTicketItem, Sale/SaleItem), so a reprint is faithful
 * without a second copy of the data, and a template fix applies to a stuck
 * queue without a backfill.
 *
 * ## D174 — print state never touches the ticket
 *
 * D67's dispatcher wrote PRINTED / FAILED onto `KitchenTicket.status`. Since
 * D68 that column is the BOARD's (QUEUED → IN_PROGRESS → COMPLETED, restated
 * onto the round and the takeaway profile by D106), so a printer writing to it
 * would un-prepare a dish the cook had started, or make the Orders queue lie.
 * Every print outcome therefore lives on `KitchenPrintAttempt` alone; the
 * ticket is read here and never written. That separation is the code half of
 * D174's safety condition — a printer cannot move a ticket on the board.
 */

/** A job stops retrying after this many failures; the operator reprints. */
export const PRINT_MAX_ATTEMPTS = 3;

/**
 * A branch counts as "served by an on-site agent" while its agent has
 * checked in this recently. Defined here because BOTH transports need the
 * same answer: the agent side to serve leases, and this dispatcher to keep
 * its hands off — a cloud API that tried to print to a shop LAN would burn
 * all three retries on connect timeouts before the agent ever saw the row.
 */
export const AGENT_FRESHNESS_MS = 120_000;

@Injectable()
export class PrintDispatcherService {
  private readonly logger = new Logger(PrintDispatcherService.name);
  /** One drain at a time per process — two would double-print. */
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Fire-and-forget nudge from a request path (a round was submitted, an
   * order was closed). Never awaited by intake, never throws.
   */
  kick(): void {
    setImmediate(() => {
      void this.drain().catch((err) =>
        this.logger.error(`Print drain failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
  }

  /** One pass over both queues. Safe to call concurrently — it self-guards. */
  async drain(): Promise<{ kot: number; bill: number }> {
    if (this.draining) return { kot: 0, bill: 0 };
    this.draining = true;
    try {
      // One query for the whole pass, not one per row and not a cache: a
      // branch whose agent paired a moment ago is handed off on THIS drain.
      const served = await this.liveAgentBranches();
      const kot = await this.drainKitchenAttempts(served);
      const bill = await this.drainBillJobs(served);
      return { kot, bill };
    } finally {
      this.draining = false;
    }
  }

  // ── Kitchen tickets ─────────────────────────────────────────────────────

  private async drainKitchenAttempts(served: Set<string>): Promise<number> {
    const attempts = await this.prisma.kitchenPrintAttempt.findMany({
      // `leasedAt: null` keeps the two transports off each other's rows: a
      // job an on-site agent is holding is invisible here.
      where: { status: KitchenPrintAttemptStatus.PENDING, leasedAt: null },
      orderBy: { attemptedAt: 'asc' },
      take: 20,
      include: {
        printer: true,
        ticket: {
          include: {
            items: true,
            station: { select: { name: true } },
            round: {
              select: {
                roundNumber: true,
                order: {
                  select: {
                    orderNumber: true,
                    channel: true,
                    session: { select: { tableId: true, waiterUserId: true } },
                    takeawayProfile: { select: { customerName: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    let printed = 0;
    for (const attempt of attempts) {
      // A branch that switched auto-KOT off keeps its rows queued for the
      // KDS's manual buttons; the dispatcher simply leaves them alone.
      if (!(await this.autoPrintEnabled(attempt.ticket.branchId, 'kot'))) continue;
      if (served.has(attempt.ticket.branchId)) continue;
      if (!attempt.printer.isActive) continue;

      const payload = renderKotTicket(
        await this.kotData(attempt.ticket, await this.isReprint(attempt.ticketId)),
        attempt.printer.columns,
        renderOptions(attempt.printer),
      );
      const outcome = await sendToPrinter(toTarget(attempt.printer), payload);

      if (outcome.ok) {
        await this.prisma.kitchenPrintAttempt.update({
          where: { id: attempt.id },
          data: {
            status: KitchenPrintAttemptStatus.SUCCEEDED,
            completedAt: new Date(),
            error: null,
          },
        });
        printed += 1;
        continue;
      }

      // Failed: record it, then queue ONE fresh attempt if retries remain.
      // The retry is a new row rather than a mutated one so the KDS shows
      // the real attempt history (what failed, when, and why).
      const tried = await this.prisma.kitchenPrintAttempt.count({
        where: { ticketId: attempt.ticketId, printerId: attempt.printerId },
      });
      await this.prisma.kitchenPrintAttempt.update({
        where: { id: attempt.id },
        data: {
          status: KitchenPrintAttemptStatus.FAILED,
          completedAt: new Date(),
          error: truncate(outcome.error ?? 'Unknown printer error'),
        },
      });
      if (tried < PRINT_MAX_ATTEMPTS) {
        await this.prisma.kitchenPrintAttempt.create({
          data: {
            tenantId: attempt.tenantId,
            ticketId: attempt.ticketId,
            printerId: attempt.printerId,
          },
        });
      } else {
        // The ticket stays exactly where the board has it; the exhausted
        // attempt row is what the settings screen surfaces for a retry.
        this.logger.warn(
          `KOT ${attempt.ticket.ticketNumber} gave up after ${tried} attempts on printer ` +
            `${attempt.printer.name}: ${outcome.error ?? 'unknown error'}`,
        );
      }
    }
    return printed;
  }

  /**
   * A ticket that has already come out of a printer once is a REPRINT the
   * next time, and the paper says so — the cook must not start a second
   * portion. D67 read this off `KitchenTicket.status`; since that column is
   * the board's, the attempt history is the only honest source.
   */
  private async isReprint(ticketId: string): Promise<boolean> {
    const succeeded = await this.prisma.kitchenPrintAttempt.count({
      where: { ticketId, status: KitchenPrintAttemptStatus.SUCCEEDED },
    });
    return succeeded > 0;
  }

  /**
   * Render one ticket's bytes. Shared with the agent transport so a ticket
   * printed by an on-site agent is byte-identical to one printed directly.
   */
  async renderKotPayload(
    ticketId: string,
    printer: { columns: number; kind: KitchenPrinterKind },
  ): Promise<Buffer | null> {
    const ticket = await this.prisma.kitchenTicket.findUnique({
      where: { id: ticketId },
      include: {
        items: true,
        station: { select: { name: true } },
        round: {
          select: {
            roundNumber: true,
            order: {
              select: {
                orderNumber: true,
                channel: true,
                session: { select: { tableId: true, waiterUserId: true } },
                takeawayProfile: { select: { customerName: true } },
              },
            },
          },
        },
      },
    });
    if (!ticket) return null;
    return renderKotTicket(
      await this.kotData(ticket, await this.isReprint(ticket.id)),
      printer.columns,
      renderOptions(printer),
    );
  }

  /**
   * D174 — the bytes for one `PrintJob`, whichever kind it is. Shared with
   * the agent transport so a bill or a test page printed by an on-site agent
   * is byte-identical to one printed directly. Null when there is nothing to
   * render (a sale that no longer exists), which the caller fails the job on.
   */
  async renderJobPayload(
    job: {
      tenantId: string;
      type: PrintJobType;
      saleId: string | null;
      orderId: string | null;
      copies: number;
    },
    printer: {
      name: string;
      code: string;
      role: string;
      kind: KitchenPrinterKind;
      address: string;
      columns: number;
    },
    via: 'SERVER' | 'AGENT',
  ): Promise<Buffer | null> {
    if (job.type === PrintJobType.PRINTER_TEST) {
      return renderTestPage({ ...printer, via, printedAt: new Date() }, renderOptions(printer));
    }
    return this.renderBillPayload(
      job.tenantId,
      { saleId: job.saleId, orderId: job.orderId },
      job.copies > 1,
      printer.columns,
      renderOptions(printer),
    );
  }

  /** Bill bytes, for the same reason as `renderKotPayload`. */
  async renderBillPayload(
    tenantId: string,
    ref: { saleId: string | null; orderId: string | null },
    isCopy: boolean,
    columns: number,
    options?: BuilderOptions,
  ): Promise<Buffer | null> {
    const data = ref.saleId
      ? await this.billData(tenantId, ref.saleId, isCopy)
      : ref.orderId
        ? await this.orderBillData(tenantId, ref.orderId, isCopy)
        : null;
    return data ? renderBill(data, columns, options) : null;
  }

  /**
   * Record a failed kitchen attempt and queue one retry if any remain.
   * Shared with the agent path so both transports fail identically.
   */
  async recordKitchenFailure(
    attempt: { id: string; tenantId: string; ticketId: string; printerId: string },
    error: string,
  ): Promise<void> {
    const tried = await this.prisma.kitchenPrintAttempt.count({
      where: { ticketId: attempt.ticketId, printerId: attempt.printerId },
    });
    await this.prisma.kitchenPrintAttempt.update({
      where: { id: attempt.id },
      data: {
        status: KitchenPrintAttemptStatus.FAILED,
        completedAt: new Date(),
        error: truncate(error),
        leaseId: null,
        leasedAt: null,
      },
    });
    if (tried < PRINT_MAX_ATTEMPTS) {
      await this.prisma.kitchenPrintAttempt.create({
        data: {
          tenantId: attempt.tenantId,
          ticketId: attempt.ticketId,
          printerId: attempt.printerId,
        },
      });
    }
    // Retries spent: the FAILED attempt row is the record. The ticket is not
    // touched (D174) — it is still on the board, which is where the kitchen
    // will actually find out about the dish.
  }

  /** Public counterpart of the private bill-failure path, for the agent. */
  async recordBillFailure(jobId: string, attemptCount: number, error: string): Promise<void> {
    await this.failJob(jobId, attemptCount, error);
  }

  private async kotData(
    ticket: Prisma.KitchenTicketGetPayload<{
      include: {
        items: true;
        station: { select: { name: true } };
        round: {
          select: {
            roundNumber: true;
            order: {
              select: {
                orderNumber: true;
                channel: true;
                session: { select: { tableId: true; waiterUserId: true } };
                takeawayProfile: { select: { customerName: true } };
              };
            };
          };
        };
      };
    }>,
    isReprint: boolean,
  ): Promise<KotTicketData> {
    const session = ticket.round?.order?.session;
    const [table, waiter] = await Promise.all([
      session?.tableId
        ? this.prisma.restaurantTable.findUnique({
            where: { id: session.tableId },
            select: { code: true, area: { select: { name: true } } },
          })
        : Promise.resolve(null),
      session?.waiterUserId
        ? this.prisma.user.findUnique({
            where: { id: session.waiterUserId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);

    const order = ticket.round?.order ?? null;
    // The synthetic walk-in table backs every counter/takeaway order; the
    // kitchen wants to see TAKEAWAY, not a table code nobody can find. The
    // channel is the authority; the walk-in code is the belt to its braces.
    const walkIn = table?.code === 'WALK-IN';
    const orderType: KotOrderType =
      order?.channel === RestaurantOrderChannel.ONLINE
        ? 'DELIVERY'
        : order?.channel === RestaurantOrderChannel.TAKEAWAY || walkIn
          ? 'TAKEAWAY'
          : 'DINE_IN';

    return {
      ticketNumber: ticket.ticketNumber,
      // NULL for a ticket cut in the D147 window, when a round was one
      // stationless ticket carrying every station's items (D152).
      stationName: ticket.station?.name ?? null,
      orderNumber: order?.orderNumber ?? null,
      orderType,
      tableCode: table && !walkIn ? table.code : null,
      areaName: table && !walkIn ? (table.area?.name ?? null) : null,
      customerName: order?.takeawayProfile?.customerName ?? null,
      roundNumber: ticket.round?.roundNumber ?? null,
      waiterName: waiter?.name ?? null,
      createdAt: ticket.createdAt,
      isReprint,
      items: ticket.items.map((item) => ({
        name: item.menuItemName,
        variantName: item.variantName,
        quantity: item.quantity.toString(),
        modifierNames: item.modifierNames,
        specialInstructions: item.specialInstructions,
      })),
    };
  }

  // ── Cashier bills and test pages ────────────────────────────────────────

  /** The `PrintJob` kinds this dispatcher (and the agent) turn into paper. */
  static readonly QUEUE_TYPES: PrintJobType[] = [PrintJobType.ORDER_BILL, PrintJobType.PRINTER_TEST];

  private async drainBillJobs(served: Set<string>): Promise<number> {
    const jobs = await this.prisma.printJob.findMany({
      where: {
        status: PrintJobStatus.PENDING,
        type: { in: PrintDispatcherService.QUEUE_TYPES },
        // A job with no resolved printer is not printable here: the branch
        // has no cashier printer configured, and the browser path owns it.
        printerId: { not: null },
        leasedAt: null,
        attemptCount: { lt: PRINT_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    let printed = 0;
    for (const job of jobs) {
      // A test page ignores the auto-bill switch: the operator asked for it
      // explicitly, and "off" would read as a broken printer.
      if (
        job.type === PrintJobType.ORDER_BILL &&
        job.branchId &&
        !(await this.autoPrintEnabled(job.branchId, 'bill'))
      ) {
        continue;
      }
      if (job.branchId && served.has(job.branchId)) continue;
      const printer = await this.prisma.kitchenPrinter.findFirst({
        where: { id: job.printerId!, tenantId: job.tenantId, isActive: true },
      });
      if (!printer) {
        await this.failJob(job.id, job.attemptCount, 'Configured printer is missing or inactive');
        continue;
      }

      const payload = await this.renderJobPayload(job, printer, 'SERVER');
      if (!payload) {
        await this.failJob(job.id, job.attemptCount, 'Nothing to print for this job');
        continue;
      }

      let outcome = await sendToPrinter(toTarget(printer), payload);
      // Extra copies are separate documents (each ends in a cut), printed
      // sequentially so a mid-run failure is still reported as one job.
      for (let copy = 1; outcome.ok && copy < job.copies; copy += 1) {
        outcome = await sendToPrinter(toTarget(printer), payload);
      }

      if (outcome.ok) {
        await this.prisma.printJob.update({
          where: { id: job.id },
          data: {
            status: PrintJobStatus.PRINTED,
            printedAt: new Date(),
            attemptCount: { increment: 1 },
            lastError: null,
          },
        });
        printed += 1;
      } else {
        await this.failJob(job.id, job.attemptCount, outcome.error ?? 'Unknown printer error');
      }
    }
    return printed;
  }

  private async failJob(jobId: string, attemptCount: number, error: string): Promise<void> {
    const next = attemptCount + 1;
    await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        attemptCount: next,
        lastError: truncate(error),
        leaseId: null,
        leasedAt: null,
        // PENDING until the retries are spent, so the next tick picks it up;
        // FAILED once they are, which is what the UI surfaces for a retry.
        status: next >= PRINT_MAX_ATTEMPTS ? PrintJobStatus.FAILED : PrintJobStatus.PENDING,
      },
    });
    if (next >= PRINT_MAX_ATTEMPTS) {
      this.logger.warn(`Bill job ${jobId} gave up after ${next} attempts: ${error}`);
    }
  }

  /** Assemble the bill from the SETTLED sale — never recomputed here. */
  async billData(
    tenantId: string,
    saleId: string,
    isCopy: boolean,
  ): Promise<BillTemplateData | null> {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
        cashier: { select: { name: true } },
      },
    });
    if (!sale) return null;

    // `TableSession.finalSaleId` is a plain unique column, not a relation —
    // the table label is a second lookup rather than an include.
    const session = await this.prisma.tableSession.findFirst({
      where: { finalSaleId: saleId, tenantId },
      select: { table: { select: { code: true, area: { select: { name: true } } } } },
    });

    const settings = this.settings.getSettings(tenantId);
    const table = session?.table ?? null;
    return {
      companyName: settings.documents.companyName ?? 'Receipt',
      addressLine: settings.documents.addressLine ?? null,
      phone: settings.documents.phone ?? null,
      taxNumber: settings.documents.taxNumber ?? null,
      currency: settings.currency,
      footer: settings.receiptFooter ?? null,
      saleNumber: sale.saleNumber,
      placeLabel: table
        ? table.code === 'WALK-IN'
          ? 'Takeaway'
          : `Table ${table.code}${table.area?.name ? ` · ${table.area.name}` : ''}`
        : null,
      staffName: sale.cashier?.name ?? null,
      closedAt: sale.createdAt,
      copyLabel: isCopy ? 'CUSTOMER COPY' : null,
      items: sale.items.map((item) => ({
        name: item.productName,
        variantName: item.variantNameSnapshot,
        quantity: item.quantity.toString(),
        lineTotal: item.lineTotal.toFixed(2),
      })),
      subtotal: sale.subtotal.toFixed(2),
      serviceCharge: sale.serviceChargeAmount.toFixed(2),
      packagingCharge: sale.packagingCharge.toFixed(2),
      tax: sale.taxAmount.toFixed(2),
      total: sale.total.toFixed(2),
      paid: sale.paidAmount.toFixed(2),
      balance: sale.balanceAmount.toFixed(2),
      payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount.toFixed(2) })),
    };
  }

  /**
   * Is an on-site agent handling this branch? Then this process must not
   * touch its rows: in the cloud deployment the printers are unreachable
   * from here, and a "failed" attempt would consume the retries the agent
   * needs. Answered fresh every time — D67 cached this for two seconds, which
   * meant a just-paired agent could watch the server print its first ticket,
   * and a just-revoked one could strand a row. The drain asks once per pass
   * (`liveAgentBranches`); callers outside a drain ask here.
   */
  async servedByAgent(branchId: string): Promise<boolean> {
    const agent = await this.prisma.printAgent.findFirst({
      where: {
        branchId,
        isActive: true,
        lastSeenAt: { gte: new Date(Date.now() - AGENT_FRESHNESS_MS) },
      },
      select: { id: true },
    });
    return agent !== null;
  }

  /** Every branch with a live agent right now, for one drain pass. */
  private async liveAgentBranches(): Promise<Set<string>> {
    const rows = await this.prisma.printAgent.findMany({
      where: { isActive: true, lastSeenAt: { gte: new Date(Date.now() - AGENT_FRESHNESS_MS) } },
      select: { branchId: true },
      distinct: ['branchId'],
    });
    return new Set(rows.map((r) => r.branchId));
  }

  /**
   * D67 — the bill for an order that has NOT settled yet (a takeaway, priced
   * at placement).
   *
   * The money comes from `computeRestaurantTotals` — the SAME calculator the
   * close path uses (D52/D59) — so the paper the cashier hands over and the
   * Sale that is written moments later cannot disagree. Nothing is
   * recomputed with a second formula here.
   */
  async orderBillData(
    tenantId: string,
    orderId: string,
    isCopy: boolean,
  ): Promise<BillTemplateData | null> {
    const order = await this.prisma.restaurantOrder.findFirst({
      where: { id: orderId, tenantId },
      include: {
        items: {
          where: { status: { not: 'VOIDED' } },
          orderBy: { createdAt: 'asc' },
        },
        session: { select: { waiterUserId: true } },
      },
    });
    if (!order) return null;

    let subtotal = new Prisma.Decimal(0);
    for (const item of order.items) {
      subtotal = subtotal.plus(item.unitPrice.plus(item.modifierTotal).mul(item.quantity));
    }

    const config = await this.prisma.restaurantBranchConfig.findUnique({
      where: { branchId: order.branchId },
      select: {
        serviceChargePercent: true,
        serviceChargeChannels: true,
        serviceChargeTaxable: true,
        packagingChargeAmount: true,
        taxRatePercent: true,
      },
    });
    const settings = this.settings.getSettings(tenantId);
    const totals = computeRestaurantTotals(subtotal, order.channel, {
      serviceChargePercent: config?.serviceChargePercent ?? new Prisma.Decimal(0),
      serviceChargeChannels: config?.serviceChargeChannels ?? [RestaurantOrderChannel.DINE_IN],
      serviceChargeTaxable: config?.serviceChargeTaxable ?? true,
      packagingChargeAmount: config?.packagingChargeAmount ?? new Prisma.Decimal(0),
      taxRatePercent:
        config?.taxRatePercent != null
          ? config.taxRatePercent.toNumber()
          : settings.taxRatePercent,
    });

    const staff = order.session?.waiterUserId
      ? await this.prisma.user.findUnique({
          where: { id: order.session.waiterUserId },
          select: { name: true },
        })
      : null;

    return {
      companyName: settings.documents.companyName ?? 'Receipt',
      addressLine: settings.documents.addressLine ?? null,
      phone: settings.documents.phone ?? null,
      taxNumber: settings.documents.taxNumber ?? null,
      currency: settings.currency,
      footer: settings.receiptFooter ?? null,
      saleNumber: order.orderNumber,
      placeLabel: order.channel === RestaurantOrderChannel.TAKEAWAY ? 'Takeaway' : null,
      staffName: staff?.name ?? null,
      closedAt: order.createdAt,
      copyLabel: isCopy ? 'CUSTOMER COPY' : null,
      items: order.items.map((item) => ({
        name: item.menuItemName,
        variantName: item.variantNameSnapshot,
        quantity: item.quantity.toString(),
        lineTotal: item.unitPrice.plus(item.modifierTotal).mul(item.quantity).toFixed(2),
      })),
      subtotal: totals.subtotal.toFixed(2),
      serviceCharge: totals.serviceChargeAmount.toFixed(2),
      packagingCharge: totals.packagingCharge.toFixed(2),
      tax: totals.taxAmount.toFixed(2),
      total: totals.total.toFixed(2),
      // Not settled yet: no payments, and the balance IS the total. The
      // template prints "BALANCE DUE", which is the honest state of an order
      // whose money has not been taken at the moment the paper comes out.
      paid: '0.00',
      balance: totals.total.toFixed(2),
      payments: [],
    };
  }

  /** Per-branch switch. A branch with no restaurant config auto-prints. */
  private async autoPrintEnabled(branchId: string, which: 'kot' | 'bill'): Promise<boolean> {
    const config = await this.prisma.restaurantBranchConfig.findUnique({
      where: { branchId },
      select: { autoPrintKot: true, autoPrintBill: true },
    });
    if (!config) return true;
    return which === 'kot' ? config.autoPrintKot : config.autoPrintBill;
  }
}

/**
 * D174 — how a document is rendered follows the printer's KIND. An office
 * printer (A4_NETWORK) gets plain text, which the agent hands to the Windows
 * spooler as a text document; everything else gets ESC/POS.
 */
export function renderOptions(printer: { kind: KitchenPrinterKind }): BuilderOptions {
  return { plainText: printer.kind === KitchenPrinterKind.A4_NETWORK };
}

export function toTarget(printer: {
  id: string;
  name: string;
  kind: PrinterTarget['kind'];
  address: string;
  columns: number;
}): PrinterTarget {
  return {
    id: printer.id,
    name: printer.name,
    kind: printer.kind,
    address: printer.address,
    columns: printer.columns,
  };
}

/** Printer errors can be verbose; the column is for humans, not a log sink. */
function truncate(message: string, max = 400): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}
