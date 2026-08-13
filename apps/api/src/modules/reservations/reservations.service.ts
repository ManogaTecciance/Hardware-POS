import { Injectable } from '@nestjs/common';
import { Prisma, ReservationStatus } from '@hardware-pos/database';

import { nextDocumentNumber, padSequence } from '../../common/document-sequence';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReservationDto, UpdateReservationDto } from './dto/reservations.dto';
import {
  BranchNotFoundError,
  InvalidListWindowError,
  ReservationInPastError,
  ReservationNotFoundError,
  ReservationOverlapError,
  ReservationStatusConflictError,
  TableNotFoundError,
} from './reservations.errors';

export interface ReservationView {
  id: string;
  branchId: string;
  tableId: string;
  reservationNumber: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  startAt: Date;
  endAt: Date;
  status: ReservationStatus;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

/**
 * The statuses that hold a timeslot. Explicit list, not `!= CANCELLED`, so a
 * status added later must be classified deliberately — silently defaulting to
 * "doesn't block" would let two parties book one table (same rule as
 * IN_SERVICE_SESSION_STATUSES in dining.service).
 */
const BLOCKING_STATUSES: readonly ReservationStatus[] = ['BOOKED', 'SEATED'];

/**
 * Editable states. A COMPLETED / CANCELLED / NO_SHOW reservation is history;
 * edits would rewrite what actually happened that evening.
 */
const EDITABLE_STATUSES: readonly ReservationStatus[] = ['BOOKED', 'SEATED'];

/**
 * The full lifecycle. SEATED → BOOKED exists solely as the "un-seat"
 * correction for a mis-click; the three closed states are terminal.
 */
const STATUS_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  BOOKED: ['SEATED', 'CANCELLED', 'NO_SHOW'],
  SEATED: ['COMPLETED', 'BOOKED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/**
 * Grace behind "now" for new bookings. A host typing in a walk-up party that
 * arrived five minutes ago is recording reality, not booking the past.
 */
const PAST_GRACE_MS = 15 * 60 * 1000;

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every reservation intersecting `[from, to)`. The client supplies explicit
   * instants (its local day window) — the server never guesses the display
   * timezone (D47).
   */
  async list(
    tenantId: string,
    branchId: string,
    from: Date,
    to: Date,
    includeClosed = false,
  ): Promise<ReservationView[]> {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new InvalidListWindowError();
    }
    await this.assertBranch(tenantId, branchId);
    const rows = await this.prisma.tableReservation.findMany({
      where: {
        tenantId,
        branchId,
        startAt: { lt: to },
        endAt: { gt: from },
        ...(includeClosed ? {} : { status: { in: [...BLOCKING_STATUSES, 'COMPLETED'] } }),
      },
      orderBy: [{ startAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(this.toView);
  }

  async create(
    tenantId: string,
    branchId: string,
    actorUserId: string,
    dto: CreateReservationDto,
  ): Promise<ReservationView> {
    await this.assertBranch(tenantId, branchId);
    const startAt = new Date(dto.startAt);
    const endAt = new Date(startAt.getTime() + dto.durationMinutes * 60_000);
    if (startAt.getTime() < Date.now() - PAST_GRACE_MS) throw new ReservationInPastError();

    const created = await this.prisma.$transaction(async (tx) => {
      await this.lockTableAndAssertFree(tx, tenantId, branchId, dto.tableId, startAt, endAt);
      const sequence = await nextDocumentNumber(tx, tenantId, 'RESERVATION');
      return tx.tableReservation.create({
        data: {
          tenantId,
          branchId,
          tableId: dto.tableId,
          reservationNumber: `RSV-${padSequence(sequence)}`,
          customerId: dto.customerId ?? null,
          customerName: dto.customerName.trim(),
          customerPhone: dto.customerPhone?.trim() || null,
          partySize: dto.partySize,
          startAt,
          endAt,
          notes: dto.notes ?? null,
          // Attribution comes from the authenticated actor, never the DTO.
          createdByUserId: actorUserId,
        },
      });
    });
    return this.toView(created);
  }

  async update(
    tenantId: string,
    reservationId: string,
    dto: UpdateReservationDto,
  ): Promise<ReservationView> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tableReservation.findFirst({
        where: { id: reservationId, tenantId },
      });
      if (!existing) throw new ReservationNotFoundError();
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new ReservationStatusConflictError(existing.status, 'edited');
      }

      const tableId = dto.tableId ?? existing.tableId;
      const startAt = dto.startAt ? new Date(dto.startAt) : existing.startAt;
      const durationMs = dto.durationMinutes
        ? dto.durationMinutes * 60_000
        : existing.endAt.getTime() - existing.startAt.getTime();
      const endAt = new Date(startAt.getTime() + durationMs);

      const slotMoved =
        tableId !== existing.tableId ||
        startAt.getTime() !== existing.startAt.getTime() ||
        endAt.getTime() !== existing.endAt.getTime();
      if (slotMoved) {
        // Only a slot that actually moves may not land in the past — editing
        // the notes of a booking currently underway must not be rejected.
        if (startAt.getTime() < Date.now() - PAST_GRACE_MS) throw new ReservationInPastError();
        await this.lockTableAndAssertFree(tx, tenantId, existing.branchId, tableId, startAt, endAt, existing.id);
      }

      return tx.tableReservation.update({
        where: { id: existing.id },
        data: {
          tableId,
          startAt,
          endAt,
          ...(dto.customerId !== undefined ? { customerId: dto.customerId || null } : {}),
          ...(dto.customerName !== undefined ? { customerName: dto.customerName.trim() } : {}),
          ...(dto.customerPhone !== undefined ? { customerPhone: dto.customerPhone.trim() || null } : {}),
          ...(dto.partySize !== undefined ? { partySize: dto.partySize } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
        },
      });
    });
    return this.toView(updated);
  }

  async setStatus(
    tenantId: string,
    reservationId: string,
    status: ReservationStatus,
  ): Promise<ReservationView> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tableReservation.findFirst({
        where: { id: reservationId, tenantId },
      });
      if (!existing) throw new ReservationNotFoundError();
      if (!STATUS_TRANSITIONS[existing.status].includes(status)) {
        throw new ReservationStatusConflictError(existing.status, status);
      }
      // Un-seating re-opens the slot claim, so it must not have been given
      // away in the meantime — re-run the overlap check like any move.
      if (existing.status === 'SEATED' && status === 'BOOKED') {
        await this.lockTableAndAssertFree(
          tx,
          tenantId,
          existing.branchId,
          existing.tableId,
          existing.startAt,
          existing.endAt,
          existing.id,
        );
      }
      return tx.tableReservation.update({ where: { id: existing.id }, data: { status } });
    });
    return this.toView(updated);
  }

  // ── internals ───────────────────────────────────────────────

  /**
   * The double-booking guard (D47). The `FOR UPDATE` on the RestaurantTable
   * row serialises concurrent writers per table: two clerks booking the same
   * table race on this lock and the loser sees the winner's row in the
   * overlap query. Half-open intervals — `[19:00, 20:30)` does not collide
   * with a booking starting exactly at 20:30.
   */
  private async lockTableAndAssertFree(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    tableId: string,
    startAt: Date,
    endAt: Date,
    excludeReservationId?: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "RestaurantTable" WHERE id = ${tableId} FOR UPDATE`;
    const table = await tx.restaurantTable.findFirst({
      // kind: a transient open table (D49) has no business on the calendar —
      // it dissolves when its bill closes, taking any booking with it.
      where: { id: tableId, tenantId, branchId, isActive: true, kind: 'PHYSICAL' },
      select: { id: true },
    });
    if (!table) throw new TableNotFoundError();

    const clash = await tx.tableReservation.findFirst({
      where: {
        tableId,
        status: { in: [...BLOCKING_STATUSES] },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { reservationNumber: true },
      orderBy: { startAt: 'asc' },
    });
    if (clash) throw new ReservationOverlapError(clash.reservationNumber);
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new BranchNotFoundError();
  }

  private toView = (row: {
    id: string;
    branchId: string;
    tableId: string;
    reservationNumber: string;
    customerId: string | null;
    customerName: string;
    customerPhone: string | null;
    partySize: number;
    startAt: Date;
    endAt: Date;
    status: ReservationStatus;
    notes: string | null;
    createdByUserId: string | null;
    createdAt: Date;
  }): ReservationView => ({
    id: row.id,
    branchId: row.branchId,
    tableId: row.tableId,
    reservationNumber: row.reservationNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    partySize: row.partySize,
    startAt: row.startAt,
    endAt: row.endAt,
    status: row.status,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  });
}
