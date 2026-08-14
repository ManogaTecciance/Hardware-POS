/**
 * D60 — `MenuItem.basePrice` has one home (convergence plan §13.1,
 * `catalogue-single-authority`).
 *
 * The catalogue converged on `Product`; a menu item's price is now
 * `CatalogueEntry.priceOverride ?? Product.unitPrice`, resolved in exactly
 * one module. A `basePrice` read creeping back into an order path would be
 * the second catalogue quietly reopening — the exact drift D45 started
 * closing and D60 finished.
 *
 * Per D30: exact file SET, not a count; the analyser fails loudly if it
 * inspects nothing; and the positive control proves the matcher matches.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');

function collect(dir: string, matches: string[], predicate: (s: string) => boolean): number {
  let visited = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        visited += collect(full, matches, predicate);
      }
      continue;
    }
    if (!/\.ts$/.test(entry.name) || /\.spec\.ts$/.test(entry.name)) continue;
    visited += 1;
    if (predicate(readFileSync(full, 'utf8'))) matches.push(full.replace(`${SRC}/`, ''));
  }
  return visited;
}

/** A CODE read of basePrice — a member access, not a word in a comment. */
const CODE_READ = /\.basePrice\b/;

describe('MenuItem.basePrice is read only inside modules/menu (D60)', () => {
  it('the exact file set of basePrice readers is the frozen menu module', () => {
    const matches: string[] = [];
    const visited = collect(SRC, matches, (s) => CODE_READ.test(s));
    expect(visited).toBeGreaterThan(100); // D30 rule 7 — the walk found real files
    expect(matches.sort()).toEqual([
      // The one transitional resolver (override ?? product ?? frozen base).
      'modules/menu/menu-item-pricing.ts',
      // The frozen module's own read-only serialisers and (410-guarded)
      // legacy handlers. These die with the deferred drop, together.
      'modules/menu/menu-items.controller.ts',
      'modules/menu/menu-items.service.ts',
    ]);
  });

  it('the matcher matches a real read and ignores prose', () => {
    expect(CODE_READ.test('const p = item.basePrice;')).toBe(true);
    expect(CODE_READ.test('mi.basePrice.plus(x)')).toBe(true);
    expect(CODE_READ.test('// the MenuItem id whose name / basePrice the …')).toBe(false);
    expect(CODE_READ.test("basePrice: new Prisma.Decimal('1')")).toBe(false);
  });
});
