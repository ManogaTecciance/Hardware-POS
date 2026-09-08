/**
 * CHARACTERISATION — the Exchange A4 document renderer, as it behaves TODAY.
 *
 * Context (see docs/restaurant-pos/00-decisions.md, decision D2): the repository
 * contains an Exchange *document renderer* but no Exchange *transaction* — no
 * Prisma model, migration, API module, route, or permission key. The renderer's
 * own comment says as much.
 *
 * Decision D2 requires that this renderer, and its current rendering output, be
 * preserved. `documents.preview.spec.ts` already covers the signature chain and
 * the invoice-note exclusion for the `'exchange'` preview type; it does NOT cover
 * `buildExchangeDocument` itself. This spec closes that gap so testcases.md rows
 * EXC-D-001…EXC-D-003 are honestly backed by automated coverage rather than
 * assumed.
 *
 * These are the Tile Shop regression for critical scenario #4 ("existing
 * exchanges still work"), scoped to what actually exists.
 */

import { DocumentsService, type ExchangeLine } from './documents.service';
import { SettingsService } from '../settings/settings.service';

/** Prisma stub — this path never touches the database. */
const prismaStub = {
  tenantSettings: { findMany: jest.fn(async () => []) },
} as any;
const pdfStub = { available: true, htmlToPdf: jest.fn(async () => null) } as any;

function service(): DocumentsService {
  return new DocumentsService(prismaStub, new SettingsService(prismaStub), pdfStub);
}

const TENANT = 'tnt_1';
const SELLER = 'Fixture Hardware (Pvt) Ltd';

function line(name: string, unitPrice: number, quantity: number, sku?: string): ExchangeLine {
  return { name, sku: sku ?? null, quantity, unitPrice, lineTotal: unitPrice * quantity };
}

describe('DocumentsService.buildExchangeDocument', () => {
  it('titles and numbers the document', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000001',
      [line('Wall Tile 30x60', 1200, 2)],
      [line('Wall Tile 60x60', 1800, 2)],
    );

    expect(doc.title).toBe('Exchange');
    expect(doc.number).toBe('EXC-000001');
    expect(doc.seller.name).toBe(SELLER);
  });

  it('emits one row per returned and replacement line, returned first', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000002',
      [line('Returned A', 100, 1), line('Returned B', 200, 1)],
      [line('New C', 500, 1)],
    );

    expect(doc.rows).toHaveLength(3);
    // Returned lines are prefixed "Return: ", replacements "New: ".
    expect(doc.rows[0].cells.some((c) => c.includes('Return: Returned A'))).toBe(true);
    expect(doc.rows[1].cells.some((c) => c.includes('Return: Returned B'))).toBe(true);
    expect(doc.rows[2].cells.some((c) => c.includes('New: New C'))).toBe(true);
  });

  it('numbers the rows continuously across both groups', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000003',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1), line('New C', 300, 1)],
    );

    // Index is the first cell; replacements continue from the returned count.
    expect(doc.rows.map((r) => r.cells[0])).toEqual(['1', '2', '3']);
  });

  it('negates returned line totals and keeps replacements positive', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000004',
      [line('Returned A', 1000, 1)],
      [line('New B', 1500, 1)],
    );

    const flat = doc.rows.map((r) => r.cells.join(' | '));
    // The line total carries the sign; the currency symbol follows it: "-Rs. 1,000.00".
    expect(flat[0]).toContain('-Rs. 1,000.00');
    expect(flat[1]).toContain('Rs. 1,500.00');
    expect(flat[1]).not.toContain('-Rs. 1,500.00');
  });

  it('summarises a net BALANCE DUE when replacements cost more', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000005',
      [line('Returned A', 1200, 2)], // 2400 back
      [line('New B', 1800, 2)], // 3600 out
    );

    const labels = doc.summary.map((s) => s.label);
    expect(labels).toEqual(['Returned value', 'Replacement value', 'Balance due from customer']);

    const [returned, replacement, net] = doc.summary;
    expect(returned.value).toContain('2,400.00');
    expect(returned.value.startsWith('-')).toBe(true);
    expect(replacement.value).toContain('3,600.00');
    expect(net.value).toContain('1,200.00');
    expect(net.strong).toBe(true);
  });

  it('summarises a REFUND when the returned value is higher', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000006',
      [line('Returned A', 5000, 1)],
      [line('New B', 1500, 1)],
    );

    expect(doc.summary.map((s) => s.label)).toContain('Refund to customer');
    // The net is shown as an absolute value, never as a negative.
    const net = doc.summary[doc.summary.length - 1];
    expect(net.value).toContain('3,500.00');
    expect(net.value).not.toContain('-');
  });

  it('treats an exactly-even exchange as a zero balance due', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000007',
      [line('Returned A', 1000, 2)],
      [line('New B', 2000, 1)],
    );

    const net = doc.summary[doc.summary.length - 1];
    // net === 0 takes the `>= 0` branch.
    expect(net.label).toBe('Balance due from customer');
    expect(net.value).toContain('0.00');
  });

  it('rounds the net to two decimals rather than leaking float error', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000008',
      [line('Returned A', 0.1, 3)], // 0.30000000000000004 in float
      [line('New B', 0.2, 1)],
    );

    const net = doc.summary[doc.summary.length - 1];
    expect(net.value).toContain('0.10');
  });

  it('hides the tax and discount columns regardless of tenant settings', () => {
    // The renderer forces both off — an exchange note has no tax/discount columns.
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000009',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1)],
    );

    expect(doc.columns).not.toContain('Tax');
    expect(doc.columns).not.toContain('Discount');
  });

  it('renders with no returned lines (a pure add-on)', () => {
    const doc = service().buildExchangeDocument(TENANT, SELLER, 'EXC-000010', [], [
      line('New B', 750, 2),
    ]);

    expect(doc.rows).toHaveLength(1);
    expect(doc.summary[0].value).toContain('0.00');
    expect(doc.summary[doc.summary.length - 1].value).toContain('1,500.00');
  });

  it('carries the tenant letterhead settings through to the document', () => {
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000011',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1)],
    );

    // Same letterhead/layout plumbing as every other A4 document type.
    expect(doc.footerText).toBe(
      service().buildExchangeDocument(TENANT, SELLER, 'X', [], []).footerText,
    );
    expect(doc.signatures).toBe(true);
    expect(doc.meta[0].label).toBe('Date');
  });
});
