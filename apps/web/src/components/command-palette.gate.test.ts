import { describe, expect, it } from 'vitest';

import { RESTAURANT_ROLE_TEMPLATES } from '@hardware-pos/shared';

import { ALL_NAV_ITEMS, holdsAnyOf } from '@/lib/nav';
import { Permission, ROLE_PERMISSIONS } from '@/lib/permissions';

import { POS_COMMAND_GATE, availableCommands } from './command-palette';

/**
 * D93 — the Ctrl+K POS command is gated like the POS rail entry.
 *
 * Why this file exists: the palette hand-copies every destination from the nav
 * lists, so it had a SECOND permission gate with no test behind it at all — the
 * whole web suite stayed green with that gate fully fail-open. A review caught
 * it. The gate is now derived from the nav specs rather than retyped, and this
 * pins the derivation.
 *
 * The palette itself is not rendered here: it needs a router, an auth context
 * and a keyboard. The thing worth testing is the GATE, which is data.
 */

/*
 * THE SHIPPED value, imported — not a local re-derivation. The first draft of
 * this file copied the derivation out of the component, and mutating the
 * component's own copy left every test here green: a mirror asserts about
 * itself. That is the vacuity D30 is written against, and it was caught by
 * running the mutation rather than by reading the test.
 */
const posGate = POS_COMMAND_GATE;

function templateHolder(key: string) {
  const template = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === key);
  if (!template) throw new Error(`No template '${key}' — renamed or removed; this test asserts nothing.`);
  const granted = new Set<string>(template.permissions);
  return (permission: Permission) => granted.has(permission);
}

describe('D93 — the POS command gate', () => {
  it('is derived from the real nav specs and is not empty', () => {
    /*
     * The load-bearing check. The derivation reads module-level exports, and an
     * import-order accident yielding `[]` would make the command vanish for
     * everyone — fail-closed, so nothing breaks loudly, and nobody notices.
     */
    expect(posGate.length).toBeGreaterThan(0);
    expect(ALL_NAV_ITEMS.filter((i) => i.href === '/pos').length).toBeGreaterThanOrEqual(2);
  });

  it('is the union of both domains — retail POS and food-service POS', () => {
    // EXACT set: a permission quietly added to either /pos entry widens who is
    // offered the command, and a count would not notice a swap.
    expect([...posGate].sort()).toEqual(
      [
        Permission.SALE_CREATE,
        Permission.ORDER_SEND_TO_KITCHEN,
        Permission.TAKEAWAY_CREATE,
      ].sort(),
    );
  });

  it('offers the command to the restaurant till — the D93 complaint', () => {
    const till = templateHolder('RESTAURANT_CASHIER');

    expect(holdsAnyOf(posGate, { hasPermission: till })).toBe(true);
    // …without the retail permission it used to hang on.
    expect(till(Permission.SALE_CREATE)).toBe(false);
  });

  it('and to the waiter and the retail cashier, who both had it before', () => {
    expect(holdsAnyOf(posGate, { hasPermission: templateHolder('WAITER') })).toBe(true);

    const retailCashier = new Set<string>(ROLE_PERMISSIONS.CASHIER);
    expect(retailCashier.has(Permission.SALE_CREATE)).toBe(true);
    expect(holdsAnyOf(posGate, { hasPermission: (p) => retailCashier.has(p) })).toBe(true);
  });

  it('withholds it from kitchen staff, who can do none of it', () => {
    const kitchen = templateHolder('KITCHEN_STAFF');

    // NEGATIVE…
    expect(holdsAnyOf(posGate, { hasPermission: kitchen })).toBe(false);
    // …paired, so it cannot be passing on a gate that refuses everyone.
    expect(holdsAnyOf(posGate, { hasPermission: () => true })).toBe(true);
    // …nor on a role that holds nothing at all.
    expect(templateHolder('KITCHEN_STAFF')(Permission.KOT_VIEW)).toBe(true);
  });

  it('a user holding nothing is offered nothing gated', () => {
    expect(holdsAnyOf(posGate, { hasPermission: () => false })).toBe(false);
  });

  it('the POS command actually USES that gate — the wiring, not just the value', () => {
    /*
     * Asserting the constant alone left a real mutation undetected: putting
     * `permission: Permission.SALE_CREATE` back on the entry passed every test
     * in this file, because none of them asked what the COMMAND carries. The
     * unit worth testing is command-plus-gate.
     */
    const till = templateHolder('RESTAURANT_CASHIER');
    const ids = availableCommands(till).map((c) => c.id);

    expect(ids).toContain('new-sale');
    // NEGATIVE, same call: the till is not simply being handed everything.
    expect(ids).not.toContain('quickbooks');
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('new-quote');

    // …and kitchen staff, who can work none of the POS modes, do not get it.
    expect(availableCommands(templateHolder('KITCHEN_STAFF')).map((c) => c.id)).not.toContain(
      'new-sale',
    );
    // Positive control for that negative: they DO get the ungated commands, so
    // the absence above is about the gate rather than an empty list.
    expect(availableCommands(templateHolder('KITCHEN_STAFF')).map((c) => c.id)).toContain(
      'dashboard',
    );
  });

  /*
   * MUTATION PROOF (D30). The palette used to carry its own hand-typed copy of
   * this list; the risk that replaced was drift. Show that a drifted copy gives
   * a different answer for the role the whole change was about.
   */
  it('a hand-typed gate that drifts from the spec would be detected', () => {
    const drifted = [Permission.SALE_CREATE] as const; // the pre-D93 palette
    const till = templateHolder('RESTAURANT_CASHIER');

    expect(holdsAnyOf(drifted, { hasPermission: till })).toBe(false);
    expect(holdsAnyOf(posGate, { hasPermission: till })).toBe(true);
    expect(() => expect(holdsAnyOf(drifted, { hasPermission: till })).toBe(true)).toThrow();
  });
});
