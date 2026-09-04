import { describe, expect, it } from 'vitest';

import { checkCredit, type FetchedCredit } from './credit-guard';

/**
 * These pin the till's live credit warning to the server's own rule. Every case
 * below is one the two could disagree on — and a disagreement is expensive in
 * both directions: block a sale the shop is entitled to make, or wave through
 * one the server will refuse after the customer has been told it went through.
 */
const CUST = 'cus_1';

function credit(over: Partial<FetchedCredit> = {}): FetchedCredit {
  return {
    customerId: CUST,
    creditAllowed: true,
    creditLimit: 50_000,
    outstanding: 10_000,
    available: 40_000,
    ...over,
  };
}

describe('live credit check on the till', () => {
  it('does not apply to a sale that is paid in full', () => {
    // A customer barred from credit may still buy anything they pay for; the
    // server never consults credit for a sale that leaves no balance.
    const c = checkCredit(0, CUST, credit({ creditAllowed: false, available: 0 }));
    expect(c.applies).toBe(false);
    expect(c.refused).toBe(false);
    expect(c.overLimit).toBe(false);
  });

  it('does not apply to a walk-in, whatever the balance', () => {
    expect(checkCredit(5_000, '', credit()).applies).toBe(false);
  });

  it('allows a credit sale inside the limit', () => {
    const c = checkCredit(5_000, CUST, credit());
    expect(c.overLimit).toBe(false);
    expect(c.available).toBe(40_000);
  });

  it('allows a sale that lands exactly on the limit', () => {
    // The server tests strictly greater-than, so exactly-on-the-limit completes.
    expect(checkCredit(40_000, CUST, credit()).overLimit).toBe(false);
  });

  it('refuses one cent past the limit', () => {
    expect(checkCredit(40_000.01, CUST, credit()).overLimit).toBe(true);
  });

  it('treats no limit as unlimited, not as zero', () => {
    // `available ?? 0` here would block every sale to an account deliberately
    // left unlimited.
    const c = checkCredit(999_999, CUST, credit({ creditLimit: null, available: null }));
    expect(c.overLimit).toBe(false);
    expect(c.applies).toBe(true);
  });

  it('treats a limit of zero as a real limit, not as unlimited', () => {
    // `!creditLimit` here would wave through a sale guaranteed to be refused.
    const c = checkCredit(1, CUST, credit({ creditLimit: 0, outstanding: 0, available: 0 }));
    expect(c.overLimit).toBe(true);
  });

  it('refuses a customer not approved for credit, before looking at any limit', () => {
    const c = checkCredit(1, CUST, credit({ creditAllowed: false }));
    expect(c.refused).toBe(true);
    expect(c.overLimit).toBe(false);
  });

  it('reports no headroom, rather than negative headroom, on an over-drawn account', () => {
    // Reachable: a limit lowered after the fact, or two tills completing at once.
    const c = checkCredit(1_000, CUST, credit({ outstanding: 62_000, available: -12_000 }));
    expect(c.available).toBe(0);
    expect(c.overLimit).toBe(true);
  });

  it('ignores a credit position fetched for a different customer', () => {
    // A slow response for the previously selected customer must not decide this sale.
    const c = checkCredit(5_000, 'cus_2', credit({ customerId: 'cus_1' }));
    expect(c.applies).toBe(true);
    expect(c.overLimit).toBe(false);
    expect(c.refused).toBe(false);
    expect(c.credit).toBeNull();
  });

  it('does not block when the credit position could not be read', () => {
    // Fail open: a transport problem must not stop the shop selling. The server
    // still enforces the limit on completion.
    const c = checkCredit(5_000, CUST, null);
    expect(c.applies).toBe(true);
    expect(c.overLimit).toBe(false);
    expect(c.refused).toBe(false);
  });

  it('adds the balance to what is already owed, not just to this sale', () => {
    // 45,000 owed + a 6,000 sale is over a 50,000 limit even though neither is.
    expect(checkCredit(6_000, CUST, credit({ outstanding: 45_000, available: 5_000 })).overLimit).toBe(
      true,
    );
  });

  it('rounds the projection to the cent, as the server does', () => {
    // 0.1 + 0.2 in binary floating point exceeds 0.3; the sale must not be
    // refused for an artefact of the arithmetic.
    const c = checkCredit(0.2, CUST, credit({ creditLimit: 0.3, outstanding: 0.1, available: 0.2 }));
    expect(c.overLimit).toBe(false);
  });
});
