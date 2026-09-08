/**
 * Source-analysis primitives for the architectural tests.
 *
 * **Test-only.** Nothing in the running application imports this; a contract test
 * in `provider-contract.spec.ts` enforces that. It lives under `src/` because the
 * unit Jest project has `rootDir: src`, not because it is production code.
 *
 * ## Why this exists
 *
 * Slice 6C-A found two structural tripwires that passed while asserting something
 * false. Both failed the same way: the assertion could not tell the state it
 * forbade from the state it expected.
 *
 *  • One compared a stock quantity that is identical whether or not the provider is
 *    consulted, so it passed for the wrong reason.
 *  • One asserted `source.toContain('decrementStock')` against a file where the
 *    only remaining occurrence was **a comment saying the function had been
 *    removed**. The test claimed the opposite of reality and stayed green.
 *
 * The second is the more dangerous class, because it is invisible: a negative
 * assertion built on a broken analyser passes silently forever. So every primitive
 * here is a pure function with no filesystem access, and every one is tested
 * against a pair of fixtures — one adopted, one unadopted — that must produce
 * *different* answers. If a primitive stops discriminating, its own spec fails
 * before any test built on it can go quietly vacuous.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/**
 * Remove comments so a rule matches real code, not prose describing it.
 *
 * This is the fix for the `decrementStock` failure: a comment explaining that
 * something was removed must never satisfy an assertion that it is present.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `from '…'` specifier in a file, comments excluded. */
export function importsOf(source: string): string[] {
  return [...stripComments(source).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Does this file reference an identifier **in code**?
 *
 * Word-boundary matched, so `InventoryProvider` does not match
 * `InventoryProviderFactory`… except that it does, by design: the question these
 * tests ask is "does this file touch the provider layer at all", and a factory
 * reference is a touch. `referencesExactly` is available where the distinction
 * matters.
 */
export function referencesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`${leadingBoundary(identifier)}${escapeRegExp(identifier)}`).test(
    stripComments(source),
  );
}

/**
 * `\b` before a non-word character never matches.
 *
 * `\b$transaction` looks right and is always false, because there is no word
 * boundary between `.` and `$` in `this.prisma.$transaction`. A negative assertion
 * built on it would pass forever — the exact vacuity this audit exists to remove,
 * and it was found by the mutation proof rather than by review.
 */
function leadingBoundary(identifier: string): string {
  return /^\w/.test(identifier) ? '\\b' : '';
}

/** Whole-word match: `InventoryProvider` does NOT match `InventoryProviderFactory`. */
export function referencesExactly(source: string, identifier: string): boolean {
  return new RegExp(
    `${leadingBoundary(identifier)}${escapeRegExp(identifier)}\\b(?!\\w)`,
  ).test(stripComments(source));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * List the non-spec TypeScript files in a directory.
 *
 * **Throws when it finds nothing.** An empty listing is the single most common way
 * a `for (const file of …) expect(…).not.toContain(…)` loop becomes vacuous: the
 * body never runs and the test passes having checked nothing. A wrong path is a
 * test bug, and it should look like one.
 */
export function listSourceFiles(dir: string): string[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .sort();
  if (files.length === 0) {
    throw new Error(`listSourceFiles found no source files in ${dir} — the path is wrong`);
  }
  return files;
}

/**
 * Walk a tree and return the repo-relative paths of files satisfying `predicate`.
 *
 * Returns paths, never a count, so callers assert an **exact set**. A count-only
 * assertion cannot tell "the right two importers" from "two different ones".
 *
 * Throws if the walk visits no candidate file at all, for the same reason as
 * {@link listSourceFiles}.
 */
export function collectFiles(
  root: string,
  options: {
    /** Directory names to skip entirely. */
    skipDirs?: string[];
    /** Which files are candidates (by file name). */
    accept?: (name: string) => boolean;
    /** Which candidates to report (by content and absolute path). */
    predicate: (content: string, absolutePath: string) => boolean;
  },
): string[] {
  const skip = new Set(options.skipDirs ?? []);
  const accept = options.accept ?? ((name: string) => name.endsWith('.ts'));
  const matches: string[] = [];
  let visited = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
        continue;
      }
      if (!accept(entry.name)) continue;
      visited += 1;
      if (options.predicate(readFileSync(full, 'utf8'), full)) {
        /*
         * Posix separators, always. `resolve` returns backslashes on Windows,
         * so stripping a `${root}/` prefix matched nothing there and every
         * exact-set assertion in the repo compared repo-relative paths against
         * absolute ones — six architectural tripwires that failed on any
         * Windows checkout and could not be read at all. The sets they assert
         * are written with forward slashes, so the paths must be too.
         */
        const rel = relative(root, full).split(sep).join('/');
        matches.push(rel);
      }
    }
  };
  walk(root);

  if (visited === 0) {
    throw new Error(`collectFiles visited no candidate files under ${root} — the walk is broken`);
  }
  return matches.sort();
}
