import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SyncJob } from '@hardware-pos/database';

import { mirrorExternalRef } from '../../quickbooks/external-ref';
import { PrismaService } from '../../../prisma/prisma.service';
import { SyncDirection, SyncEntityType, SyncJobType } from './sync-queue.constants';

/** Config knobs for retry backoff and stale-job recovery. */
interface QueueConfig {
  backoffBaseMs: number;
  staleMs: number;
}

/**
 * DB-backed sync queue. This is the seam to swap for BullMQ/Redis: producers call
 * {@link enqueueSaleSync}, the worker calls {@link claimDueJobs} /
 * {@link markSucceeded} / {@link markFailed}, and the "Retry Sync" button calls
 * {@link requeueSale}. A BullMQ implementation would keep the same surface and
 * back it with a Redis queue instead of the `SyncJob` table.
 */
@Injectable()
export class SyncQueueService {
  private readonly logger = new Logger(SyncQueueService.name);
  private readonly config: QueueConfig;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.config = {
      backoffBaseMs: configService.get<number>('SYNC_RETRY_BACKOFF_MS', 30_000),
      staleMs: configService.get<number>('SYNC_STALE_MS', 120_000),
    };
  }

  /**
   * Enqueue an outbound sale sync as part of the sale-completion transaction
   * (transactional outbox). Pass the surrounding transaction client so the job is
   * committed atomically with the sale.
   */
  async enqueueSaleSync(
    tx: Prisma.TransactionClient,
    tenantId: string,
    saleId: string,
  ): Promise<void> {
    await tx.syncJob.create({
      data: {
        tenantId,
        type: SyncJobType.SALES_SYNC,
        direction: SyncDirection.OUTBOUND,
        entityType: SyncEntityType.SALE,
        entityId: saleId,
        status: 'PENDING',
      },
    });
    await tx.syncLog.create({
      data: {
        tenantId,
        entityType: SyncEntityType.SALE,
        entityId: saleId,
        direction: SyncDirection.OUTBOUND,
        status: 'PENDING',
        message: 'Sale queued for QuickBooks sync',
      },
    });
  }

  /**
   * Enqueue an outbound return sync as part of the return-completion transaction
   * (transactional outbox). Committed atomically with the Return so a failed
   * QuickBooks push never loses the return.
   */
  async enqueueReturnSync(
    tx: Prisma.TransactionClient,
    tenantId: string,
    returnId: string,
  ): Promise<void> {
    await tx.syncJob.create({
      data: {
        tenantId,
        type: SyncJobType.RETURN_SYNC,
        direction: SyncDirection.OUTBOUND,
        entityType: SyncEntityType.RETURN,
        entityId: returnId,
        status: 'PENDING',
      },
    });
    await tx.syncLog.create({
      data: {
        tenantId,
        entityType: SyncEntityType.RETURN,
        entityId: returnId,
        direction: SyncDirection.OUTBOUND,
        status: 'PENDING',
        message: 'Return queued for QuickBooks sync',
      },
    });
  }

  /**
   * Enqueue an outbound product push (create/update the QBO Item). Only queues
   * when an active QuickBooks connection exists — otherwise returns false and
   * the product simply stays local. Safe to call outside a transaction: unlike
   * sales, a product row exists independently of its sync job.
   */
  async enqueueProductSync(tenantId: string, productId: string): Promise<boolean> {
    const connection = await this.prisma.quickBooksConnection.findUnique({
      where: { tenantId },
      select: { isActive: true },
    });
    if (!connection?.isActive) return false;

    await this.prisma.$transaction([
      this.prisma.syncJob.create({
        data: {
          tenantId,
          type: SyncJobType.PRODUCT_SYNC,
          direction: SyncDirection.OUTBOUND,
          entityType: SyncEntityType.PRODUCT,
          entityId: productId,
          status: 'PENDING',
        },
      }),
      this.prisma.syncLog.create({
        data: {
          tenantId,
          entityType: SyncEntityType.PRODUCT,
          entityId: productId,
          direction: SyncDirection.OUTBOUND,
          status: 'PENDING',
          message: 'Product queued for QuickBooks sync',
        },
      }),
    ]);
    return true;
  }

  /**
   * Atomically claim up to `limit` due jobs. A job is due when it is PENDING, its
   * `scheduledAt` has passed, and it still has attempts left. Claiming flips it to
   * SYNCING and increments `attempts`; the conditional update makes concurrent
   * workers safe (only one wins each job).
   */
  async claimDueJobs(limit: number): Promise<SyncJob[]> {
    const now = new Date();
    const candidates = await this.prisma.syncJob.findMany({
      where: { status: 'PENDING', scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
    });

    const claimed: SyncJob[] = [];
    for (const job of candidates) {
      if (job.attempts >= job.maxAttempts) continue; // exhausted; leave for manual retry
      const res = await this.prisma.syncJob.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'SYNCING', startedAt: now, attempts: { increment: 1 } },
      });
      if (res.count === 1) claimed.push({ ...job, status: 'SYNCING', attempts: job.attempts + 1 });
    }
    return claimed;
  }

  async markSucceeded(jobId: string): Promise<void> {
    await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'SYNCED', completedAt: new Date(), lastError: null },
    });
  }

  /**
   * Record a failed attempt. Reschedules the job (back to PENDING with a linear
   * backoff) while attempts remain, otherwise leaves it FAILED for a manual retry.
   */
  async markFailed(job: Pick<SyncJob, 'id' | 'attempts' | 'maxAttempts'>, message: string): Promise<void> {
    if (job.attempts < job.maxAttempts) {
      const delayMs = this.config.backoffBaseMs * job.attempts;
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          scheduledAt: new Date(Date.now() + delayMs),
          startedAt: null,
          lastError: message,
        },
      });
      this.logger.warn(
        `Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}); retrying in ${delayMs}ms`,
      );
    } else {
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', lastError: message },
      });
      this.logger.error(`Job ${job.id} failed permanently after ${job.attempts} attempts: ${message}`);
    }
  }

  /**
   * Manual "Retry Sync": re-queue the latest sync job for a sale with a fresh
   * attempt budget so the worker picks it up again. Also resets the sale's sync
   * status to PENDING.
   */
  async requeueSale(tenantId: string, saleId: string): Promise<{ id: string; syncStatus: string }> {
    const job = await this.prisma.syncJob.findFirst({
      where: { tenantId, entityType: SyncEntityType.SALE, entityId: saleId },
      orderBy: { createdAt: 'desc' },
    });
    if (!job) {
      throw new NotFoundException(`No sync job found for sale ${saleId}`);
    }

    await this.prisma.$transaction([
      this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          attempts: 0,
          scheduledAt: new Date(),
          startedAt: null,
          completedAt: null,
          lastError: null,
        },
      }),
      this.prisma.sale.updateMany({
        where: { id: saleId, tenantId },
        data: { syncStatus: 'PENDING', syncError: null },
      }),
    ]);
    // D63 dual-write.
    await mirrorExternalRef(this.prisma, tenantId, 'SALE', saleId, {
      syncStatus: 'PENDING',
      syncError: null,
    });

    return { id: job.id, syncStatus: 'PENDING' };
  }

  /**
   * Manual "Retry Sync" for a return: re-queue its latest sync job with a fresh
   * attempt budget and reset the return's sync status to PENDING.
   */
  async requeueReturn(tenantId: string, returnId: string): Promise<{ id: string; syncStatus: string }> {
    const job = await this.prisma.syncJob.findFirst({
      where: { tenantId, entityType: SyncEntityType.RETURN, entityId: returnId },
      orderBy: { createdAt: 'desc' },
    });
    if (!job) {
      throw new NotFoundException(`No sync job found for return ${returnId}`);
    }

    await this.prisma.$transaction([
      this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          attempts: 0,
          scheduledAt: new Date(),
          startedAt: null,
          completedAt: null,
          lastError: null,
        },
      }),
      this.prisma.return.updateMany({
        where: { id: returnId, tenantId },
        data: { syncStatus: 'PENDING', syncError: null },
      }),
    ]);
    // D63 dual-write.
    await mirrorExternalRef(this.prisma, tenantId, 'RETURN', returnId, {
      syncStatus: 'PENDING',
      syncError: null,
    });

    return { id: job.id, syncStatus: 'PENDING' };
  }

  /**
   * Recover jobs stuck in SYNCING (e.g. a worker crashed mid-process) by returning
   * those older than the stale window to PENDING so they are retried.
   */
  async reclaimStaleJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.staleMs);
    const res = await this.prisma.syncJob.updateMany({
      where: { status: 'SYNCING', startedAt: { lt: cutoff } },
      data: { status: 'PENDING', startedAt: null },
    });
    if (res.count > 0) this.logger.warn(`Reclaimed ${res.count} stale SYNCING job(s)`);
    return res.count;
  }
}
