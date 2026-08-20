import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  KitchenPrintAttemptStatus,
  KitchenTicketStatus,
  PrintJobStatus,
  PrintJobType,
} from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import {
  AGENT_FRESHNESS_MS,
  PrintDispatcherService,
  PRINT_MAX_ATTEMPTS,
} from './print-dispatcher.service';
import type { DiscoveredPrinter } from './printer-discovery.service';
import { hashAgentToken } from './print-agent.guard';

/**
 * D67 — the cloud side of the on-site Print Agent.
 *
 * ## Why this exists at all
 *
 * Amplify serves the app and EC2 serves the API; the printers are on the
 * shop's LAN. Neither cloud process can open a socket to 192.168.x.x, and a
 * browser cannot speak raw ESC/POS. So the shop runs a tiny daemon that
 * dials OUT, leases work, prints it locally, and reports the outcome. The
 * queue rows are unchanged — this is a second CONSUMER of the same outbox,
 * which is why an on-prem install (API on the shop LAN) can keep printing
 * directly with no agent at all.
 *
 * ## Leases, and the honest trade
 *
 * A leased row is invisible to other consumers until it is acked or its
 * lease expires. If an agent dies between "printed" and "acked", the lease
 * expires and the row prints again: at-least-once. Duplicates are
 * recoverable (the operator sees two identical tickets); losses are not
 * (the kitchen never learns about a dish). That choice is deliberate.
 */

/** A lease is reclaimed after this long. Longer than any real print. */
export const PRINT_LEASE_TTL_MS = 60_000;
export { AGENT_FRESHNESS_MS };

export interface AgentPrintJob {
  leaseId: string;
  /** Which queue the row came from — the agent acks back to the same one. */
  source: 'KITCHEN' | 'CASHIER';
  jobId: string;
  printer: { id: string; name: string; kind: string; address: string; columns: number };
  copies: number;
  /** Ready-to-send ESC/POS bytes; the agent never renders anything. */
  payloadBase64: string;
  description: string;
}

@Injectable()
export class PrintAgentService {
  private readonly logger = new Logger(PrintAgentService.name);

  /**
   * Devices the agent last reported from the shop LAN, per branch. Held in
   * memory deliberately: it is a live view of a network, worthless after a
   * restart, and persisting it would invite a stale list being presented as
   * current.
   */
  private readonly discovered = new Map<
    string,
    { at: Date; agentName: string; printers: DiscoveredPrinter[] }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: PrintDispatcherService,
  ) {}

  // ── Pairing (owner-facing) ──────────────────────────────────────────────

  /**
   * Create an agent and return its token ONCE. The plaintext is never
   * stored — losing it means pairing a new agent, which is the same
   * discipline the console applies to passwords.
   */
  async pair(
    tenantId: string,
    branchId: string,
    name: string,
  ): Promise<{ id: string; name: string; token: string }> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const token = `pat_${randomBytes(24).toString('base64url')}`;
    const agent = await this.prisma.printAgent.create({
      data: { tenantId, branchId, name, tokenHash: hashAgentToken(token) },
      select: { id: true, name: true },
    });
    return { ...agent, token };
  }

  async listAgents(tenantId: string, branchId: string) {
    const rows = await this.prisma.printAgent.findMany({
      where: { tenantId, branchId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        isActive: true,
        lastSeenAt: true,
        version: true,
        createdAt: true,
      },
    });
    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      // "Online" is a derived fact, computed the same way the transport
      // decision is — so what the screen shows and what the queue does
      // cannot disagree.
      online:
        row.isActive &&
        row.lastSeenAt !== null &&
        now - row.lastSeenAt.getTime() < AGENT_FRESHNESS_MS,
    }));
  }

  async revoke(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.prisma.printAgent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Print agent not found');
    await this.prisma.printAgent.update({
      where: { id: agent.id },
      data: { isActive: false },
    });
  }

  /** Is this branch served by a live agent? Decides who drains the queue. */
  async branchHasLiveAgent(branchId: string): Promise<boolean> {
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

  // ── Agent-facing ────────────────────────────────────────────────────────

  async heartbeat(agentId: string, version?: string): Promise<{ ok: true }> {
    await this.prisma.printAgent.update({
      where: { id: agentId },
      data: { lastSeenAt: new Date(), version: version ?? undefined },
    });
    return { ok: true };
  }

  /** Devices the agent found on the shop LAN, for the settings screen. */
  reportDiscovery(branchId: string, agentName: string, printers: DiscoveredPrinter[]): void {
    this.discovered.set(branchId, { at: new Date(), agentName, printers });
  }

  /** The freshest agent-reported device list for a branch, if any. */
  lastDiscovery(branchId: string) {
    const entry = this.discovered.get(branchId);
    if (!entry) return null;
    return {
      at: entry.at.toISOString(),
      agentName: entry.agentName,
      printers: entry.printers,
    };
  }

  /**
   * Hand the agent a batch of work, atomically marking it leased.
   *
   * Rendering happens here (server-side) so the agent stays dumb: it never
   * needs a template update, and the bytes are identical to what the direct
   * dispatcher would have sent.
   */
  async lease(
    agent: { agentId: string; tenantId: string; branchId: string },
    maxJobs = 8,
  ): Promise<AgentPrintJob[]> {
    await this.reclaimExpiredLeases();
    const take = Math.min(Math.max(maxJobs, 1), 20);
    const jobs: AgentPrintJob[] = [];

    // ── Kitchen tickets ──
    const attempts = await this.prisma.kitchenPrintAttempt.findMany({
      where: {
        tenantId: agent.tenantId,
        status: KitchenPrintAttemptStatus.PENDING,
        leasedAt: null,
        ticket: { branchId: agent.branchId },
      },
      orderBy: { attemptedAt: 'asc' },
      take,
      include: { printer: true, ticket: { select: { id: true, ticketNumber: true, branchId: true } } },
    });
    for (const attempt of attempts) {
      if (!attempt.printer.isActive) continue;
      const payload = await this.dispatcher.renderKotPayload(attempt.ticketId, attempt.printer.columns);
      if (!payload) continue;
      const leaseId = randomBytes(12).toString('hex');
      const claimed = await this.prisma.kitchenPrintAttempt.updateMany({
        // The `leasedAt: null` predicate IS the lock: two agents racing for
        // the same row, only one updates a row.
        where: { id: attempt.id, leasedAt: null, status: KitchenPrintAttemptStatus.PENDING },
        data: { leaseId, leasedAt: new Date(), leasedBy: agent.agentId },
      });
      if (claimed.count === 0) continue;
      jobs.push({
        leaseId,
        source: 'KITCHEN',
        jobId: attempt.id,
        printer: printerView(attempt.printer),
        copies: 1,
        payloadBase64: payload.toString('base64'),
        description: `KOT ${attempt.ticket.ticketNumber}`,
      });
    }

    // ── Cashier bills ──
    const billJobs = await this.prisma.printJob.findMany({
      where: {
        tenantId: agent.tenantId,
        branchId: agent.branchId,
        type: PrintJobType.ORDER_BILL,
        status: PrintJobStatus.PENDING,
        printerId: { not: null },
        leasedAt: null,
        attemptCount: { lt: PRINT_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
    for (const job of billJobs) {
      const printer = await this.prisma.kitchenPrinter.findFirst({
        where: { id: job.printerId!, tenantId: job.tenantId, isActive: true },
      });
      if (!printer) continue;
      // Settled bill (Sale) or a bill printed at placement (order) — the
      // agent gets identical bytes either way.
      const payload = await this.dispatcher.renderBillPayload(
        job.tenantId,
        { saleId: job.saleId, orderId: job.orderId },
        job.copies > 1,
        printer.columns,
      );
      if (!payload) continue;
      const leaseId = randomBytes(12).toString('hex');
      const claimed = await this.prisma.printJob.updateMany({
        where: { id: job.id, leasedAt: null, status: PrintJobStatus.PENDING },
        data: { leaseId, leasedAt: new Date(), leasedBy: agent.agentId },
      });
      if (claimed.count === 0) continue;
      jobs.push({
        leaseId,
        source: 'CASHIER',
        jobId: job.id,
        printer: printerView(printer),
        copies: job.copies,
        payloadBase64: payload.toString('base64'),
        description: `Bill ${job.saleId}`,
      });
    }

    return jobs;
  }

  /** Terminal outcome for one leased row. */
  async ack(
    agent: { agentId: string; tenantId: string },
    input: { leaseId: string; ok: boolean; error?: string },
  ): Promise<{ ok: true }> {
    const attempt = await this.prisma.kitchenPrintAttempt.findFirst({
      where: { leaseId: input.leaseId, tenantId: agent.tenantId },
    });
    if (attempt) {
      if (input.ok) {
        await this.prisma.$transaction([
          this.prisma.kitchenPrintAttempt.update({
            where: { id: attempt.id },
            data: {
              status: KitchenPrintAttemptStatus.SUCCEEDED,
              completedAt: new Date(),
              error: null,
              leaseId: null,
              leasedAt: null,
            },
          }),
          this.prisma.kitchenTicket.update({
            where: { id: attempt.ticketId },
            data: { status: KitchenTicketStatus.PRINTED },
          }),
        ]);
      } else {
        await this.dispatcher.recordKitchenFailure(attempt, input.error ?? 'Agent print failed');
      }
      return { ok: true };
    }

    const job = await this.prisma.printJob.findFirst({
      where: { leaseId: input.leaseId, tenantId: agent.tenantId },
    });
    if (job) {
      if (input.ok) {
        await this.prisma.printJob.update({
          where: { id: job.id },
          data: {
            status: PrintJobStatus.PRINTED,
            printedAt: new Date(),
            attemptCount: { increment: 1 },
            lastError: null,
            leaseId: null,
            leasedAt: null,
          },
        });
      } else {
        await this.dispatcher.recordBillFailure(
          job.id,
          job.attemptCount,
          input.error ?? 'Agent print failed',
        );
      }
      return { ok: true };
    }

    // An unknown lease is not an error: it is almost always an ack arriving
    // after its own lease expired and the row was reclaimed. Saying "ok" and
    // logging beats failing an agent that did nothing wrong.
    this.logger.warn(`Ack for unknown/expired lease ${input.leaseId} from agent ${agent.agentId}`);
    return { ok: true };
  }

  /** Release leases whose holder went away, so the work is printable again. */
  async reclaimExpiredLeases(): Promise<void> {
    const cutoff = new Date(Date.now() - PRINT_LEASE_TTL_MS);
    await this.prisma.kitchenPrintAttempt.updateMany({
      where: { leasedAt: { lt: cutoff }, status: KitchenPrintAttemptStatus.PENDING },
      data: { leaseId: null, leasedAt: null, leasedBy: null },
    });
    await this.prisma.printJob.updateMany({
      where: { leasedAt: { lt: cutoff }, status: PrintJobStatus.PENDING },
      data: { leaseId: null, leasedAt: null, leasedBy: null },
    });
  }
}

function printerView(printer: {
  id: string;
  name: string;
  kind: string;
  address: string;
  columns: number;
}) {
  return {
    id: printer.id,
    name: printer.name,
    kind: printer.kind,
    address: printer.address,
    columns: printer.columns,
  };
}
