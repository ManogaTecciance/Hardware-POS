import { test, expect } from '../src/fixtures';
import { uniq } from '../src/api';
import { buildSheet, CUSTOMER_HEADERS } from '../src/xlsx';

test.describe('CUST — Customers', () => {
  test('CUST-001 create customer with QB + credit fields', async ({ ownerApi }) => {
    const c = await ownerApi.createCustomer({
      company: 'Acme', qbCustomerType: 'Wholesale Trade', email: 'a@b.test',
      city: 'Colombo', state: 'Western', country: 'Sri Lanka',
      openingBalance: 12345, resaleNumber: 'RS-1', customerType: 'CREDIT',
      creditAllowed: true, creditLimit: 100000,
    });
    expect(c.qbCustomerType).toBe('Wholesale Trade');
    expect(c.customerType).toBe('CREDIT');
    expect(Number(c.creditLimit)).toBe(100000);
  });

  test('CUST-002 name required (400)', async ({ ownerApi }) => {
    const res = await ownerApi.postRaw('/customers', { company: 'NoName' });
    expect(res.status()).toBe(400);
  });

  test('CUST-003 invalid email rejected', async ({ ownerApi }) => {
    const res = await ownerApi.postRaw('/customers', { name: uniq('BadEmail'), email: 'notanemail' });
    expect(res.status()).toBe(400);
  });

  test('CUST-005 POS type and QB type independent', async ({ ownerApi }) => {
    const c = await ownerApi.createCustomer({ customerType: 'CREDIT', qbCustomerType: 'Retail Trade' });
    expect(c.customerType).toBe('CREDIT');
    expect(c.qbCustomerType).toBe('Retail Trade');
  });

  test('CUST-008 edit preserves unrelated fields', async ({ ownerApi }) => {
    const c = await ownerApi.createCustomer({ creditAllowed: true, creditLimit: 5000, phone: '111' });
    const updated = await ownerApi.patch(`/customers/${c.id}`, { phone: '222' });
    expect(updated.phone).toBe('222');
    expect(updated.creditAllowed).toBe(true);
    expect(Number(updated.creditLimit)).toBe(5000);
  });

  test('CUST-010 search across fields', async ({ ownerApi }) => {
    const tag = uniq('Findable');
    const c = await ownerApi.createCustomer({ name: tag, phone: '0771234567' });
    const res = await ownerApi.get(`/customers?page=1&pageSize=20&search=${encodeURIComponent('0771234567')}`);
    expect(res.items.map((x: any) => x.id)).toContain(c.id);
  });
});

test.describe('CIMP — Customer Bulk Import', () => {
  test('CIMP-001 template downloads as xlsx', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/customers/import/template');
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('spreadsheet');
  });

  test('CIMP-003 "State" trailing-space header parses; preview works', async ({ ownerApi }) => {
    const name = uniq('ImpCust');
    const headers = [...CUSTOMER_HEADERS];
    headers[10] = 'State '; // trailing space, as in QB's own file
    const buf = await buildSheet(headers, [[name, 'Co', 'Retail Trade', '', '', '', '', '', '12 St', 'Kandy', 'Central', '20000', 'Sri Lanka', 1000, '2026-01-01', '']]);
    const res = await ownerApi.uploadSheet('/customers/import/preview', buf, 'cust.xlsx');
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()).data;
    const row = rows.find((r: any) => r.name === name);
    expect(row).toBeTruthy();
    expect(row.state).toBe('Central');
    expect(row.errors.length).toBe(0);
  });

  test('CIMP-005 duplicate names in sheet flagged', async ({ ownerApi }) => {
    const dup = uniq('DupCust');
    const buf = await buildSheet(CUSTOMER_HEADERS, [
      [dup, '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      [dup, '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const res = await ownerApi.uploadSheet('/customers/import/preview', buf, 'dup.xlsx');
    const rows = (await res.json()).data;
    const flagged = rows.filter((r: any) => r.name === dup && r.errors.length > 0);
    expect(flagged.length).toBeGreaterThan(0);
  });

  test('CIMP-007 import is idempotent', async ({ ownerApi }) => {
    const name = uniq('IdemCust');
    const rows = [[name, 'Co', 'Retail Trade', '', '', '', '', '', '', '', '', '', '', '', '', '']];
    const buf = await buildSheet(CUSTOMER_HEADERS, rows);
    const preview1 = (await (await ownerApi.uploadSheet('/customers/import/preview', buf, 'i.xlsx')).json()).data;
    const c1 = await ownerApi.post('/customers/import/commit', { rows: preview1 });
    expect(c1.created).toBeGreaterThanOrEqual(1);
    const preview2 = (await (await ownerApi.uploadSheet('/customers/import/preview', buf, 'i.xlsx')).json()).data;
    const c2 = await ownerApi.post('/customers/import/commit', { rows: preview2 });
    expect(c2.created).toBe(0);
    expect(c2.updated).toBeGreaterThanOrEqual(1);
  });
});
