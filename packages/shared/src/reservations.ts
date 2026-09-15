/**
 * Reservation timing rules, shared by the browser and the API (D199).
 *
 * One grace, two uses, one constant — so the host stand and the server cannot
 * disagree about when a booking has "started":
 *
 *  - **Booking behind "now".** A host typing in a walk-up party that arrived
 *    five minutes ago is recording reality, not booking the past. A start
 *    within the grace is accepted; further back is refused.
 *  - **Calling a no-show.** A guest is not a no-show at their booked minute —
 *    the industry holds a table for a short while first. Before the grace has
 *    run, the only honest verb for an absent party is Cancel.
 *
 * Fifteen minutes is the conventional hold and what this system has used for
 * walk-ups since D47; it is deliberately not a tenant setting.
 */
export const RESERVATION_GRACE_MS = 15 * 60 * 1000;

/** The first instant at which a BOOKED reservation may be marked NO_SHOW. */
export function noShowAvailableFrom(startAt: Date | string): Date {
  return new Date(new Date(startAt).getTime() + RESERVATION_GRACE_MS);
}

/**
 * Whether "no-show" is an honest answer yet.
 *
 * `now` is a parameter so the same rule can be asserted at fixed instants and
 * so a screen can re-ask it on a tick without reading the clock itself.
 */
export function canMarkNoShow(startAt: Date | string, now: number = Date.now()): boolean {
  return now >= noShowAvailableFrom(startAt).getTime();
}
