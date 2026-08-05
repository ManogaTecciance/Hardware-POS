/**
 * Structural rules for the provider-aware product UI (Slice 6C-B.5).
 *
 * These complement `product-screens.render.test.tsx` rather than duplicating it.
 * The render specs prove what a tenant *sees*; these prove the shape that keeps it
 * true as the code changes — that the mode is decided in one place, that the slice
 * did not spread beyond the product screens, and that the scope boundaries the
 * slice was given were actually held.
 *
 * Written to the Risk AH standard: positive assertions alongside every negative,
 * exact file sets rather than counts, and an analyser that throws rather than
 * quietly inspecting nothing when a component is renamed or moved.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  collectFiles,
  importsOf,
  pathExists,
  readComponents,
  referencesIdentifier,
  stripComments,
} from '@/testkit/source-analysis';

/** `src/`, without the trailing slash — `collectFiles` strips `${root}/` from paths. */
const SRC = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/** Application files only: a spec may legitimately contain the strings a rule forbids. */
const APP_FILES = (name: string) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name);

/**
 * The product screens, named explicitly.
 *
 * A glob would silently shrink to nothing if the directory moved. `readComponents`
 * throws on a missing path, so a rename breaks this file loudly instead of turning
 * every rule below into a no-op.
 */
const PRODUCT_COMPONENTS = [
  'app/(app)/products/page.tsx',
  'app/(app)/products/[id]/page.tsx',
  'app/(app)/products/new/page.tsx',
  'app/(app)/products/[id]/edit/page.tsx',
  'app/(app)/products/layout.tsx',
  'components/products/product-form.tsx',
  'components/products/product-status-badge.tsx',
  'components/products/wizard/price-stock-step.tsx',
  'components/products/wizard/product-details-step.tsx',
];

const RESOLVER = 'lib/products/product-presentation.ts';

// ─────────────────────────────────────────────────────────────────────────────
// The mode is decided in one place
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory-mode decisions live in the resolver, not in JSX', () => {
  it('reads every product component, or fails saying it could not', () => {
    // The guard for requirement 42, asserted first so the rules below cannot run
    // against an empty map.
    const files = readComponents(SRC, PRODUCT_COMPONENTS);
    expect([...files.keys()].sort()).toEqual([...PRODUCT_COMPONENTS].sort());
    for (const [path, content] of files) {
      expect(content.length, `${path} is empty`).toBeGreaterThan(0);
    }
  });

  it('no product component compares an inventory mode itself', () => {
    const files = readComponents(SRC, PRODUCT_COMPONENTS);
    for (const [path, source] of files) {
      const code = stripComments(source);
      expect(code, path).not.toMatch(/inventoryMode\s*[=!]==/);
      expect(code, path).not.toMatch(/['"]QUICKBOOKS['"]\s*===/);
      expect(code, path).not.toMatch(/===\s*['"]QUICKBOOKS['"]/);
      expect(code, path).not.toMatch(/===\s*['"]DISABLED['"]/);
      expect(code, path).not.toMatch(/accountingProvider\s*[=!]==/);
      expect(code, path).not.toMatch(/businessType\s*[=!]==/);
    }
  });

  it('the resolver DOES name the modes — otherwise nothing decides', () => {
    // The positive half. Without it, "no component names a mode" would also pass
    // in a codebase where the feature was deleted entirely.
    const resolver = stripComments(readFileSync(`${SRC}/${RESOLVER}`, 'utf8'));
    for (const mode of ['QUICKBOOKS', 'LOCAL', 'EXTERNAL', 'DISABLED']) {
      expect(resolver, `resolver does not classify ${mode}`).toContain(mode);
    }
    expect(resolver).toContain('resolveProductManagementPresentation');
  });

  it('the screens that vary by mode all go through the resolver', () => {
    const files = readComponents(SRC, [
      'app/(app)/products/page.tsx',
      'app/(app)/products/[id]/page.tsx',
      'components/products/product-form.tsx',
    ]);
    for (const [path, source] of files) {
      expect(referencesIdentifier(source, 'resolveProductManagementPresentation'), path).toBe(true);
    }
  });

  it('the resolver is pure — no session, no fetch, no React', () => {
    const resolver = readFileSync(`${SRC}/${RESOLVER}`, 'utf8');
    expect(importsOf(resolver).every((spec) => spec.startsWith('@/lib/'))).toBe(true);
    const code = stripComments(resolver);
    expect(code).not.toContain('useState');
    expect(code).not.toContain('fetch(');
    expect(code).not.toContain('Date.now');
    expect(code).not.toContain('window.');
    // POSITIVE: it is not empty — it really does export the resolver.
    expect(code).toContain('export function resolveProductManagementPresentation');
  });

  it('the exact set of files importing the resolver is the product surface', () => {
    const importers = collectFiles(SRC, {
      accept: APP_FILES,
      predicate: (content) =>
        importsOf(content).some((spec) => spec.includes('products/product-presentation')),
    });
    // An exact set, not a count: two wrong importers would satisfy a count of two.
    expect(importers).toEqual([
      'app/(app)/products/[id]/page.tsx',
      'app/(app)/products/page.tsx',
      'components/products/product-form.tsx',
      'components/products/product-status-badge.tsx',
      'components/products/wizard/price-stock-step.tsx',
      'components/products/wizard/product-details-step.tsx',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mode comes from the profile, never from the product
// ─────────────────────────────────────────────────────────────────────────────

describe('the mode is read from the effective profile and nothing else', () => {
  it('the profile provider is mounted only by the products layout', () => {
    const mounters = collectFiles(SRC, {
      accept: APP_FILES,
      predicate: (content) => referencesIdentifier(content, 'PlatformProfileProvider'),
    });
    // NOT the app shell, NOT the sidebar, NOT the root layout. This is what keeps
    // the slice off every other route (requirement 36). `lib/platform-profile.tsx`
    // is where it is defined; the products layout is the only place it is mounted.
    expect(mounters).toEqual(['app/(app)/products/layout.tsx', 'lib/platform-profile.tsx']);
  });

  it('the profile hook never defaults to a mode on the client', () => {
    const hook = stripComments(readFileSync(`${SRC}/lib/platform-profile.tsx`, 'utf8'));
    // Failure and loading must both yield null; a literal mode here would be the
    // client inventing an answer the server owns.
    expect(hook).not.toContain("'QUICKBOOKS'");
    expect(hook).not.toContain("'LOCAL'");
    expect(hook).toContain('inventoryMode: null');
    // POSITIVE: it does read the authoritative endpoint.
    expect(hook).toContain('fetchPlatformProfile');
  });

  it('the resolver takes the mode as an argument rather than fetching it', () => {
    const resolver = stripComments(readFileSync(`${SRC}/${RESOLVER}`, 'utf8'));
    expect(resolver).not.toContain('fetchPlatformProfile');
    expect(resolver).not.toContain('useEffectiveProfile');
    expect(resolver).toContain('inventoryMode: ProfileInventoryState');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 36, 37, 38 — the slice stayed inside its boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('36/37 — nothing outside the product screens changed', () => {
  it('36 — the sidebar is still static and knows nothing about the profile', () => {
    const sidebar = readFileSync(`${SRC}/components/sidebar.tsx`, 'utf8');
    expect(referencesIdentifier(sidebar, 'useEffectiveProfile')).toBe(false);
    expect(referencesIdentifier(sidebar, 'PlatformProfileProvider')).toBe(false);
    expect(referencesIdentifier(sidebar, 'inventoryMode')).toBe(false);
    // POSITIVE CONTROL: the analyser really is reading the sidebar, and finds the
    // things that ARE there. Without this the three negatives above would pass
    // just as happily against an empty or missing file.
    expect(referencesIdentifier(sidebar, 'nav')).toBe(true);
  });

  it('36 — the nav definition is unchanged in shape: still a static list', () => {
    const nav = stripComments(readFileSync(`${SRC}/lib/nav.ts`, 'utf8'));
    expect(nav).not.toContain('useEffectiveProfile');
    expect(nav).not.toContain('inventoryMode');
    expect(nav).not.toContain('enabledModules');
    expect(nav).toContain('/products');
  });

  it('37 — no Restaurant route or component exists', () => {
    for (const path of [
      'app/(app)/restaurant',
      'app/(app)/menu',
      'app/(app)/dining',
      'app/(app)/tables',
      'app/(app)/kitchen',
      'app/(app)/takeaway',
      'components/restaurant',
    ]) {
      expect(pathExists(SRC, path), `${path} must not exist yet`).toBe(false);
    }
    // POSITIVE CONTROL: pathExists is capable of returning true.
    expect(pathExists(SRC, 'app/(app)/products')).toBe(true);
  });

  it('37 — no component mentions a Restaurant domain concept', () => {
    const offenders = collectFiles(SRC, {
      // Application files only — this spec necessarily contains the very names it
      // forbids, and matching itself would be a false positive forever.
      accept: APP_FILES,
      // `MenuItem` is deliberately absent: `components/ui/menu.tsx` is a generic
      // dropdown primitive that has always used that name, and a rule that flagged
      // it would be noise rather than a boundary. Every name below is unambiguously
      // a Restaurant domain concept.
      predicate: (content) =>
        /\b(KitchenOrderTicket|DiningArea|BranchInventory|TableSession|MenuCategory|KotTicket)\b/.test(
          stripComments(content),
        ),
    });
    expect(offenders).toEqual([]);

    // POSITIVE CONTROL: the same walk with a term that IS present returns files,
    // so the empty result above is a real absence, not a broken walk or filter.
    const present = collectFiles(SRC, {
      accept: APP_FILES,
      predicate: (content) => /\bManagedProduct\b/.test(stripComments(content)),
    });
    expect(present.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The testkit stays test-only
// ─────────────────────────────────────────────────────────────────────────────

describe('the source analyser never reaches the application bundle', () => {
  it('only specs import it', () => {
    const importers = collectFiles(SRC, {
      predicate: (content) => importsOf(content).some((spec) => spec.includes('testkit/')),
    });
    expect(importers.every((f) => /\.(test|spec)\.tsx?$/.test(f))).toBe(true);
    // POSITIVE: it is imported by something, so this is not passing on an empty set.
    expect(importers.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 40, 41, 42 — mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('40/41/42 — these structural rules can actually fail', () => {
  it('40 — a mode conditional creeping into a product screen would be caught', () => {
    const real = stripComments(readFileSync(`${SRC}/app/(app)/products/[id]/page.tsx`, 'utf8'));
    expect(real).not.toMatch(/inventoryMode\s*===/);

    const mutated = real.replace(
      'presentation.showSyncActions && canSyncQb',
      "inventoryMode === 'QUICKBOOKS' && canSyncQb",
    );
    expect(mutated).not.toEqual(real);
    expect(mutated).toMatch(/inventoryMode\s*===/);
  });

  it('41 — the profile hook defaulting to QuickBooks would be caught', () => {
    const real = stripComments(readFileSync(`${SRC}/lib/platform-profile.tsx`, 'utf8'));
    expect(real).not.toContain("'QUICKBOOKS'");

    const mutated = real.replace(
      'inventoryMode: null,',
      "inventoryMode: 'QUICKBOOKS',",
    );
    expect(mutated).not.toEqual(real);
    expect(mutated).toContain("'QUICKBOOKS'");
  });

  it('41 — and a sidebar that started reading the profile would be caught', () => {
    const real = readFileSync(`${SRC}/components/sidebar.tsx`, 'utf8');
    expect(referencesIdentifier(real, 'useEffectiveProfile')).toBe(false);

    const mutated = `import { useEffectiveProfile } from '@/lib/platform-profile';\n${real}`;
    expect(referencesIdentifier(mutated, 'useEffectiveProfile')).toBe(true);
  });

  it('42 — a renamed product screen makes this file fail rather than inspect nothing', () => {
    // The specific silent-vacuity mechanism, demonstrated end to end.
    expect(() => readComponents(SRC, PRODUCT_COMPONENTS)).not.toThrow();
    expect(() =>
      readComponents(SRC, ['app/(app)/products/page-renamed.tsx']),
    ).toThrow(/inspecting nothing/);
  });

  it('42 — an importer rule cannot pass by matching an empty file set', () => {
    // If the resolver were deleted, the "exact importers" rule above would compare
    // [] against a populated list and fail, rather than trivially succeeding.
    const importers = collectFiles(SRC, {
      accept: APP_FILES,
      predicate: (content) =>
        importsOf(content).some((spec) => spec.includes('products/product-presentation')),
    });
    expect(importers.length).toBeGreaterThan(0);
    expect(() => expect([]).toEqual(importers)).toThrow();
  });
});
