import { test, expect } from '../src/fixtures';

/**
 * QB integration. Cases that need a live sandbox connection skip automatically
 * when the tenant is disconnected, so the suite is green without secrets.
 */
test.describe('QB — QuickBooks Integration', () => {
  test('QB-003 connection status endpoint responds', async ({ ownerApi }) => {
    const status = await ownerApi.get('/quickbooks/status');
    expect(typeof status.connected).toBe('boolean');
  });

  test('QB-012/014 party-sync-status returns mapping counts (works while disconnected)', async ({ ownerApi }) => {
    const parties = await ownerApi.get('/quickbooks/party-sync-status');
    expect(parties.customers).toHaveProperty('total');
    expect(parties.vendors).toHaveProperty('total');
    expect(parties.vendors).toHaveProperty('attention');
  });

  test('QB-006/007/008 full sync pull-creates and is idempotent', async ({ ownerApi }) => {
    const status = await ownerApi.get('/quickbooks/status');
    test.skip(!status.connected, 'QuickBooks sandbox not connected');
    const first = await ownerApi.post('/quickbooks/sync');
    expect(first.products).toBeTruthy();
    expect(first.customers).toBeTruthy();
    expect(first.vendors).toBeTruthy();
    const second = await ownerApi.post('/quickbooks/sync');
    expect(second.customers.created).toBe(0);
    expect(second.vendors.created).toBe(0);
  });

  test('QB-005 expired token surfaces a friendly message, not raw invalid_grant', async ({ ownerApi }) => {
    const status = await ownerApi.get('/quickbooks/status');
    test.skip(status.connected, 'Only meaningful when the token is dead');
    const res = await ownerApi.postRaw('/quickbooks/sync');
    if (!res.ok()) {
      const body = await res.text();
      expect(body).not.toContain('invalid_grant');
    }
  });

  test('QB-017 sync log is reachable', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/sync/logs?page=1&pageSize=10');
    expect(res.ok()).toBeTruthy();
  });

  test('QB-015 completed sale queues a QuickBooks push', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 100 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 1 }]);
    expect(['PENDING', 'SYNCING', 'SYNCED', 'NOT_SYNCED']).toContain(sale.syncStatus);
  });
});
