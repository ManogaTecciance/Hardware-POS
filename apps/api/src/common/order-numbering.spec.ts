import { orderCallCounterKey } from './document-sequence';
import { mintOrderNumbers } from './order-numbering';

/**
 * D197 — one minter, two counters, one business day.
 *
 * The raw-SQL upsert is exercised against a real database by the integration
 * suite (`restaurant-order-call-number.spec.ts`); here the client is a stub
 * that records which counter each reservation hit, so the spec can pin the
 * one thing a stub CAN prove: the call number is keyed by branch AND day in
 * the tenant's zone, and the order number is not.
 */
describe('mintOrderNumbers (D197)', () => {
  function client() {
    const hits: string[] = [];
    const values = new Map<string, number>();
    return {
      hits,
      $queryRaw: jest.fn(async (sql: { values: unknown[] }) => {
        // `Prisma.sql` tagged template: values are [tenantId, docType, 1].
        const key = String(sql.values[1]);
        hits.push(key);
        const next = (values.get(key) ?? 0) + 1;
        values.set(key, next);
        return [{ value: next }];
      }),
    };
  }

  const tenant = 'tnt_1';
  const branch = 'brn_1';
  // 2026-09-14 19:30 UTC is 01:00 on the 15th in Colombo.
  const lateEvening = new Date('2026-09-14T19:30:00Z');

  it('reserves the order number tenant-wide and the call number per branch per LOCAL day', async () => {
    const c = client();
    const minted = await mintOrderNumbers(c as never, tenant, branch, 'Asia/Colombo', lateEvening);
    expect(minted).toEqual({ orderNumber: 'RO-000001', callNumber: 1, callDay: '2026-09-15' });
    // POSITIVE — exactly these two counters, in this order.
    expect(c.hits).toEqual(['RESTAURANT_ORDER', orderCallCounterKey(branch, '2026-09-15')]);
  });

  it('the same instant is a different day in a different zone — the zone is the tenant\'s, not the server\'s', async () => {
    const c = client();
    const minted = await mintOrderNumbers(c as never, tenant, branch, 'UTC', lateEvening);
    expect(minted.callDay).toBe('2026-09-14');
    expect(c.hits[1]).toBe(orderCallCounterKey(branch, '2026-09-14'));
  });

  it('two branches on one day do not share a call number, and two days on one branch start over', async () => {
    const c = client();
    const a1 = await mintOrderNumbers(c as never, tenant, 'brn_a', 'UTC', new Date('2026-09-14T10:00:00Z'));
    const a2 = await mintOrderNumbers(c as never, tenant, 'brn_a', 'UTC', new Date('2026-09-14T11:00:00Z'));
    const b1 = await mintOrderNumbers(c as never, tenant, 'brn_b', 'UTC', new Date('2026-09-14T11:30:00Z'));
    const aNext = await mintOrderNumbers(c as never, tenant, 'brn_a', 'UTC', new Date('2026-09-15T09:00:00Z'));
    // POSITIVE — branch A counts 1, 2; branch B starts its own 1; A restarts tomorrow.
    expect([a1.callNumber, a2.callNumber, b1.callNumber, aNext.callNumber]).toEqual([1, 2, 1, 1]);
    // NEGATIVE — the permanent identifier never restarts: four orders, four numbers.
    expect([a1, a2, b1, aNext].map((m) => m.orderNumber)).toEqual([
      'RO-000001',
      'RO-000002',
      'RO-000003',
      'RO-000004',
    ]);
  });

  it('MUTATION — a key that dropped the day would let tomorrow continue today\'s count', () => {
    // The spec above only holds because the key carries the day. Pin the
    // key's shape so a "simplification" to `ORDER_CALL:<branch>` is caught
    // here rather than at the counter on day two.
    expect(orderCallCounterKey('brn_a', '2026-09-14')).toBe('ORDER_CALL:brn_a:2026-09-14');
    expect(orderCallCounterKey('brn_a', '2026-09-15')).not.toBe(orderCallCounterKey('brn_a', '2026-09-14'));
    expect(orderCallCounterKey('brn_a', '2026-09-14')).not.toBe(orderCallCounterKey('brn_b', '2026-09-14'));
  });
});
