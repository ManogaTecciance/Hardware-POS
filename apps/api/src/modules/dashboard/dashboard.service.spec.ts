import { dayInTimeZone } from '@hardware-pos/shared';

import { DashboardService } from './dashboard.service';

const COLOMBO = 'Asia/Colombo';

/**
 * The dashboard reckons in the SHOP's day. On a UTC host serving a Colombo shop,
 * cutting the window on the server's midnight would report 05:30-to-05:30 — these
 * specs pin the boundaries and the per-day slotting instead.
 */
function makeService(overrides: Record<string, unknown> = {}, tz = COLOMBO) {
  // First call only: `summary` calls rangeTotals twice — the current window and
  // the equal-length one before it — and the current window is what we assert on.
  const calls: Record<string, { from: Date; to: Date }> = {};
  const remember = (name: string, from: Date, to: Date) => {
    if (!calls[name]) calls[name] = { from, to };
  };
  const record = (name: string) => (_t: string, from: Date, to: Date) => {
    remember(name, from, to);
    return Promise.resolve({ netSales: 0, transactions: 0 });
  };
  const repo = {
    rangeTotals: jest.fn(record('rangeTotals')),
    rangeGrossProfit: jest.fn(() => Promise.resolve(0)),
    salesSeries: jest.fn((_t: string, from: Date, to: Date) => {
      remember('salesSeries', from, to);
      return Promise.resolve([]);
    }),
    paymentMethodTotals: jest.fn((_t: string, from: Date, to: Date) => {
      remember('paymentMethodTotals', from, to);
      return Promise.resolve([]);
    }),
    firstSaleAt: jest.fn(() => Promise.resolve(null)),
    refundsSince: jest.fn(() => Promise.resolve(0)),
    getStats: jest.fn(() => Promise.resolve({})),
    ...overrides,
  };
  const settings = { getSettings: () => ({ timezone: tz }) };
  return {
    service: new DashboardService(repo as never, settings as never),
    repo,
    calls,
  };
}

describe('dashboard windows are cut on the shop clock', () => {
  it('starts and ends the default window at Colombo midnight', async () => {
    const { service, calls } = makeService();
    await service.summary('t1');
    const { from, to } = calls.rangeTotals;
    // Colombo is +5:30, so its midnight is 18:30Z the previous day.
    expect(from.toISOString()).toMatch(/T18:30:00\.000Z$/);
    expect(to.toISOString()).toMatch(/T18:30:00\.000Z$/);
  });

  it('spans seven whole shop days', async () => {
    const { service, calls } = makeService();
    await service.summary('t1');
    const { from, to } = calls.rangeTotals;
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(7);
  });

  it('ends the window at the close of the shop’s today', async () => {
    const { service, calls } = makeService();
    await service.summary('t1');
    const lastCovered = new Date(calls.rangeTotals.to.getTime() - 1);
    expect(dayInTimeZone(lastCovered, COLOMBO)).toBe(dayInTimeZone(new Date(), COLOMBO));
  });

  it('follows a different shop zone', async () => {
    const { service, calls } = makeService({}, 'UTC');
    await service.summary('t1');
    expect(calls.rangeTotals.from.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it('honours an explicit range instead of the default', async () => {
    const { service, calls } = makeService();
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-08T00:00:00Z');
    await service.summary('t1', from, to);
    expect(calls.rangeTotals.from).toEqual(from);
    expect(calls.rangeTotals.to).toEqual(to);
  });

  it('gives the shift summary exactly one shop day', async () => {
    const { service, calls } = makeService();
    await service.shiftSummary('t1', 'u1');
    const { from, to } = calls.paymentMethodTotals;
    expect(to.getTime() - from.getTime()).toBe(86_400_000);
    expect(from.toISOString()).toMatch(/T18:30:00\.000Z$/);
  });

  it('passes the shop zone down to the series query', async () => {
    const { service, repo } = makeService();
    await service.summary('t1');
    expect(repo.salesSeries).toHaveBeenCalledWith(
      't1',
      expect.any(Date),
      expect.any(Date),
      'day',
      COLOMBO,
    );
  });
});

describe('series slotting follows shop days', () => {
  /** Buckets arrive as shop-midnight instants, one per day the SQL grouped. */
  function bucketsFor(days: string[], values: number[]) {
    return days.map((d, i) => ({
      // 18:30Z the previous day == midnight in Colombo.
      bucket: new Date(`${d}T00:00:00+05:30`),
      value: values[i],
    }));
  }

  it('zero-fills the days with no sales and keeps the rest in order', async () => {
    const today = dayInTimeZone(new Date(), COLOMBO);
    const { service } = makeService({
      salesSeries: jest.fn(() => Promise.resolve(bucketsFor([today], [500]))),
    });
    const summary = await service.summary('t1');
    expect(summary.netSales.series).toHaveLength(7);
    // Today is the last slot of a window that ends with today.
    expect(summary.netSales.series[6]).toBe(500);
    expect(summary.netSales.series.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('drops nothing when a sale lands in the small hours of a shop day', async () => {
    // 20:00Z is already 01:30 the NEXT day in Colombo; the SQL groups it under
    // that day, and the slot must line up with it.
    const today = dayInTimeZone(new Date(), COLOMBO);
    const { service } = makeService({
      salesSeries: jest.fn(() => Promise.resolve(bucketsFor([today], [42]))),
    });
    const summary = await service.summary('t1');
    expect(summary.netSales.series.reduce((a, b) => a + b, 0)).toBe(42);
  });
});
