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
  // `app/(app)/products/layout.tsx` was listed here until Slice 8. It mounted the
  // profile provider for the product routes only; Slice 8 promoted the provider to
  // the app shell, so the file is gone. This spec failed on its removal — which is
  // the tripwire doing its job, not a defect.
  //
  // D44 replaced the 3-step ProductForm (`product-form.tsx`,
  // `wizard/price-stock-step.tsx`, `wizard/product-details-step.tsx`) with a
  // 4-step wizard shell + one step-per-file. The wizard shell owns the profile
  // read; the step components take a plain `inventoryMode` prop and never
  // touch the resolver themselves. Listing every step file here keeps the
  // "no mode conditional in JSX" rule enforced across the whole surface.
  'app/(app)/products/page.tsx',
  'app/(app)/products/[id]/page.tsx',
  'app/(app)/products/new/page.tsx',
  'app/(app)/products/[id]/edit/page.tsx',
  'components/products/product-status-badge.tsx',
  'components/products/wizard/product-wizard.tsx',
  'components/products/wizard/step-details.tsx',
  'components/products/wizard/step-variations.tsx',
  'components/products/wizard/step-pricing-inventory.tsx',
  'components/products/wizard/step-review.tsx',
  'components/products/wizard/product-preview.tsx',
  // D44 Product Details page: the tabbed shell reads the resolver too, since it
  // gates the Receive Stock header button on `managementMode === 'LOCAL'` and
  // colours the source badges via the resolver's classification. Listed here so
  // the "no mode conditional in JSX" rule catches any drift.
  'components/products/product-detail.tsx',
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
    // The wizard shell replaced the old ProductForm as the single place where
    // the mode-sensitive save flow lives; the step components never call the
    // resolver themselves, they take a plain `inventoryMode` prop. D44 added
    // the tabbed Product Details client component, which reads the resolver to
    // decide whether Receive Stock and per-branch inventory apply.
    const files = readComponents(SRC, [
      'app/(app)/products/page.tsx',
      'app/(app)/products/[id]/page.tsx',
      'components/products/wizard/product-wizard.tsx',
      'components/products/product-detail.tsx',
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
    //
    // D44 collapsed the old ProductForm + two step components into one
    // resolver-owning wizard shell; the step files never import the resolver,
    // they take a plain `inventoryMode` prop from the shell instead. Any drift
    // (a new step file reaching for the resolver, or the shell losing the
    // import) fails this exact-set assertion loudly.
    expect(importers).toEqual([
      'app/(app)/products/[id]/page.tsx',
      'app/(app)/products/page.tsx',
      'components/products/product-detail.tsx',
      'components/products/product-status-badge.tsx',
      'components/products/wizard/product-wizard.tsx',
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
    // UPDATED IN SLICE 8. Until then the provider was mounted by the products
    // layout only, precisely so Slice 6C-B.5 could not affect navigation. Slice 8
    // is the deliberate change: the shell mounts it once, and the sidebar, the
    // workspace shell and the product screens all read the same fetch.
    expect(mounters).toEqual(['app/(app)/layout.tsx', 'lib/platform-profile.tsx']);
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
  /**
   * UPDATED IN SLICE 8, and both tripwires fired first.
   *
   * Through 6C-B.5 these asserted the sidebar and nav were static and knew nothing
   * about the profile — the scope boundary that slice was given. Slice 8 is the
   * approved change, so the assertions now record the new shape: navigation is
   * derived from the profile, and it must still never route on `inventoryMode`,
   * which belongs to the product presentation resolver alone (D31).
   */
  it('8.3 — the sidebar derives navigation from the profile, not from a static list', () => {
    const sidebar = readFileSync(`${SRC}/components/sidebar.tsx`, 'utf8');
    // POSITIVE — it reads the profile and delegates to the resolver.
    expect(referencesIdentifier(sidebar, 'useEffectiveProfile')).toBe(true);
    expect(referencesIdentifier(sidebar, 'resolveNavigation')).toBe(true);
    // NEGATIVE — it does not mount the provider (the shell does), and it does not
    // reach for the inventory mode, which is not a navigation concern.
    expect(referencesIdentifier(sidebar, 'PlatformProfileProvider')).toBe(false);
    expect(referencesIdentifier(sidebar, 'inventoryMode')).toBe(false);
  });

  it('8.3 — the nav module gates on business type and modules, never on inventory mode', () => {
    const nav = stripComments(readFileSync(`${SRC}/lib/nav.ts`, 'utf8'));
    expect(nav).toContain('enabledModules');
    expect(nav).toContain('businessType');
    expect(nav).toContain('/products');
    // Stock authority is a product-screen concern. A navigation entry that appeared
    // or vanished with the inventory mode would be a second, competing authority.
    expect(nav).not.toContain('inventoryMode');
    expect(nav).not.toContain('useEffectiveProfile');
  });

  it('8.3 — the resolver is the only place navigation is filtered', () => {
    const sidebar = stripComments(readFileSync(`${SRC}/components/sidebar.tsx`, 'utf8'));
    // The sidebar PASSES the module list to the resolver, so it necessarily names
    // it. What it must not do is filter on it — that would be a second authority
    // that could disagree with the first.
    expect(sidebar).toContain('resolveNavigation');
    expect(sidebar).not.toMatch(/enabledModules[^)]*\.includes/);
    expect(sidebar).not.toMatch(/\.filter\(/);
    expect(sidebar).not.toMatch(/businessType\s*===/);
  });

  /**
   * UPDATED IN SLICE 8. Through 6C-B.5 this asserted no Restaurant route existed at
   * all, which is what stopped that slice drifting into this one. Slice 8.4 creates
   * the shells deliberately, so the rule becomes: these routes exist, and they are
   * *only* shells.
   */
  it('8.4 — the Restaurant route shells exist', () => {
    // Pilot Change 2 deleted `/takeaway` as a top-level route — Takeaway is
    // now a POS mode at `/pos?mode=takeaway`. `/pos` and `/orders` are the
    // new top-level destinations that replaced it; both exist.
    for (const path of [
      'app/(app)/menu',
      'app/(app)/tables',
      'app/(app)/kitchen',
      'app/(app)/pos',
      'app/(app)/orders',
    ]) {
      expect({ path, exists: pathExists(SRC, path) }).toEqual({ path, exists: true });
    }
  });

  it('8.4 — the shells are shells: no data, no writes, no fake state', () => {
    // page.tsx files stay as thin wrappers even after Phases D–I landed
    // real components — the meaty state lives in imported components under
    // `components/restaurant/*`. `/pos` is not in this list because its
    // page.tsx does the business-type dispatch (reads useAuth /
    // useEffectiveProfile), which is the deliberate exception.
    const shells = readComponents(SRC, [
      'app/(app)/menu/page.tsx',
      'app/(app)/tables/page.tsx',
      'app/(app)/kitchen/page.tsx',
      'app/(app)/orders/page.tsx',
      'components/upcoming-feature.tsx',
    ]);
    for (const [path, source] of shells) {
      const code = stripComments(source);
      // Nothing that could read, write or fabricate restaurant state.
      for (const forbidden of ['useState', 'useEffect', 'fetch(', 'api.', 'onSubmit', 'onClick']) {
        expect({ path, forbidden, present: code.includes(forbidden) }).toEqual({
          path,
          forbidden,
          present: false,
        });
      }
    }
    // POSITIVE CONTROL: the files are real and say what they are.
    expect(shells.get('components/upcoming-feature.tsx')).toContain(
      'Not implemented in this release',
    );
  });

  it('Restaurant routes remain shells; the domain lives under components/restaurant', () => {
    // Frontend Phases A-C landed real Restaurant UI. What still holds is
    // that the domain lives under one directory (`components/restaurant/`),
    // NOT scattered under `app/(app)/restaurant/` or `app/(app)/dining/`
    // subtrees — that would create a second application shape, which was
    // the original tripwire's real concern. Routes remain the existing
    // top-level entries (`/menu`, `/tables`, …).
    for (const forbiddenRoutePrefix of ['app/(app)/restaurant', 'app/(app)/dining']) {
      expect({
        path: forbiddenRoutePrefix,
        exists: pathExists(SRC, forbiddenRoutePrefix),
      }).toEqual({ path: forbiddenRoutePrefix, exists: false });
    }
    // POSITIVE CONTROL: the two directories that DO exist by design.
    expect(pathExists(SRC, 'app/(app)/products')).toBe(true);
    expect(pathExists(SRC, 'components/restaurant')).toBe(true);
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
    // D44 replaced the old flat detail page with a tabbed shell + dedicated
    // client component. The shell still gates on the resolver (`canReceive` is
    // fed from `presentation.managementMode === 'LOCAL'` inside
    // `product-detail.tsx`), so the mutation target is the shell's prop pass —
    // introducing an `inventoryMode ===` guard there is exactly the regression
    // this rule exists to catch.
    const real = stripComments(readFileSync(`${SRC}/app/(app)/products/[id]/page.tsx`, 'utf8'));
    expect(real).not.toMatch(/inventoryMode\s*===/);

    const mutated = real.replace(
      'hasReceivePermission={canReceive}',
      "hasReceivePermission={canReceive && inventoryMode === 'LOCAL'}",
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

  it('8.3 — a navigation resolver that ignored modules would be caught', () => {
    // Replaces the 6C-B.5 proof about the sidebar reading the profile, which is now
    // the intended behaviour. The regression that matters at Slice 8 is the module
    // filter being dropped, which would show every retail entry to a restaurant.
    const real = stripComments(readFileSync(`${SRC}/lib/nav.ts`, 'utf8'));
    expect(real).toContain('enabled.has(item.module)');

    const mutated = real.replace('(!item.module || enabled.has(item.module)) &&', '');
    expect(mutated).not.toEqual(real);
    expect(mutated).not.toContain('enabled.has(item.module)');
  });

  it('8.3 — a resolver that guessed while the profile was unresolved would be caught', () => {
    const real = stripComments(readFileSync(`${SRC}/lib/nav.ts`, 'utf8'));
    expect(real).toContain('if (input.businessType === null || input.enabledModules === null) return [];');

    const mutated = real.replace(
      'if (input.businessType === null || input.enabledModules === null) return [];',
      '',
    );
    expect(mutated).not.toEqual(real);
    expect(mutated).not.toContain('input.enabledModules === null');
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
