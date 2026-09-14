import { dayInTimeZone, safeTimeZone } from '@hardware-pos/shared';

import {
  nextDocumentNumber,
  nextScopedCounter,
  orderCallCounterKey,
  padSequence,
  type PrismaLike,
} from './document-sequence';

/**
 * D197 — a restaurant order carries TWO numbers, and this is the one place
 * that mints them.
 *
 *  - `orderNumber` (`RO-000120`) is the permanent identifier: tenant-wide,
 *    never reused, what a sale's `sourceRefId` and the audit log point at. It
 *    is the right thing to search for and the wrong thing to shout across a
 *    counter — six digits that only grow.
 *  - `callNumber` (`47`) is what the counter and the guest say out loud.
 *    It restarts at 1 for each branch each business day, so "forty-seven" is
 *    always short and, on the day it is said, unambiguous within the branch.
 *    It is a call-out, not an identifier: the same `47` exists tomorrow, and
 *    across the road in the other branch.
 *
 * Dine-in, takeaway and third-party orders all come through here so the two
 * counters cannot drift apart between channels — a third-party order that
 * reached the kitchen without a call number would be the one the pass could
 * not name at handover.
 *
 * The business day is the calendar day in the tenant's zone. A branch that
 * trades past midnight rolls at 00:00 local, not at close; a configurable
 * rollover hour is an open question (O14), not a silent assumption.
 */
export interface OrderNumbers {
  orderNumber: string;
  callNumber: number;
  /** `YYYY-MM-DD` in the tenant's zone — the day `callNumber` counts within. */
  callDay: string;
}

export async function mintOrderNumbers(
  client: PrismaLike,
  tenantId: string,
  branchId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<OrderNumbers> {
  const callDay = dayInTimeZone(now, safeTimeZone(timeZone));
  // Sequential on purpose: the caller hands us its transaction client, and an
  // interactive transaction is one connection.
  const seq = await nextDocumentNumber(client, tenantId, 'RESTAURANT_ORDER');
  const callNumber = await nextScopedCounter(
    client,
    tenantId,
    orderCallCounterKey(branchId, callDay),
  );
  return { orderNumber: `RO-${padSequence(seq)}`, callNumber, callDay };
}
