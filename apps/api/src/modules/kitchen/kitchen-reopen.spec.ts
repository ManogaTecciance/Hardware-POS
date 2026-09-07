import { Prisma } from '@hardware-pos/database';

import { KitchenService, KitchenTicketNotFoundError } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * `reopenTicket` — D100's recall verb, the inverse of the bump.
 *
 * What is worth pinning:
 *
 * - Recalling a COMPLETED ticket rewrites it to QUEUED and CLEARS the
 *   completion record (completedAt + completedByUserId), because a recalled
 *   ticket is work to do again and a stale "done by" name says otherwise.
 * - Recalling a ticket that was never completed writes nothing — the
 *   idempotency mirror of completeTicket, for the same double-tap reason.
 * - A ticket outside the tenant/branch is a KitchenTicketNotFoundError, not
 *   a cross-tenant write.
 *
 * Prisma is a stub; assertions are about the write the service issues, not
 * the database.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const TICKET = 'tkt_1';

/** The TICKET_INCLUDE shape the read-back path projects into the view. */
function fullRow(status: 'QUEUED' | 'COMPLETED') {
  return {
    id: TICKET,
    ticketNumber: 'KOT-000042',
    branchId: BRANCH,
    roundId: 'rnd_1',
    stationId: 'stn_1',
    status,
    completedAt: null,
    createdAt: new Date('2026-09-03T12:00:00Z'),
    items: [
      {
        id: 'kti_1',
        menuItemName: 'Kottu',
        variantName: null,
        quantity: new Prisma.Decimal(1),
        modifierNames: [],
        specialInstructions: null,
      },
    ],
    station: { name: 'Grill' },
    completedBy: null,
    round: {
      roundNumber: 1,
      order: {
        orderNumber: 'RO-000010',
        session: {
          waiterUserId: null,
          table: { code: 'T1', area: { name: 'Main' } },
        },
      },
    },
  };
}

function makeService(ticketRow: { id: string; status: string; roundId?: string } | null) {
  const update = jest.fn().mockResolvedValue(undefined);
  const tx = {
    kitchenTicket: {
      findFirst: jest.fn().mockResolvedValue(ticketRow),
      update,
      findFirstOrThrow: jest.fn().mockResolvedValue(fullRow('QUEUED')),
    },
    // D106 — the recall now restates round/takeaway state. A null round makes
    // that a no-op HERE on purpose: this spec pins the reopen WRITE, and the
    // ripple is pinned where it can be real — the D106 integration tests in
    // kitchen-board.spec.ts, against actual rows.
    orderRound: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  return { service: new KitchenService(prisma), tx, update };
}

describe('KitchenService.reopenTicket (D100)', () => {
  it('rewrites a completed ticket to QUEUED and clears who finished it', async () => {
    const { service, tx, update } = makeService({ id: TICKET, status: 'COMPLETED' });

    const view = await service.reopenTicket(TENANT, BRANCH, TICKET);

    expect(tx.kitchenTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TICKET, tenantId: TENANT, branchId: BRANCH },
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: TICKET },
      data: { status: 'QUEUED', completedAt: null, completedByUserId: null },
    });
    expect(view.status).toBe('QUEUED');
    expect(view.completedAt).toBeNull();
    expect(view.completedByName).toBeNull();
  });

  it('writes nothing when the ticket was never completed', async () => {
    const { service, update } = makeService({ id: TICKET, status: 'QUEUED' });

    const view = await service.reopenTicket(TENANT, BRANCH, TICKET);

    expect(update).not.toHaveBeenCalled();
    // The view still comes back — the caller cannot tell a no-op from a
    // recall, which is the point of the idempotency mirror.
    expect(view.id).toBe(TICKET);
  });

  it('refuses a ticket outside the tenant or branch', async () => {
    const { service, update } = makeService(null);

    await expect(service.reopenTicket(TENANT, BRANCH, TICKET)).rejects.toBeInstanceOf(
      KitchenTicketNotFoundError,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
