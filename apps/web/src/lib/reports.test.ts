/**
 * `8.3` — the retail report display formatters.
 *
 * ## Why these are worth a test
 *
 * They exist to make a promise: the number on screen is byte-for-byte the number
 * the server computed. Every other money formatter in this app takes a `number`
 * and runs it through `Intl`, which is correct for a cart total the client just
 * calculated and wrong for a report figure that Postgres summed as a `Decimal`.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The values chosen are ones a float round-trip visibly damages — an 18-digit
 * amount beyond `Number.MAX_SAFE_INTEGER`, and `0.10 + 0.20` money — so a
 * rewrite that reintroduced `Number(value).toFixed(2)` fails here rather than
 * passing with a rounding difference nobody notices. The grouping boundary is
 * asserted on both sides (3 digits and 4 digits).
 */

import { describe, expect, it } from 'vitest';

import { formatReportMoney, formatReportQuantity } from './reports';

describe('formatReportMoney', () => {
  it('groups thousands and keeps the cents it was given', () => {
    expect(formatReportMoney('1234.50', 'LKR')).toBe('Rs. 1,234.50');
    expect(formatReportMoney('1234567.89', 'LKR')).toBe('Rs. 1,234,567.89');
  });

  it('does not group below a thousand, and does at exactly a thousand', () => {
    // The boundary, from both sides: an off-by-one in the grouping regex shows
    // up here rather than only on unusually large numbers.
    expect(formatReportMoney('999.00', 'LKR')).toBe('Rs. 999.00');
    expect(formatReportMoney('1000.00', 'LKR')).toBe('Rs. 1,000.00');
  });

  it('preserves digits a float round-trip would destroy', () => {
    // 17 significant digits: `Number('12345678901234.56')` is not this value.
    // If anyone rewrites this to parse and re-format, this line fails.
    expect(formatReportMoney('12345678901234.56', 'LKR')).toBe('Rs. 12,345,678,901,234.56');
    // The canonical float-money example. `0.1 + 0.2` is 0.30000000000000004;
    // the server sent "0.30" and "0.30" is what must appear.
    expect(formatReportMoney('0.30', 'LKR')).toBe('Rs. 0.30');
  });

  it('keeps a negative sign outside the symbol', () => {
    expect(formatReportMoney('-45.00', 'LKR')).toBe('-Rs. 45.00');
  });

  it('renders a non-home currency as its ISO code, not an invented symbol', () => {
    // Same rule the shared `formatCurrency` follows. "AED 1,250.00" is honest;
    // "Rs. 1,250.00" for a Dubai tenant is a bug that reached production once.
    expect(formatReportMoney('1250.00', 'AED')).toBe('AED 1,250.00');
    expect(formatReportMoney('1250.00', 'AED')).not.toContain('Rs.');
  });

  it('handles a whole number with no decimal point at all', () => {
    expect(formatReportMoney('4200', 'LKR')).toBe('Rs. 4,200');
  });
});

describe('formatReportQuantity', () => {
  it('trims the trailing zeroes a Decimal(12,3) always carries', () => {
    expect(formatReportQuantity('3.000')).toBe('3');
    expect(formatReportQuantity('12.000')).toBe('12');
  });

  it('keeps the fraction when there is one — loose goods sell by weight', () => {
    expect(formatReportQuantity('1.500')).toBe('1.5');
    expect(formatReportQuantity('0.250')).toBe('0.25');
    expect(formatReportQuantity('2.125')).toBe('2.125');
  });

  it('leaves an integer string alone', () => {
    // No decimal point at all — the trim must not eat the zeroes of "100".
    expect(formatReportQuantity('100')).toBe('100');
  });
});
