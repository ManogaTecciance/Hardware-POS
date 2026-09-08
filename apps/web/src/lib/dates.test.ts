import { describe, expect, it } from 'vitest';

import { formatSaleStamp, isValidYmd, todayIso } from './dates';

describe('isValidYmd', () => {
  it('accepts a well-formed calendar day', () => {
    expect(isValidYmd('2026-08-01')).toBe(true);
  });

  it.each([undefined, '', '2026-8-1', '202600-08-01', '2026-08', 'not-a-date'])(
    'rejects %s',
    (value) => {
      expect(isValidYmd(value)).toBe(false);
    },
  );

  it('rejects the 6-digit years a date input emits mid-typing', () => {
    // The POS date picker sends these while the user is still typing the year;
    // treating one as a real date would fail the sale at payment time.
    expect(isValidYmd('020260-08-01')).toBe(false);
  });
});

describe('todayIso', () => {
  it('returns a well-formed calendar day', () => {
    expect(isValidYmd(todayIso())).toBe(true);
  });

  it('reports the local day, not the UTC one', () => {
    const now = new Date();
    const [y, m, d] = todayIso().split('-').map(Number);
    expect([y, m, d]).toEqual([now.getFullYear(), now.getMonth() + 1, now.getDate()]);
  });
});

describe('formatSaleStamp', () => {
  const now = new Date(2026, 7, 15, 14, 23);

  it('shows the time for a sale dated today', () => {
    const stamp = formatSaleStamp(new Date(2026, 7, 15, 9, 5).toISOString(), now);
    expect(stamp).toMatch(/\d{2}:\d{2}/);
  });

  it('shows the day for a backdated sale rather than a bare time', () => {
    const stamp = formatSaleStamp(new Date(2026, 6, 4, 9, 5).toISOString(), now);
    expect(stamp).not.toMatch(/^\d{2}:\d{2}$/);
    expect(stamp).toContain('04');
  });

  it('includes the year once the sale is not from this year', () => {
    const stamp = formatSaleStamp(new Date(2025, 6, 4, 9, 5).toISOString(), now);
    expect(stamp).toContain('2025');
  });

  it('omits the year for an earlier day in the same year', () => {
    const stamp = formatSaleStamp(new Date(2026, 6, 4, 9, 5).toISOString(), now);
    expect(stamp).not.toContain('2026');
  });

  it('falls back to a dash on an unparseable value', () => {
    expect(formatSaleStamp('nonsense', now)).toBe('—');
  });
});
