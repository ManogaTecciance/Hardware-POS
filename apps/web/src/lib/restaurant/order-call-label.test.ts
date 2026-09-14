import { orderCallTag, orderFullRef } from '@hardware-pos/shared';
import { describe, expect, it } from 'vitest';

/**
 * D197 — the one spelling of an order's name. Lives in `shared` (both apps
 * render it) and is exercised here because `shared` carries no test runner.
 */
describe('orderCallTag / orderFullRef (D197)', () => {
  it('"#47" when the order has a call number; "#RO-…" before D197; null with neither', () => {
    expect(orderCallTag({ callNumber: 47, orderNumber: 'RO-000120' })).toBe('#47');
    expect(orderCallTag({ callNumber: null, orderNumber: 'RO-000120' })).toBe('#RO-000120');
    expect(orderCallTag({ callNumber: undefined, orderNumber: 'RO-000120' })).toBe('#RO-000120');
    expect(orderCallTag({ callNumber: null, orderNumber: null })).toBeNull();
  });

  it('call number 0 is a number, not "missing"', () => {
    // Never minted today (counters start at 1), but a falsy check would
    // silently turn it into the RO- fallback.
    expect(orderCallTag({ callNumber: 0, orderNumber: 'RO-000120' })).toBe('#0');
  });

  it('the full reference adds the permanent identifier, and never repeats it', () => {
    expect(orderFullRef({ callNumber: 47, orderNumber: 'RO-000120' })).toBe('#47 · RO-000120');
    expect(orderFullRef({ callNumber: null, orderNumber: 'RO-000120' })).toBe('#RO-000120');
    expect(orderFullRef({ callNumber: 47, orderNumber: null })).toBe('#47');
    expect(orderFullRef({ callNumber: null, orderNumber: null })).toBeNull();
  });
});
