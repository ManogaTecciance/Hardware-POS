import { TableSessionStatus } from '@hardware-pos/database';

/**
 * D104 — the session statuses that mean "a party is sitting here right now".
 *
 * One list, because three separate questions depend on the same answer and must
 * not drift apart: may this table take another tab (seats), may this
 * arrangement be dissolved, and may this table be archived. A party waiting for
 * its bill is still in its chairs, so BILLING counts exactly as OPEN does.
 *
 * Written as an explicit list rather than `NOT CLOSED` so a session status
 * added later forces someone to classify it deliberately — silently defaulting
 * a new status to "not sitting here" would free a table with guests at it.
 */
export const LIVE_SESSION_STATUSES: readonly TableSessionStatus[] = [
  TableSessionStatus.OPEN,
  TableSessionStatus.BILLING,
];
