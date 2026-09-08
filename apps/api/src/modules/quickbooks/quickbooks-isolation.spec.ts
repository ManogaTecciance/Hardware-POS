/**
 * D63 — the QuickBooks isolation RATCHET (convergence plan §13.1,
 * `quickbooks-isolation`).
 *
 * The stated end-state (plan §4.9.5): vendor identity lives in
 * `ExternalEntityRef`, and only a provider implementation may read it or the
 * legacy vendor columns. Ten domain-neutral modules read those columns today
 * (plan defect D-9); the read switch that removes them waits on a production
 * reconciliation cycle. Until then this spec is a RATCHET: it pins the exact
 * CURRENT reader set so it can only shrink — file eleven fails by name — and
 * pins `ExternalEntityRef` / the mirror helper to the integration modules,
 * so the satellite cannot grow the same disease the columns had.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');

function collect(matches: string[], predicate: (s: string) => boolean): number {
  let visited = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry.name) || /\.spec\.ts$/.test(entry.name)) continue;
      visited += 1;
      if (predicate(readFileSync(full, 'utf8'))) matches.push(full.replace(`${SRC}/`, ''));
    }
  };
  walk(SRC);
  return visited;
}

/** A code reference to a vendor identity column (not `syncStatus`, which is
 *  also legitimately generic in DTO names — the identity columns are the
 *  unambiguous signature). */
const VENDOR_COLUMN =
  /\b(quickbooksItemId|quickbooksCustomerId|quickbooksVendorId|quickbooksDocumentId|quickbooksPaymentId)\b/;

/** Modules that ARE the integration — allowed forever. */
const INTEGRATION_PREFIXES = [
  'modules/quickbooks/',
  'modules/sync/',
  'modules/providers/',
];

describe('vendor-column readers can only shrink (D63 ratchet)', () => {
  it('the exact reader set outside the integration is the D-9 list, no additions', () => {
    const matches: string[] = [];
    const visited = collect(matches, (s) => VENDOR_COLUMN.test(s));
    expect(visited).toBeGreaterThan(100); // D30 rule 7
    const outside = matches.filter((f) => !INTEGRATION_PREFIXES.some((p) => f.startsWith(p)));
    /*
     * The D-9 inventory, pinned exactly. Every removal is progress toward
     * the read switch; ANY addition reopens the coupling the quarantine
     * exists to end and fails here by name. When the read switch lands,
     * this list goes to [] and the assertion stays.
     */
    expect(outside.sort()).toEqual([
      'modules/categories/categories.repository.ts',
      'modules/customers/customers.service.ts',
      // Named in QuickBooks-specific error copy / the profile allow-list —
      // vocabulary, not data reads; they go with the columns regardless.
      'modules/platform/platform.errors.ts',
      'modules/platform/profile-combinations.ts',
      'modules/products/products.repository.ts',
      'modules/products/products.service.ts',
      'modules/sales/sales.repository.ts',
      'modules/sales/sales.service.ts',
      'modules/suppliers/suppliers.mapper.ts',
      'modules/suppliers/suppliers.service.ts',
    ]);
  });

  it('ExternalEntityRef and the mirror are touched only by the integration', () => {
    const matches: string[] = [];
    collect(matches, (s) => /externalEntityRef|mirrorExternalRef/.test(s));
    const outside = matches.filter((f) => !INTEGRATION_PREFIXES.some((p) => f.startsWith(p)));
    /*
     * The dual-write sites OUTSIDE the integration modules — each one is a
     * legacy vendor-column write that now mirrors (they disappear with the
     * columns at the read switch). Nothing else may join.
     */
    expect(outside.sort()).toEqual([
      'modules/customers/customers.repository.ts',
      'modules/products/products.repository.ts',
      'modules/products/products.service.ts',
      'modules/sales/sales.repository.ts',
      'modules/suppliers/suppliers.service.ts',
    ]);
  });

  it('the matcher matches real reads', () => {
    expect(VENDOR_COLUMN.test('const id = product.quickbooksItemId;')).toBe(true);
    expect(VENDOR_COLUMN.test('quickbooksDocumentId: documentId')).toBe(true);
    expect(VENDOR_COLUMN.test('nothing vendor-ish here')).toBe(false);
  });
});
