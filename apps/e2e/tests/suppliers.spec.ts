import { test, expect } from '../src/fixtures';
import { uniq } from '../src/api';
import { buildSheet, VENDOR_HEADERS } from '../src/xlsx';

test.describe('SUP — Suppliers (Vendors)', () => {
  test('SUP-001 create vendor with QB fields', async ({ ownerApi }) => {
    const s = await ownerApi.createSupplier({
      company: 'Lanka HW', email: 's@lanka.test', city: 'Colombo',
      province: 'Western', country: 'Sri Lanka', openingBalance: 250000, taxId: 'VAT-1',
    });
    expect(s.company).toBe('Lanka HW');
    expect(s.quickbooks.status).toBe('NOT_CONNECTED');
  });

  test('SUP-002 name is the only required field', async ({ ownerApi }) => {
    const s = await ownerApi.createSupplier();
    expect(s.id).toBeTruthy();
  });

  test('SUP-003 duplicate name rejected (case-insensitive)', async ({ ownerApi }) => {
    const name = uniq('DupVendor');
    await ownerApi.createSupplier({ name });
    const res = await ownerApi.postRaw('/suppliers', { name: name.toLowerCase() });
    expect(res.status()).toBe(409);
  });

  test('SUP-005 opening balance beyond 12,2 range survives', async ({ ownerApi }) => {
    const s = await ownerApi.createSupplier({ openingBalance: 19999999999 });
    expect(Number(s.openingBalance)).toBe(19999999999);
  });

  test('SUP-008 delete unmapped vendor', async ({ ownerApi }) => {
    const s = await ownerApi.createSupplier();
    const res = await ownerApi.deleteRaw(`/suppliers/${s.id}`);
    expect(res.status()).toBe(204);
  });

  test('SUP-011 vendor search empty & non-erroring when QB disconnected', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/quickbooks/vendors?search=');
    expect(res.ok()).toBeTruthy();
    expect(Array.isArray((await res.json()).data)).toBe(true);
  });

  test('SUP-015 nonexistent vendor id is 404', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/suppliers/does-not-exist');
    expect(res.status()).toBe(404);
  });
});

test.describe('SIMP — Vendor Bulk Import', () => {
  test('SIMP-001 template downloads', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/suppliers/import/template');
    expect(res.ok()).toBeTruthy();
  });

  test('SIMP-003 huge/negative balances import without overflow', async ({ ownerApi }) => {
    const name = uniq('BigBalVendor');
    const buf = await buildSheet(VENDOR_HEADERS, [
      [name, 'Co', '', '', '', '', '', '', '', '', '', '', -12345678901, '', ''],
    ]);
    const preview = (await (await ownerApi.uploadSheet('/suppliers/import/preview', buf)).json()).data;
    const summary = await ownerApi.post('/suppliers/import/commit', { rows: preview });
    expect(summary.failed).toBe(0);
    expect(summary.created).toBeGreaterThanOrEqual(1);
  });

  test('SIMP-006 re-import idempotent', async ({ ownerApi }) => {
    const name = uniq('IdemVendor');
    const buf = await buildSheet(VENDOR_HEADERS, [[name, 'Co', '', '', '', '', '', '', '', '', '', '', '', '', '']]);
    const p1 = (await (await ownerApi.uploadSheet('/suppliers/import/preview', buf)).json()).data;
    await ownerApi.post('/suppliers/import/commit', { rows: p1 });
    const p2 = (await (await ownerApi.uploadSheet('/suppliers/import/preview', buf)).json()).data;
    const s2 = await ownerApi.post('/suppliers/import/commit', { rows: p2 });
    expect(s2.created).toBe(0);
  });

  test('SIMP-008 wrong-header sheet rejected', async ({ ownerApi }) => {
    const buf = await buildSheet(['Wrong', 'Headers'], [['a', 'b']]);
    const res = await ownerApi.uploadSheet('/suppliers/import/preview', buf);
    expect(res.status()).toBe(400);
  });
});
