/**
 * D106 — the pure derivation the Orders queue shows, finally exercised end
 * to end now that the kitchen MOVES rounds (start → IN_PROGRESS, full bump →
 * READY). The function predates D106 unchanged; what changed is that its
 * IN_PROGRESS/READY branches stopped being dead code, so they get pinned.
 *
 * Paired per D30: every branch is asserted with the input that reaches it
 * AND a neighbour that must not — a derivation returning IN_PROGRESS for
 * everything would fail the PENDING and READY halves.
 */
import { unifiedStatusForRestaurantOrder } from './restaurant-orders.service';

describe('unifiedStatusForRestaurantOrder (D106 — rounds drive the queue)', () => {
  const dineIn = (roundStatuses: string[]) =>
    unifiedStatusForRestaurantOrder({
      orderStatus: 'SUBMITTED',
      roundStatuses,
      takeawayStatus: null,
    });

  it('kitchen progress maps: untouched → PENDING, any started → IN_PROGRESS, all ready → READY', () => {
    expect(dineIn(['SUBMITTED'])).toBe('PENDING');
    expect(dineIn(['SUBMITTED', 'SUBMITTED'])).toBe('PENDING');
    // One round started is enough for the queue to say the kitchen is on it…
    expect(dineIn(['IN_PROGRESS', 'SUBMITTED'])).toBe('IN_PROGRESS');
    // …and one round still open keeps the order OFF ready.
    expect(dineIn(['READY', 'SUBMITTED'])).toBe('IN_PROGRESS');
    expect(dineIn(['READY', 'READY'])).toBe('READY');
    // A served round does not un-ready the order.
    expect(dineIn(['READY', 'DELIVERED'])).toBe('READY');
  });

  it('an order with no rounds yet is PENDING, not READY-by-vacuous-every', () => {
    expect(dineIn([])).toBe('PENDING');
  });

  it('the order shell short-circuits the rounds', () => {
    for (const [orderStatus, expected] of [
      ['CANCELLED', 'CANCELLED'],
      ['COMPLETED', 'COMPLETED'],
      ['DRAFT', 'DRAFT'],
    ] as const) {
      expect(
        unifiedStatusForRestaurantOrder({
          orderStatus,
          // Rounds that would otherwise read READY — proving the shell wins.
          roundStatuses: ['READY'],
          takeawayStatus: null,
        }),
      ).toBe(expected);
    }
  });

  it('a takeaway profile outranks the rounds — it is what the customer was told', () => {
    for (const [takeawayStatus, expected] of [
      ['PLACED', 'PENDING'],
      ['IN_KITCHEN', 'IN_PROGRESS'],
      ['READY', 'READY'],
      ['HANDED_OVER', 'HANDED_OVER'],
      ['CANCELLED', 'CANCELLED'],
    ] as const) {
      expect(
        unifiedStatusForRestaurantOrder({
          orderStatus: 'SUBMITTED',
          // Contrary round state on purpose: the profile must win.
          roundStatuses: ['SUBMITTED'],
          takeawayStatus,
        }),
      ).toBe(expected);
    }
  });
});
