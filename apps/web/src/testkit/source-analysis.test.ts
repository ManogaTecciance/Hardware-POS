/**
 * The analyser's own tests.
 *
 * Every architectural test in this workspace is built on these primitives, so a
 * primitive that stops discriminating would take every rule built on it down
 * silently. Each function is therefore exercised against the full fixture set the
 * Risk AH standard requires: valid source, invalid source, empty source, a renamed
 * symbol, nested/multiline syntax, and every import form.
 *
 * The load-bearing property is that each pair of fixtures must produce *different*
 * answers. A primitive that returned `false` for everything would satisfy half of
 * these assertions, so the other half exist to catch exactly that.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collectFiles,
  importsOf,
  pathExists,
  readComponents,
  referencesIdentifier,
  stripComments,
} from './source-analysis';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Adopted: reads the resolver, names no inventory mode. */
const VALID = `
'use client';
import { resolveProductManagementPresentation } from '@/lib/products/product-presentation';

export function Widget({ mode }: { mode: string | null }) {
  const p = resolveProductManagementPresentation({ inventoryMode: mode });
  return p.showSyncActions ? <button>Sync to QuickBooks</button> : null;
}
`;

/** Unadopted: the exact regression the rules exist to catch. */
const INVALID = `
'use client';
export function Widget({ mode }: { mode: string | null }) {
  if (mode === 'QUICKBOOKS') {
    return <button>Sync to QuickBooks</button>;
  }
  return null;
}
`;

const EMPTY = '';

/** The same component after someone renamed the resolver but not the rule. */
const RENAMED = VALID.replace(/resolveProductManagementPresentation/g, 'resolvePresentation');

/** Multiline JSX and a nested ternary — the shapes a naive single-line regex misses. */
const NESTED = `
import {
  resolveProductManagementPresentation,
  type ProductPresentation,
} from '@/lib/products/product-presentation';

export function Widget({ p }: { p: ProductPresentation }) {
  return (
    <div>
      {p.showSyncActions ? (
        <button
          onClick={() => {
            void sync();
          }}
        >
          Sync to QuickBooks
        </button>
      ) : p.label ? (
        <span>{p.label}</span>
      ) : null}
    </div>
  );
}
`;

/** Every import spelling that occurs in this codebase. */
const IMPORT_FORMS = `
import Default from 'a';
import { named } from 'b';
import type { OnlyAType } from 'c';
import * as ns from 'd';
import 'e';
const lazy = await import('f');
const cjs = require('g');
import {
  multi,
  line,
} from 'h';
`;

/** A file whose only mention of the forbidden thing is in prose. */
const COMMENT_ONLY = `
// This component used to branch on inventoryMode === 'QUICKBOOKS'.
/* It no longer references resolveProductManagementPresentation directly either. */
export function Widget() {
  return null;
}
`;

// ─────────────────────────────────────────────────────────────────────────────

describe('stripComments', () => {
  it('removes line and block comments but keeps code', () => {
    const stripped = stripComments(COMMENT_ONLY);
    expect(stripped).not.toContain('QUICKBOOKS');
    expect(stripped).not.toContain('resolveProductManagementPresentation');
    // POSITIVE: it did not simply empty the file.
    expect(stripped).toContain('export function Widget');
  });

  it('leaves a URL in a string alone — `//` inside `https://` is not a comment', () => {
    expect(stripComments("const u = 'https://example.com/x';")).toContain('https://example.com/x');
  });

  it('handles empty source without throwing', () => {
    expect(stripComments(EMPTY)).toBe('');
  });
});

describe('referencesIdentifier', () => {
  it('valid vs invalid source give DIFFERENT answers', () => {
    expect(referencesIdentifier(VALID, 'resolveProductManagementPresentation')).toBe(true);
    expect(referencesIdentifier(INVALID, 'resolveProductManagementPresentation')).toBe(false);
  });

  it('detects the forbidden state in the invalid fixture', () => {
    expect(referencesIdentifier(INVALID, 'QUICKBOOKS')).toBe(true);
    expect(referencesIdentifier(VALID, 'QUICKBOOKS')).toBe(false);
  });

  it('empty source references nothing, and does not throw', () => {
    expect(referencesIdentifier(EMPTY, 'anything')).toBe(false);
  });

  it('a renamed symbol is reported as absent — the rule must then be updated', () => {
    // This is the case that silently guts a test suite. It must be a visible false.
    expect(referencesIdentifier(RENAMED, 'resolveProductManagementPresentation')).toBe(false);
    expect(referencesIdentifier(RENAMED, 'resolvePresentation')).toBe(true);
  });

  it('sees through nested and multiline JSX', () => {
    expect(referencesIdentifier(NESTED, 'resolveProductManagementPresentation')).toBe(true);
    expect(referencesIdentifier(NESTED, 'showSyncActions')).toBe(true);
    expect(referencesIdentifier(NESTED, 'inventoryMode')).toBe(false);
  });

  it('ignores a mention that exists only in a comment', () => {
    expect(referencesIdentifier(COMMENT_ONLY, 'QUICKBOOKS')).toBe(false);
    // POSITIVE CONTROL: uncommented, the same text IS found.
    expect(referencesIdentifier("const m = 'QUICKBOOKS';", 'QUICKBOOKS')).toBe(true);
  });

  it('respects the leading word boundary without breaking on non-word starts', () => {
    expect(referencesIdentifier('const x = a.$transaction();', '$transaction')).toBe(true);
    expect(referencesIdentifier('const x = notinventoryMode;', 'inventoryMode')).toBe(false);
  });
});

describe('importsOf', () => {
  it('finds every import form, deduplicated and sorted', () => {
    expect(importsOf(IMPORT_FORMS)).toEqual(['a', 'b', 'c', 'd', 'f', 'g', 'h']);
  });

  it('finds dynamic and CJS forms a `from`-only rule would miss', () => {
    // The specific vacuity: a lazily-imported component evading an import rule.
    expect(importsOf("const C = await import('@/components/x');")).toEqual(['@/components/x']);
    expect(importsOf("const C = require('@/components/y');")).toEqual(['@/components/y']);
  });

  it('valid vs invalid fixtures give different answers', () => {
    expect(importsOf(VALID)).toEqual(['@/lib/products/product-presentation']);
    expect(importsOf(INVALID)).toEqual([]);
  });

  it('handles multiline import statements', () => {
    expect(importsOf(NESTED)).toEqual(['@/lib/products/product-presentation']);
  });

  it('empty source imports nothing, and does not throw', () => {
    expect(importsOf(EMPTY)).toEqual([]);
  });

  it('ignores an import that is only written in a comment', () => {
    expect(importsOf("// import { X } from 'commented';")).toEqual([]);
  });
});

// ── the anti-vacuity guarantees (requirement 42) ──────────────────────────────

describe('42 — an analyser that inspects nothing must fail, not pass', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'axlo-analyser-'));
    mkdirSync(resolve(root, 'components'), { recursive: true });
    mkdirSync(resolve(root, 'empty-dir'), { recursive: true });
    writeFileSync(resolve(root, 'components/valid.tsx'), VALID);
    writeFileSync(resolve(root, 'components/invalid.tsx'), INVALID);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('readComponents throws when a named component is missing (renamed or moved)', () => {
    expect(() => readComponents(root, ['components/valid.tsx'])).not.toThrow();
    expect(() => readComponents(root, ['components/gone.tsx'])).toThrow(/inspecting nothing/);
    // The message names the file, so the failure is actionable rather than cryptic.
    expect(() => readComponents(root, ['components/gone.tsx'])).toThrow(/components\/gone\.tsx/);
  });

  it('readComponents throws when handed an empty path list', () => {
    expect(() => readComponents(root, [])).toThrow(/inspects nothing/);
  });

  it('readComponents returns real contents, not empty strings', () => {
    const files = readComponents(root, ['components/valid.tsx', 'components/invalid.tsx']);
    expect([...files.keys()].sort()).toEqual(['components/invalid.tsx', 'components/valid.tsx']);
    expect(files.get('components/valid.tsx')).toContain('resolveProductManagementPresentation');
    expect(files.get('components/invalid.tsx')).not.toContain(
      'resolveProductManagementPresentation',
    );
  });

  it('collectFiles throws when the walk visits no candidate file', () => {
    expect(() => collectFiles(resolve(root, 'empty-dir'), { predicate: () => true })).toThrow(
      /walk is broken/,
    );
  });

  it('collectFiles returns an exact path set, and discriminates', () => {
    const adopted = collectFiles(root, {
      predicate: (c) => referencesIdentifier(c, 'resolveProductManagementPresentation'),
    });
    const unadopted = collectFiles(root, {
      predicate: (c) => !referencesIdentifier(c, 'resolveProductManagementPresentation'),
    });
    expect(adopted).toEqual(['components/valid.tsx']);
    expect(unadopted).toEqual(['components/invalid.tsx']);
    // The two sets partition the tree — neither predicate matched everything.
    expect(adopted).not.toEqual(unadopted);
  });

  it('pathExists distinguishes present from absent', () => {
    expect(pathExists(root, 'components/valid.tsx')).toBe(true);
    expect(pathExists(root, 'components/restaurant')).toBe(false);
  });
});
