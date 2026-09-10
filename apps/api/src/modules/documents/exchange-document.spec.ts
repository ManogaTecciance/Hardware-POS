/**
 * CHARACTERISATION — the Exchange A4 document renderer, as it behaves TODAY.
 *
 * Context: when this spec was written the repository contained an Exchange
 * *document renderer* but no Exchange *transaction* — no Prisma model,
 * migration, API module, route or permission key (decision D2).
 *
 * **That changed in Phase 7.** D128 built the transaction, and `7.3` connected
 * this renderer to it. Two things follow: the rendering output is no longer
 * merely "preserved" but load-bearing for a real document a customer is handed,
 * and the tax column now follows the tenant's setting rather than being forced
 * off — see the note on those tests below.
 *
 * D2's requirement that the existing output be preserved still holds for every
 * assertion NOT explicitly changed by `7.3`. `documents.preview.spec.ts` already covers the signature chain and
 * the invoice-note exclusion for the `'exchange'` preview type; it does NOT cover
 * `buildExchangeDocument` itself. This spec closes that gap so testcases.md rows
 * EXC-D-001…EXC-D-003 are honestly backed by automated coverage rather than
 * assumed.
 *
 * These are the Tile Shop regression for critical scenario #4 ("existing
 * exchanges still work"), scoped to what actually exists.
 */

import { DocumentsService, type ExchangeLine } from './documents.service';
import type { DocumentSettings } from '../settings/settings.interfaces';
import { SettingsService } from '../settings/settings.service';

/** Prisma stub — this path never touches the database. */
const prismaStub = {
  tenantSettings: { findMany: jest.fn(async () => []) },
} as any;
const pdfStub = { available: true, htmlToPdf: jest.fn(async () => null) } as any;
// D154 — only the PREVIEW path reads the profile; a real exchange document is
// built from the exchange itself, so this stub exists to satisfy the
// constructor and is deliberately never expected to be consulted here.
const profilesStub = {
  getEffectiveProfile: jest.fn(async () => ({ businessType: 'HARDWARE' })),
} as any;

function service(): DocumentsService {
  return new DocumentsService(prismaStub, new SettingsService(prismaStub), pdfStub, profilesStub);
}

/**
 * `7.3` — a service whose document settings can be driven.
 *
 * Needed because the tax column now FOLLOWS the tenant's setting, so proving
 * it takes both states. The plain `service()` above keeps code defaults.
 */
function serviceWithDocs(overrides: Partial<DocumentSettings>): DocumentsService {
  const base = new SettingsService(prismaStub).getSettings(TENANT);
  const settings = {
    getSettings: () => ({ ...base, documents: { ...base.documents, ...overrides } }),
  } as unknown as SettingsService;
  return new DocumentsService(prismaStub, settings, pdfStub, profilesStub);
}

/** Column LABELS. `doc.columns` holds objects, so comparing it to strings
 *  silently matches nothing — see the note on the tax-column tests below. */
const labels = (doc: { columns: { label: string }[] }): string[] =>
  doc.columns.map((c) => c.label);

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

  /**
   * CHANGED BY DECISION in `7.3`, and the old assertion was VACUOUS.
   *
   * It read `expect(doc.columns).not.toContain('Tax')`. `doc.columns` is an
   * array of `{ label, align }` OBJECTS, so it could never contain the string
   * `'Tax'` in either state — the assertion passed identically whether the
   * column was rendered or not. CLAUDE.md names this failure exactly: "a
   * regular expression fails to match either the valid or the invalid state".
   *
   * The behaviour also changed. The renderer forced `showTaxColumn: false`,
   * written before Phase 3 made tax per-line with snapshots, so an exchange
   * note showed no tax and did not tie to the money that moved. It now follows
   * the tenant's setting, exactly as the sale and return notes do.
   */
  it('shows the tax column when the tenant shows it, and hides it when not', () => {
    const shown = serviceWithDocs({ showTaxColumn: true }).buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000009',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1)],
    );
    const hidden = serviceWithDocs({ showTaxColumn: false }).buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000009',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1)],
    );

    // Both directions. One of these alone would pass for a renderer that
    // ignored the setting entirely.
    expect(labels(shown)).toContain('Tax');
    expect(labels(hidden)).not.toContain('Tax');
  });

  it('never shows a per-line discount column, whatever the tenant sets', () => {
    // Unchanged in `7.3`: an exchange line carries no discount of its own,
    // because the price it is valued at already has one applied. Asserted on
    // LABELS this time, so it is capable of failing.
    const doc = serviceWithDocs({ showDiscountColumn: true }).buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000009',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1)],
    );
    expect(labels(doc)).not.toContain('Discount');
    // Non-vacuous: the label list is populated, so 'not.toContain' is a real
    // claim about a real list rather than an assertion against nothing.
    expect(labels(doc)).toContain('Line total');
  });

  it('carries a real per-line tax figure on both sides, as a magnitude', () => {
    // `7.3` — hardcoded 0 for every line until Phase 7.
    const doc = serviceWithDocs({ showTaxColumn: true }).buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000011',
      [{ ...line('Returned A', 100, 1), taxAmount: 15 }],
      [{ ...line('New B', 200, 1), taxAmount: 30 }],
    );
    // A magnitude on both sides: the shared row builder renders a non-positive
    // tax as an em dash, so negating the returning side would erase it. These
    // fail against the old hardcoded 0, which rendered the same em dash.
    expect(doc.rows[0]!.cells.some((c) => c.includes('15'))).toBe(true);
    expect(doc.rows[1]!.cells.some((c) => c.includes('30'))).toBe(true);
  });

  it('prefers explicit totals over a sum of display lines', () => {
    // `7.3` — the note must tie to `Return.refundTotal` and `Sale.total`, the
    // money that actually moved, not to a reconstruction from the rows.
    const doc = service().buildExchangeDocument(
      TENANT,
      SELLER,
      'EXC-000012',
      [line('Returned A', 100, 1)],
      [line('New B', 200, 1)],
      { returnedTotal: 115, replacementTotal: 230 },
    );
    // 230 - 115 = 115, not the 100 the display lines would have given.
    const due = doc.summary.find((s) => s.label.includes('Balance due'));
    expect(due).toBeDefined();
    expect(due!.value).toContain('115');
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
