import { Prisma } from '@hardware-pos/database';

import { computeRestaurantTotals, type RestaurantChargeConfig } from './restaurant-totals';

const d = (v: string | number) => new Prisma.Decimal(v);

function config(over: Partial<RestaurantChargeConfig> = {}): RestaurantChargeConfig {
  return {
    serviceChargePercent: d(0),
    serviceChargeChannels: ['DINE_IN'],
    serviceChargeTaxable: true,
    packagingChargeAmount: d(0),
    taxRatePercent: 0,
    ...over,
  };
}

describe('D52 — restaurant bill totals', () => {
  it('an unconfigured branch bills exactly the items (today’s behaviour preserved)', () => {
    const t = computeRestaurantTotals(d('1000.00'), 'DINE_IN', config());
    expect(t.serviceChargeAmount.toFixed(2)).toBe('0.00');
    expect(t.packagingCharge.toFixed(2)).toBe('0.00');
    expect(t.taxAmount.toFixed(2)).toBe('0.00');
    expect(t.total.toFixed(2)).toBe('1000.00');
  });

  it('applies the tenant tax rate that the old code hardcoded to zero', () => {
    const t = computeRestaurantTotals(d('1000.00'), 'DINE_IN', config({ taxRatePercent: 18 }));
    expect(t.taxAmount.toFixed(2)).toBe('180.00');
    expect(t.total.toFixed(2)).toBe('1180.00');
  });

  it('levies service charge only on configured channels', () => {
    const c = config({ serviceChargePercent: d(10), serviceChargeChannels: ['DINE_IN'] });
    expect(computeRestaurantTotals(d('1000.00'), 'DINE_IN', c).serviceChargeAmount.toFixed(2)).toBe('100.00');
    // NEGATIVE: the same branch must not charge service on takeaway…
    expect(computeRestaurantTotals(d('1000.00'), 'TAKEAWAY', c).serviceChargeAmount.toFixed(2)).toBe('0.00');
    // …unless it says so.
    const both = config({ serviceChargePercent: d(10), serviceChargeChannels: ['DINE_IN', 'TAKEAWAY'] });
    expect(computeRestaurantTotals(d('1000.00'), 'TAKEAWAY', both).serviceChargeAmount.toFixed(2)).toBe('100.00');
  });

  it('charges packaging only where the food leaves the building', () => {
    const c = config({ packagingChargeAmount: d('50.00') });
    expect(computeRestaurantTotals(d('1000.00'), 'DINE_IN', c).packagingCharge.toFixed(2)).toBe('0.00');
    expect(computeRestaurantTotals(d('1000.00'), 'TAKEAWAY', c).packagingCharge.toFixed(2)).toBe('50.00');
    expect(computeRestaurantTotals(d('1000.00'), 'ONLINE', c).packagingCharge.toFixed(2)).toBe('50.00');
  });

  it('honours serviceChargeTaxable in both directions', () => {
    const base = { serviceChargePercent: d(10), serviceChargeChannels: ['DINE_IN'], taxRatePercent: 10 } satisfies Partial<RestaurantChargeConfig>;
    const taxed = computeRestaurantTotals(d('1000.00'), 'DINE_IN', config({ ...base, serviceChargeTaxable: true }));
    // tax on 1000 + 100 service
    expect(taxed.taxAmount.toFixed(2)).toBe('110.00');
    expect(taxed.total.toFixed(2)).toBe('1210.00');

    const untaxed = computeRestaurantTotals(d('1000.00'), 'DINE_IN', config({ ...base, serviceChargeTaxable: false }));
    // tax on 1000 only
    expect(untaxed.taxAmount.toFixed(2)).toBe('100.00');
    expect(untaxed.total.toFixed(2)).toBe('1200.00');
  });

  it('taxes packaging as part of the base', () => {
    const t = computeRestaurantTotals(
      d('1000.00'),
      'TAKEAWAY',
      config({ packagingChargeAmount: d('100.00'), taxRatePercent: 10 }),
    );
    expect(t.taxAmount.toFixed(2)).toBe('110.00');
    expect(t.total.toFixed(2)).toBe('1210.00');
  });

  it.each([
    ['999.99', 10, 18],
    ['0.01', 10, 18],
    ['12345.67', 7.5, 15],
    ['33.33', 12.5, 8],
  ])('the stored parts always sum to the stored total (subtotal %s)', (sub, svc, tax) => {
    const t = computeRestaurantTotals(
      d(sub),
      'TAKEAWAY',
      config({
        serviceChargePercent: d(svc),
        serviceChargeChannels: ['DINE_IN', 'TAKEAWAY'],
        packagingChargeAmount: d('75.50'),
        taxRatePercent: tax,
      }),
    );
    const parts = t.subtotal.plus(t.serviceChargeAmount).plus(t.packagingCharge).plus(t.taxAmount);
    expect(parts.equals(t.total)).toBe(true);
    // Every stored money column is 2dp — a third decimal cannot reach the DB.
    for (const v of [t.serviceChargeAmount, t.packagingCharge, t.taxAmount]) {
      expect(v.decimalPlaces()).toBeLessThanOrEqual(2);
    }
  });

  it('a zero-value tab stays zero throughout', () => {
    const t = computeRestaurantTotals(
      d(0),
      'TAKEAWAY',
      config({ serviceChargePercent: d(10), packagingChargeAmount: d(0), taxRatePercent: 18 }),
    );
    expect(t.total.toFixed(2)).toBe('0.00');
  });
});
