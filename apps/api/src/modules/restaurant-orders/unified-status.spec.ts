/**
 * D113 — the pure derivation the Orders queue shows, finally exercised end
 * to end now that the kitchen MOVES rounds (start → IN_PROGRESS, full bump →
 * READY). The function predates D113 unchanged; what changed is that its
 * IN_PROGRESS/READY branches stopped being dead code, so they get pinned.
 *
 * Paired per D30: every branch is asserted with the input that reaches it
 * AND a neighbour that must not — a derivation returning IN_PROGRESS for
 * everything would fail the PENDING and READY halves.
 */
import { unifiedStatusForRestaurantOrder } from './restaurant-orders.service';

describe('unifiedStatusForRestaurantOrder (D113 — rounds drive the queue)', () => {
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

/**
 * D178 — the session outranks the rounds once the bill is at the till.
 *
 * Paired: BILLING yields AWAITING_PAYMENT whatever the rounds say (positive),
 * and the SAME rounds under OPEN, CLOSED or an absent session yield exactly
 * what they did before D178 (negative) — a derivation that read "any session
 * status set" as "at the till" would fail the second half.
 */
describe('unifiedStatusForRestaurantOrder (D178 — the session drives To pay)', () => {
  const withSession = (
    sessionStatus: 'OPEN' | 'BILLING' | 'CLOSED' | null | undefined,
    roundStatuses: string[] = ['DELIVERED'],
    orderStatus: 'SUBMITTED' | 'COMPLETED' | 'CANCELLED' = 'SUBMITTED',
  ) =>
    unifiedStatusForRestaurantOrder({ orderStatus, roundStatuses, takeawayStatus: null, sessionStatus });

  it('BILLING puts the order in To pay, however far the kitchen got', () => {
    expect(withSession('BILLING', ['DELIVERED'])).toBe('AWAITING_PAYMENT');
    expect(withSession('BILLING', ['READY', 'DELIVERED'])).toBe('AWAITING_PAYMENT');
    // A round the kitchen still holds does not keep the bill off the till.
    expect(withSession('BILLING', ['SUBMITTED'])).toBe('AWAITING_PAYMENT');
    expect(withSession('BILLING', [])).toBe('AWAITING_PAYMENT');
  });

  it('serving alone does not — DELIVERED rounds under an OPEN session still read Ready', () => {
    expect(withSession('OPEN', ['DELIVERED'])).toBe('READY');
    expect(withSession('OPEN', ['DELIVERED', 'SUBMITTED'])).toBe('IN_PROGRESS');
    // Callers from before D178 pass no session at all and derive as they did.
    expect(withSession(undefined, ['DELIVERED'])).toBe('READY');
    expect(withSession(null, ['READY'])).toBe('READY');
  });

  it('the order shell still wins: a COMPLETED or CANCELLED order is never To pay', () => {
    expect(withSession('BILLING', ['DELIVERED'], 'COMPLETED')).toBe('COMPLETED');
    expect(withSession('BILLING', ['DELIVERED'], 'CANCELLED')).toBe('CANCELLED');
    // …and a CLOSED session (the bill is paid) is COMPLETED via the shell, not
    // via the session — the payment writes both, and the shell is what is read.
    expect(withSession('CLOSED', ['DELIVERED'], 'COMPLETED')).toBe('COMPLETED');
  });

  it('a takeaway profile still outranks everything, BILLING included', () => {
    expect(
      unifiedStatusForRestaurantOrder({
        orderStatus: 'SUBMITTED',
        roundStatuses: ['DELIVERED'],
        takeawayStatus: 'READY',
        sessionStatus: 'BILLING',
      }),
    ).toBe('READY');
  });
});
