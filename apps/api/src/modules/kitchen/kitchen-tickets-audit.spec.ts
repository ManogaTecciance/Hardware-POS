import { KitchenTicketsController } from './kitchen-tickets.controller';
import type { KitchenService, KitchenTicketView } from './kitchen.service';
import type { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * D152 — the audit trail names the station again.
 *
 * D147 took `stationId` off the three ticket verbs' metadata, on the reasoning
 * that a ticket then belonged to no station and a permanently-null key reads
 * as data that went missing rather than data that stopped existing. With the
 * split back, the station is the line that took the food — which is precisely
 * what an audit trail gets asked about a bump — so it goes back on.
 *
 * Pinned in both directions (D30): the key is present AND carries the value
 * the service returned, beside the `ticketNumber` that was never in question.
 * "Metadata contains stationId" asserted alone would hold for a controller
 * that wrote a hard-coded null on every entry, which is the one outcome D147's
 * reasoning was actually against — so the null case has its own test, and it
 * asserts the ONE row for which null is the truth.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const TICKET = 'tkt_1';
const ACTOR = { id: 'usr_1' } as AuthenticatedUser;

function view(stationId: string | null): KitchenTicketView {
  return {
    id: TICKET,
    ticketNumber: 'KOT-000027',
    branchId: BRANCH,
    roundId: 'rnd_1',
    stationId,
    stationName: stationId ? 'Grill' : null,
    status: 'QUEUED',
    orderNumber: 'RO-000026',
    placeLabel: 'T4 · Terrace',
    roundNumber: 1,
    waiterName: 'Nimal',
    items: [],
    completedAt: null,
    completedByName: null,
    createdAt: '2026-09-09T04:30:00.000Z',
  } as KitchenTicketView;
}

function makeController(stationId: string | null = 'stn_grill') {
  const record = jest.fn().mockResolvedValue(undefined);
  const service = {
    startTicket: jest.fn().mockResolvedValue(view(stationId)),
    completeTicket: jest.fn().mockResolvedValue(view(stationId)),
    reopenTicket: jest.fn().mockResolvedValue(view(stationId)),
  } as unknown as KitchenService;
  const controller = new KitchenTicketsController(service, {
    record,
  } as unknown as AuditLogService);
  return { controller, record };
}

/** The metadata of the last entry the controller recorded. */
function lastMetadata(record: jest.Mock): Record<string, unknown> {
  const call = record.mock.calls.at(-1);
  if (!call) throw new Error('no audit entry was written — the assertion would be vacuous');
  return (call[1] as { metadata: Record<string, unknown> }).metadata;
}

describe('the kitchen ticket verbs record the station (D152)', () => {
  it.each([
    ['start', 'KITCHEN_TICKET_STARTED'],
    ['complete', 'KITCHEN_TICKET_COMPLETED'],
    ['reopen', 'KITCHEN_TICKET_REOPENED'],
  ] as const)('%s writes ticketNumber AND stationId', async (verb, action) => {
    const { controller, record } = makeController();

    if (verb === 'start') await controller.start(TENANT, ACTOR, BRANCH, TICKET);
    if (verb === 'complete') await controller.complete(TENANT, ACTOR, BRANCH, TICKET);
    if (verb === 'reopen') await controller.reopen(TENANT, ACTOR, BRANCH, TICKET);

    // POSITIVE — the whole entry, so this cannot pass by the metadata having
    // become the only thing the controller still writes.
    expect(record).toHaveBeenCalledWith(TENANT, {
      userId: ACTOR.id,
      action,
      entityType: 'KitchenTicket',
      entityId: TICKET,
      metadata: { ticketNumber: 'KOT-000027', stationId: 'stn_grill' },
    });
    // …and the key really carries the service's value rather than being
    // present-and-empty, which is the shape D147 objected to.
    expect(lastMetadata(record).stationId).toBe('stn_grill');
  });

  it('a ticket from the D147 window records a null station, not a fabricated one', async () => {
    // The column is still nullable and nothing was backfilled. Null here is
    // the truth about that row; inventing a station for it would be a claim
    // about where food went that nothing supports.
    const { controller, record } = makeController(null);

    await controller.complete(TENANT, ACTOR, BRANCH, TICKET);

    const metadata = lastMetadata(record);
    expect(metadata.stationId).toBeNull();
    // POSITIVE — and the key is genuinely written rather than merely absent,
    // which `toBeNull` alone would not distinguish from a missing property.
    expect('stationId' in metadata).toBe(true);
    expect(metadata.ticketNumber).toBe('KOT-000027');
  });
});
