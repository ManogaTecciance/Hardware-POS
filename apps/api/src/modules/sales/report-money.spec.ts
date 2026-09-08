/**
 * D129 (`8.1`) — no retail report may coerce a money `Decimal` to a number.
 *
 * ## Why this exists
 *
 * Audit item **A8** — *"Reports coerce `Decimal` → float, then `.toFixed(2)`"* —
 * was assigned to the retail template by the PO. Phase 8's pre-work opened the
 * file and found the defect lives **only** in
 * `restaurant-reports.service.ts` (15 sites); every retail report service is
 * already clean. Fixing a restaurant file would breach the standing "do not
 * touch the restaurant module" constraint and the governance document's own
 * guarantee that no phase in this plan edits a restaurant file, so A8 was handed
 * over (`RT-02`).
 *
 * This tripwire is the half retail CAN discharge: the pattern must not reappear
 * in the reports Phase 8 is about to build. D59 — one money engine,
 * `Prisma.Decimal` throughout.
 *
 * ## What makes this non-vacuous (D30)
 *
 * `collectFiles` throws when it visits zero candidates, so a moved directory
 * fails loudly instead of reporting "no violations". The guarded set is asserted
 * as an **exact list** — a report added to one of these directories is inside
 * the guard automatically, and a report added anywhere else fails the coverage
 * assertion below rather than escaping silently. The analyser is proven against
 * violating source, clean source, and comment-only occurrences, and the mutation
 * proof runs it over the real restaurant file that A8 describes: a detector that
 * cannot see the known defect would prove nothing about ours.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectFiles, stripComments } from '../providers/testkit/source-analysis';

const API_SRC = resolve(__dirname, '../..');

/**
 * Money coerced out of `Decimal` and accumulated, or formatted back with
 * `.toFixed`. Both halves of A8's shape.
 *
 * Deliberately NOT a bare `Number(` search: `Number(quantity)` on a count, or a
 * `Number()` inside a comparison, is not a money defect, and a rule that shouted
 * about those would be turned off within a week.
 */
const FLOAT_MONEY = [
  // `total += Number(x)` — accumulating money in a double.
  /[+-]=\s*Number\s*\(/,
  // `.reduce((a, x) => a + Number(...))` — the same, spelled differently.
  /\+\s*Number\s*\(/,
  // `something.toFixed(` on a plain number. `Prisma.Decimal.toFixed` is fine,
  // so this is paired with the accumulation patterns above rather than used
  // alone — see `hasFloatMoney`.
  /\.toFixed\s*\(/,
];

/** True when the source both accumulates money as a number AND formats it back. */
export function hasFloatMoney(source: string): boolean {
  const code = stripComments(source);
  const accumulates = FLOAT_MONEY[0]!.test(code) || FLOAT_MONEY[1]!.test(code);
  const formats = FLOAT_MONEY[2]!.test(code);
  return accumulates && formats;
}

/**
 * The retail report surfaces this rule guards.
 *
 * An exact list, not a glob over `modules/`: naming them means adding a report
 * module without adding it here is caught by the coverage assertion, rather than
 * quietly falling outside the guard.
 */
const GUARDED_DIRS = ['modules/sales', 'modules/products', 'modules/dashboard'];

describe('D129 — retail reports keep money in Decimal', () => {
  it('the analyser sees the real A8 defect it was written for', () => {
    // Mutation proof, against production source rather than a fixture: the
    // restaurant reports file IS A8. A detector that cannot flag it proves
    // nothing about the files it does clear.
    const a8 = readFileSync(
      resolve(API_SRC, 'modules/restaurant-reports/restaurant-reports.service.ts'),
      'utf8',
    );
    expect(hasFloatMoney(a8)).toBe(true);
  });

  it('flags violating source and clears clean source', () => {
    expect(
      hasFloatMoney('let t = 0; t += Number(sale.total); return t.toFixed(2);'),
    ).toBe(true);
    expect(
      hasFloatMoney('let t = new Prisma.Decimal(0); t = t.plus(sale.total); return t.toFixed(2);'),
    ).toBe(false);
    // Accumulation without formatting, and formatting without accumulation, are
    // each half the shape and neither is the defect.
    expect(hasFloatMoney('let n = 0; n += Number(row.qty);')).toBe(false);
    expect(hasFloatMoney('return d.toFixed(2);')).toBe(false);
  });

  it('ignores the pattern when it appears only in a comment', () => {
    expect(
      hasFloatMoney('// historical: t += Number(x) then t.toFixed(2)\nreturn d.toFixed(2);'),
    ).toBe(false);
  });

  it('no retail report service accumulates money as a number', () => {
    const offenders = GUARDED_DIRS.flatMap((dir) =>
      collectFiles(resolve(API_SRC, dir), {
        skipDirs: ['node_modules', 'dto'],
        accept: (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
        predicate: (content) => hasFloatMoney(content),
      }),
    );
    expect(offenders).toEqual([]);
  });

  it('every retail report service is actually inside the guard', () => {
    // The assertion above is worthless if it walks the wrong tree, so the set of
    // report services on disk is compared against the guarded directories. A new
    // report module fails HERE rather than escaping the rule in silence.
    const reportFiles = collectFiles(API_SRC, {
      skipDirs: ['node_modules', 'restaurant-reports'],
      accept: (name) => name.endsWith('-report.service.ts') || name === 'dashboard.service.ts',
      predicate: () => true,
    });

    expect(reportFiles.length).toBeGreaterThan(0);
    const unguarded = reportFiles.filter(
      (f) => !GUARDED_DIRS.some((dir) => f.includes(dir.replace('modules/', ''))),
    );
    expect(unguarded).toEqual([]);
  });
});
