/**
 * Source-analysis primitives for the web architectural tests.
 *
 * **Test-only.** Nothing in the running application imports this; a structural test
 * enforces that. It lives under `src/` because the Vitest `include` glob is rooted
 * there, not because it is application code.
 *
 * ## Why this is a separate module from the API's copy
 *
 * The API analyser (`apps/api/src/modules/providers/testkit/source-analysis.ts`)
 * exists for the same reason and was written first, but it answers questions about
 * `.ts` service files. These questions are about `.tsx` components — JSX attributes,
 * multiple import spellings, and above all *which components were actually read*.
 *
 * ## The failure mode this is built against
 *
 * Slice 6C-A.5 found architectural tests that passed while asserting something
 * false, and the worst of them were invisible: a negative assertion over a file
 * list that turned out to be empty passes forever and looks exactly like a passing
 * test. The frontend has a sharper version of the same hazard, because a component
 * can be *renamed or moved* and a path-based analyser will then read nothing at
 * all while every `not.toContain` stays green.
 *
 * So: every function that reads a set of files **throws when the set is empty**,
 * and {@link readComponents} additionally throws when a named component it was
 * asked for is missing. An analyser that inspects nothing must look like a broken
 * test, never like a passing one.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/**
 * Remove comments so a rule matches real code, not prose describing it.
 *
 * The API analyser exists partly because a comment saying a function had been
 * removed satisfied an assertion that it was present. The same trap applies to a
 * JSX file whose header comment mentions QuickBooks.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Does this file reference an identifier **in code**?
 *
 * Word-boundary matched at the front only when the identifier starts with a word
 * character — `\b$foo` never matches, which is the defect the API analyser's
 * mutation proof surfaced, and it is reproduced here deliberately rather than
 * copied blindly.
 */
export function referencesIdentifier(source: string, identifier: string): boolean {
  const boundary = /^\w/.test(identifier) ? '\\b' : '';
  return new RegExp(`${boundary}${escapeRegExp(identifier)}`).test(stripComments(source));
}

/**
 * Every module specifier a file imports, across the spellings that actually occur.
 *
 * Static `from '…'`, dynamic `import('…')`, and `require('…')`. A rule that only
 * understood the first would be silently defeated by a lazily-imported component,
 * which is a normal thing to write in a Next app.
 */
export function importsOf(source: string): string[] {
  const code = stripComments(source);
  const specs = [
    ...[...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
  ];
  return [...new Set(specs)].sort();
}

/**
 * Read a named set of component files, keyed by their repo-relative path.
 *
 * **Throws when any path is missing**, which is the whole point. A renamed or
 * moved component must break the test that inspects it, not silently reduce it to
 * inspecting nothing. Returning a partial map would let every assertion built on
 * it pass vacuously.
 */
export function readComponents(root: string, relativePaths: string[]): Map<string, string> {
  if (relativePaths.length === 0) {
    throw new Error('readComponents was given no paths — the caller inspects nothing');
  }
  const missing = relativePaths.filter((rel) => !existsSync(resolve(root, rel)));
  if (missing.length > 0) {
    throw new Error(
      `readComponents could not find ${missing.join(', ')} — ` +
        'the component was renamed or moved, so this test is now inspecting nothing',
    );
  }
  return new Map(relativePaths.map((rel) => [rel, readFileSync(resolve(root, rel), 'utf8')]));
}

/**
 * Walk a tree and return repo-relative paths of files satisfying `predicate`.
 *
 * Returns paths, never a count, so callers can assert an **exact set**: a count
 * cannot tell "the right two files" from "two different ones".
 *
 * Throws if the walk visits no candidate at all.
 */
export function collectFiles(
  root: string,
  options: {
    skipDirs?: string[];
    accept?: (name: string) => boolean;
    predicate: (content: string, absolutePath: string) => boolean;
  },
): string[] {
  const skip = new Set(options.skipDirs ?? ['node_modules', '.next']);
  const accept = options.accept ?? ((name: string) => /\.tsx?$/.test(name));
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

/** Does a path exist on disk? Used for "no Restaurant route was created" rules. */
export function pathExists(root: string, relative: string): boolean {
  return existsSync(resolve(root, relative));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
