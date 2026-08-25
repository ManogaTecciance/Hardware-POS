import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectFiles, readComponents, stripComments } from '@/testkit/source-analysis';

/**
 * D96 / D31 — the settings screen reads flags; it does not decide.
 *
 * The hazard this guards is the one `product-presentation.ts` was written for,
 * in a second screen: `capabilities.documents.proformaBill` compared inline in
 * a 700-line page with six tab components is nine places to forget, and the one
 * that is forgotten offers a restaurant a signature upload it can never use.
 *
 * Every assertion here is a SET, never a count — a count cannot tell "the right
 * file" from "a different one" — and every negative is paired with a positive
 * so it cannot pass because the analyser inspected nothing. `collectFiles` and
 * `readComponents` both throw rather than returning empty, which is what makes
 * that pairing meaningful.
 */

const WEB_SRC = resolve(__dirname, '../../..');

/** The screen's own files: the page and everything under components/settings. */
const SETTINGS_COMPONENTS = [
  'app/(app)/settings/page.tsx',
  'app/(app)/settings/business/page.tsx',
  'components/settings/workspace-tab.tsx',
  'components/settings/bill-preview-tab.tsx',
  'components/settings/bill-structure-card.tsx',
  'components/settings/charges-tab.tsx',
  'components/settings/hours-tab.tsx',
];

/** The one file allowed to name the capability. */
const RESOLVER = 'lib/settings/document-presentation.ts';

describe('D96 — the document decision has one home', () => {
  it('the resolver exists and names the capability it routes on', () => {
    // POSITIVE FIRST. Every negative below is meaningless if this file moved.
    const source = readComponents(WEB_SRC, [RESOLVER]).get(RESOLVER);
    expect(source).toBeDefined();
    expect(source).toContain('documents.proformaBill');
    expect(source).toContain('resolveDocumentSettingsPresentation');
  });

  it('no settings component decides for itself', () => {
    const sources = readComponents(WEB_SRC, SETTINGS_COMPONENTS);

    const offenders: string[] = [];
    for (const [path, raw] of sources) {
      const code = stripComments(raw);
      // The three ways this screen could start deciding on its own.
      if (
        /proformaBill/.test(code) ||
        /businessType\s*===/.test(code) ||
        /inventoryMode\s*===/.test(code) ||
        /capabilities\.\w+\.\w+\s*===/.test(code)
      ) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);

    // …and the analyser really did read them: a stripComments that returned ''
    // would make the loop above pass over anything.
    expect(sources.size).toBe(SETTINGS_COMPONENTS.length);
    for (const [path, raw] of sources) {
      expect(stripComments(raw).length, `${path} stripped to nothing`).toBeGreaterThan(200);
    }
  });

  it('the settings page reads the resolver rather than the profile shape', () => {
    const page = readComponents(WEB_SRC, ['app/(app)/settings/page.tsx']).get(
      'app/(app)/settings/page.tsx',
    );
    // readComponents throws on a missing path, so this is belt-and-braces —
    // but an `undefined` reaching stripComments would make every assertion
    // below throw rather than fail, which reads as a broken test not a caught one.
    expect(page).toBeDefined();
    const code = stripComments(page!);

    // POSITIVE: it calls the resolver…
    expect(code).toContain('resolveDocumentSettingsPresentation');
    // …and hands the result down rather than re-deriving per tab.
    expect(code).toContain('view={view}');
    // NEGATIVE: paired, so neither can pass alone.
    expect(code).not.toContain('proformaBill');
  });

  it('the capability is read in exactly one place across the whole web app', () => {
    /*
     * An EXACT SET over every non-test source file. This is the assertion that
     * catches the tenth call site somebody adds later in a file nobody thinks
     * to open — the failure mode D56 was written for, where seven hand-written
     * businessType predicates each drifted.
     */
    const readers = collectFiles(WEB_SRC, {
      accept: (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
      predicate: (content) => /proformaBill/.test(stripComments(content)),
    });

    expect(readers).toEqual([RESOLVER]);
  });

  it('the analyser would notice a violation — mutation proof', () => {
    /*
     * D30 rule 5. The three checks above all rest on `stripComments` leaving
     * real code behind and on the regexes matching. Feed the analyser a file
     * that IS in violation and prove it says so, rather than trusting that an
     * empty offender list means what it looks like it means.
     */
    const violating = `
      const view = profile?.capabilities.documents.proformaBill ? bill() : a4();
      // proformaBill in a comment must NOT count
    `;
    const code = stripComments(violating);
    expect(/proformaBill/.test(code)).toBe(true);

    const commentOnly = '// proformaBill\n/* businessType === "RESTAURANT" */\nexport const x = 1;';
    expect(/proformaBill/.test(stripComments(commentOnly))).toBe(false);
    expect(/businessType\s*===/.test(stripComments(commentOnly))).toBe(false);
  });
});
