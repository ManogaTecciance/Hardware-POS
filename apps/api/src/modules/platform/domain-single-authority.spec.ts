/**
 * D56 — business-type predicates have one home on the API too.
 *
 * The API's variant of the bug the web tripwire guards: a service comparing
 * `businessType` inline instead of reading the registry or the provider
 * abstractions (D28/D31). Provider routing goes through `InventoryMode` and
 * `AccountingProviderKind` resolvers; nothing in application code should ask
 * "is this a restaurant?" of the raw enum.
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

/** `businessType ===/!== BusinessType.X` or a string literal — the forbidden shape. */
const FORBIDDEN = /businessType\s*[!=]==\s*(BusinessType\.|['"])/;

describe('no API source compares businessType inline (D56)', () => {
  it('the exact set of matching files is empty', () => {
    const matches: string[] = [];
    const visited = collect(SRC, matches, (s) => FORBIDDEN.test(s));
    // D30 rule 7: an analyser that inspected nothing proves nothing.
    expect(visited).toBeGreaterThan(100);
    expect(matches).toEqual([]);
  });

  it('the analyser can match every historical variant', () => {
    expect(FORBIDDEN.test(`profile.businessType === BusinessType.RESTAURANT`)).toBe(true);
    expect(FORBIDDEN.test(`businessType !== 'CAFE'`)).toBe(true);
    // Registry reads and null checks stay legal.
    expect(FORBIDDEN.test(`domainFor(profile.businessType)`)).toBe(false);
    expect(FORBIDDEN.test(`businessType === null`)).toBe(false);
  });
});
