import { describe, expect, it } from 'vitest';

import { RESTAURANT_ROLE_TEMPLATES } from '@hardware-pos/shared';

import { Permission } from '@/lib/permissions';

import { availablePosModes, resolveInitialPosMode, solePosMode } from './pos-modes';

/**
 * D93 — what the POS offers, and what a link may open.
 *
 * The roles are read from the real templates rather than hand-listed: this
 * resolver's job is to answer for the roles that actually exist, and a
 * hand-copied permission list drifts from the template silently — which is the
 * failure this repo has already had twice (D88, and the rail defect D93 fixes).
 */

function holder(key: string) {
  const template = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === key);
  if (!template) throw new Error(`No template '${key}' — renamed or removed; this test asserts nothing.`);
  if (template.permissions.length === 0) throw new Error(`Template '${key}' grants nothing.`);
  const granted = new Set<string>(template.permissions);
  return (permission: Permission) => granted.has(permission);
}

const NOBODY = () => false;
const EVERYBODY = () => true;

describe('availablePosModes', () => {
  it('the till gets takeaway and delivery — the complaint that started D93', () => {
    const modes = availablePosModes(holder('RESTAURANT_CASHIER'));

    expect(modes).toEqual(['TAKEAWAY', 'THIRD_PARTY']);
    // NEGATIVE, named: the till cannot send a round to the kitchen, so dine-in
    // is not theirs — and the exact-array assertion above would not say which.
    expect(modes).not.toContain('DINE_IN');
  });

  it('the waiter gets dine-in and takeaway, but not delivery', () => {
    const modes = availablePosModes(holder('WAITER'));

    expect(modes).toEqual(['DINE_IN', 'TAKEAWAY']);
    // D87 — a waiter does not settle, so they do not take an order they will
    // not be there to settle. PAYMENT_COLLECT is the honest proxy.
    expect(holder('WAITER')(Permission.PAYMENT_COLLECT)).toBe(false);
  });

  it('kitchen staff get nothing at all', () => {
    expect(availablePosModes(holder('KITCHEN_STAFF'))).toEqual([]);
  });

  it('delivery requires BOTH takeaway and payment, and takeaway alone is not enough', () => {
    const onlyTakeaway = (p: Permission) => p === Permission.TAKEAWAY_CREATE;
    const onlyPayment = (p: Permission) => p === Permission.PAYMENT_COLLECT;
    const both = (p: Permission) =>
      p === Permission.TAKEAWAY_CREATE || p === Permission.PAYMENT_COLLECT;

    expect(availablePosModes(onlyTakeaway)).toEqual(['TAKEAWAY']);
    // NEGATIVE: payment on its own opens nothing — delivery is not a payment
    // capability wearing a hat.
    expect(availablePosModes(onlyPayment)).toEqual([]);
    expect(availablePosModes(both)).toEqual(['TAKEAWAY', 'THIRD_PARTY']);
  });

  it('the extremes behave', () => {
    expect(availablePosModes(NOBODY)).toEqual([]);
    expect(availablePosModes(EVERYBODY)).toEqual(['DINE_IN', 'TAKEAWAY', 'THIRD_PARTY']);
  });
});

describe('resolveInitialPosMode', () => {
  const till = availablePosModes(holder('RESTAURANT_CASHIER'));

  it('opens a mode the operator can work', () => {
    expect(resolveInitialPosMode('TAKEAWAY', till)).toBe('TAKEAWAY');
    expect(resolveInitialPosMode('THIRD_PARTY', till)).toBe('THIRD_PARTY');
  });

  it('refuses one they cannot, so the chooser asks instead of the kitchen refusing', () => {
    // The case D93 created: POS is now a visible destination for the till, so
    // /pos?mode=dine-in is an ordinary link to receive from a colleague.
    expect(resolveInitialPosMode('DINE_IN', till)).toBeNull();
    // …and it is not merely refusing everything.
    expect(resolveInitialPosMode('DINE_IN', availablePosModes(holder('WAITER')))).toBe('DINE_IN');
  });

  it('no requested mode means ask, and an empty capability set means ask', () => {
    expect(resolveInitialPosMode(null, till)).toBeNull();
    expect(resolveInitialPosMode('TAKEAWAY', [])).toBeNull();
  });

  it('the dashboard tile hop still lands where it always did', () => {
    // /takeaway 307s to /pos?mode=takeaway, and that is a cashier's own mode.
    expect(resolveInitialPosMode('TAKEAWAY', till)).toBe('TAKEAWAY');
  });
});

describe('solePosMode', () => {
  it('one mode skips the question; two or none do not', () => {
    expect(solePosMode(['TAKEAWAY'])).toBe('TAKEAWAY');
    expect(solePosMode(['TAKEAWAY', 'THIRD_PARTY'])).toBeNull();
    expect(solePosMode([])).toBeNull();
  });
});

/*
 * MUTATION PROOFS (D30) — each is the implementation somebody would plausibly
 * write instead, shown to give a different answer to an assertion above.
 */
describe('the mode resolver can actually fail', () => {
  const till = holder('RESTAURANT_CASHIER');
  const tillModes = availablePosModes(till);

  it('M1: an unclamped deep link opens a mode the server will refuse', () => {
    const unclamped = (requested: string | null) => requested; // the pre-D93 line
    expect(unclamped('DINE_IN')).toBe('DINE_IN');
    expect(resolveInitialPosMode('DINE_IN', tillModes)).toBeNull();
    expect(() => expect(unclamped('DINE_IN')).toBeNull()).toThrow();
  });

  it('M2: gating delivery on takeaway alone hands it to the waiter', () => {
    const waiter = holder('WAITER');
    const looseDelivery = waiter(Permission.TAKEAWAY_CREATE); // no PAYMENT_COLLECT check
    expect(looseDelivery).toBe(true);
    expect(availablePosModes(waiter)).not.toContain('THIRD_PARTY');
    expect(() => expect(looseDelivery).toBe(false)).toThrow();
  });

  it('M3: gating dine-in on TAKEAWAY_CREATE would hand the till a kitchen it cannot reach', () => {
    const wrongGate = till(Permission.TAKEAWAY_CREATE);
    expect(wrongGate).toBe(true);
    expect(till(Permission.ORDER_SEND_TO_KITCHEN)).toBe(false);
    expect(availablePosModes(till)).not.toContain('DINE_IN');
  });
});
