/**
 * The product presentation resolver, exhaustively.
 *
 * Written to the architectural-test standard adopted in Slice 6C-A.5 (Risk AH):
 *
 *  • Every mode is asserted **positively** for what it does show and **negatively**
 *    for what it must not — never only the negative half, which is how a test ends
 *    up passing against a resolver that returns nothing at all.
 *  • The modes are compared against each other, so two modes cannot quietly
 *    converge on the same presentation and still pass (requirement 39: distinct
 *    observable results).
 *  • The whole `InventoryMode` space is walked from runtime data cross-checked
 *    against the classification table, so a mode added to the type but not
 *    classified fails here as well as at the compiler.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_INVENTORY_MODES,
  classifiedInventoryModes,
  resolveProductManagementPresentation,
  type ProductPresentation,
  type ProfileInventoryState,
} from './product-presentation';

const QUICKBOOKS_WORDS = /quickbooks|not synced|sync failed|retry/i;

function presentationFor(
  inventoryMode: ProfileInventoryState,
  overrides: { quickbooksItemId?: string | null } = {},
): ProductPresentation {
  return resolveProductManagementPresentation({
    inventoryMode,
    syncStatus: 'NOT_SYNCED',
    quickbooksItemId: overrides.quickbooksItemId ?? null,
  });
}

/** Every user-visible string a presentation carries, for wording assertions. */
function visibleText(p: ProductPresentation): string {
  return [
    p.label,
    p.sourceLabel,
    p.sourceDetailLabel,
    p.stockTrackingNote,
    p.helpText,
    p.detailsHelpText,
    p.imageHelpText,
    p.saveMessage,
    p.warning,
  ]
    .filter((v): v is string => v !== null)
    .join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9, 10 — exhaustiveness
// ─────────────────────────────────────────────────────────────────────────────

describe('9/10 — every InventoryMode is classified', () => {
  it('the runtime mode list and the classification table agree exactly', () => {
    // Not a count comparison: an exact set both ways. A mode present in one and
    // absent from the other names itself in the failure.
    expect(classifiedInventoryModes()).toEqual([...ALL_INVENTORY_MODES].sort());
  });

  it('resolves a complete presentation for every mode, and for the unresolved state', () => {
    const states: ProfileInventoryState[] = [...ALL_INVENTORY_MODES, null];
    expect(states.length).toBeGreaterThan(1);

    for (const mode of states) {
      const p = presentationFor(mode);
      // POSITIVE: every field is populated, so a mode cannot pass by resolving to
      // an empty object that satisfies every `not.toContain` below.
      expect(typeof p.managementMode).toBe('string');
      expect(p.helpText.length).toBeGreaterThan(0);
      expect(p.detailsHelpText.length).toBeGreaterThan(0);
      expect(p.imageHelpText.length).toBeGreaterThan(0);
      expect(typeof p.showSyncActions).toBe('boolean');
      expect(typeof p.showSyncStatus).toBe('boolean');
      expect(typeof p.showRefreshAction).toBe('boolean');
      expect(typeof p.showStockControls).toBe('boolean');
    }
  });

  it('is pure — the same input resolves to the same output', () => {
    for (const mode of ALL_INVENTORY_MODES) {
      expect(presentationFor(mode)).toEqual(presentationFor(mode));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 39 — distinct observable results
// ─────────────────────────────────────────────────────────────────────────────

describe('39 — each mode produces a distinguishable presentation', () => {
  it('no two modes resolve to the same presentation', () => {
    const seen = new Map<string, ProfileInventoryState>();
    for (const mode of [...ALL_INVENTORY_MODES, null]) {
      const key = JSON.stringify(presentationFor(mode));
      const clash = seen.get(key);
      expect(
        clash === undefined,
        `${String(mode)} and ${String(clash)} present identically — the test could not tell them apart`,
      ).toBe(true);
      seen.set(key, mode);
    }
  });

  it('the sync-action flag genuinely splits the modes, rather than being always-false', () => {
    const allowed = ALL_INVENTORY_MODES.filter((m) => presentationFor(m).showSyncActions);
    const refused = ALL_INVENTORY_MODES.filter((m) => !presentationFor(m).showSyncActions);
    // Both sides non-empty: a flag that is false everywhere would make every
    // "does not show sync" assertion below vacuously true.
    expect(allowed).toEqual(['QUICKBOOKS']);
    expect(refused).toEqual(['LOCAL', 'EXTERNAL', 'DISABLED']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1, 2, 11, 24, 31-34 — QuickBooks is untouched
// ─────────────────────────────────────────────────────────────────────────────

describe('1/2/11/24 — the QUICKBOOKS presentation is the existing one', () => {
  const qb = presentationFor('QUICKBOOKS');

  it('offers the existing explicit sync, refresh and sync-status surfaces', () => {
    expect(qb.managementMode).toBe('EXTERNAL_CATALOGUE');
    expect(qb.showSyncActions).toBe(true);
    expect(qb.showRefreshAction).toBe(true);
    expect(qb.showSyncStatus).toBe(true);
    expect(qb.showExternalAccounts).toBe(true);
    expect(qb.showStockControls).toBe(true);
    expect(qb.showStockWarnings).toBe(true);
  });

  it('keeps the existing page, form and image wording verbatim', () => {
    expect(qb.helpText).toBe('Manage the product catalog. QuickBooks remains the inventory master.');
    expect(qb.detailsHelpText).toBe(
      'The name, type, and category this product is filed under — mirroring QuickBooks.',
    );
    expect(qb.imageHelpText).toBe('Shown on the POS tiles only — this photo is not sent to QuickBooks.');
  });

  it('defers the status label to SyncBadge rather than restating it', () => {
    // `label: null` is what makes ProductStatusBadge render the untouched SyncBadge.
    expect(qb.label).toBeNull();
    expect(qb.showSyncStatus).toBe(true);
  });

  it('keeps the existing Source split, both wordings and both variants', () => {
    const linked = presentationFor('QUICKBOOKS', { quickbooksItemId: 'qb-1' });
    const unlinked = presentationFor('QUICKBOOKS', { quickbooksItemId: null });

    expect(linked.sourceLabel).toBe('QuickBooks');
    expect(linked.sourceDetailLabel).toBe('QuickBooks-managed');
    expect(linked.sourceBadgeKind).toBe('primary');

    expect(unlinked.sourceLabel).toBe('Local');
    expect(unlinked.sourceDetailLabel).toBe('Local (not synced)');
    expect(unlinked.sourceBadgeKind).toBe('neutral');
  });

  it('adds no post-save banner, so the existing redirect is unchanged', () => {
    expect(qb.saveMessage).toBeNull();
    expect(qb.warning).toBeNull();
  });

  it('is unaffected by syncStatus — status drives the badge, not the mode', () => {
    const statuses = ['NOT_SYNCED', 'PENDING', 'SYNCING', 'SYNCED', 'FAILED'] as const;
    const shapes = statuses.map((syncStatus) =>
      JSON.stringify(
        resolveProductManagementPresentation({
          inventoryMode: 'QUICKBOOKS',
          syncStatus,
          quickbooksItemId: 'qb-1',
        }),
      ),
    );
    expect(new Set(shapes).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3, 4, 12, 14, 21, 23, 25 — LOCAL
// ─────────────────────────────────────────────────────────────────────────────

describe('3/4/12/14/21/23/25 — LOCAL is locally managed and complete', () => {
  const local = presentationFor('LOCAL');

  it('says it is locally managed', () => {
    expect(local.managementMode).toBe('LOCAL');
    expect(local.label).toBe('Locally managed');
    expect(local.sourceLabel).toBe('Locally managed');
    expect(local.sourceDetailLabel).toBe('Locally managed');
    expect(local.helpText).toContain('AxloPOS');
  });

  it('keeps stock, because AxloPOS is the authority for it', () => {
    expect(local.showStockControls).toBe(true);
    expect(local.showStockWarnings).toBe(true);
    expect(local.stockTrackingNote).toBeNull();
  });

  it('offers no QuickBooks synchronisation surface at all', () => {
    expect(local.showSyncActions).toBe(false);
    expect(local.showRefreshAction).toBe(false);
    expect(local.showSyncStatus).toBe(false);
    expect(local.showExternalAccounts).toBe(false);
  });

  it('21 — never uses QuickBooks or "not synced" wording', () => {
    expect(visibleText(local)).not.toMatch(QUICKBOOKS_WORDS);
    // Positive control: the matcher does fire on the mode that legitimately uses
    // that wording, so this is not passing because the pattern is broken.
    expect(visibleText(presentationFor('QUICKBOOKS', { quickbooksItemId: null }))).toMatch(
      QUICKBOOKS_WORDS,
    );
  });

  it('25 — a null quickbooksItemId is not styled as a failure', () => {
    const unlinked = presentationFor('LOCAL', { quickbooksItemId: null });
    expect(unlinked.badgeKind).toBe('neutral');
    expect(unlinked.sourceBadgeKind).toBe('neutral');
    expect(unlinked.label).toBe('Locally managed');
  });

  it('does not change its mind when a stale quickbooksItemId is present', () => {
    // Historical data must not resurrect the QuickBooks presentation: the mode is
    // the authority, and a leftover id is not evidence of one.
    expect(presentationFor('LOCAL', { quickbooksItemId: 'qb-legacy' })).toEqual(local);
  });

  it('23 — describes a local save', () => {
    expect(local.saveMessage).toBe('Saved to AxloPOS.');
    expect(local.saveMessage).not.toMatch(QUICKBOOKS_WORDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5, 13, 15, 22 — DISABLED
// ─────────────────────────────────────────────────────────────────────────────

describe('5/13/15/22 — DISABLED is a catalogue, not a stock ledger', () => {
  const disabled = presentationFor('DISABLED');

  it('uses catalogue and stock-disabled wording', () => {
    expect(disabled.managementMode).toBe('CATALOGUE_ONLY');
    expect(disabled.label).toBe('Catalogue item');
    expect(disabled.sourceLabel).toBe('Catalogue item');
    expect(disabled.stockTrackingNote).toBe('Stock tracking disabled');
    expect(disabled.helpText).toContain('Stock tracking is disabled');
  });

  it('presents no stock figure as an availability promise', () => {
    expect(disabled.showStockControls).toBe(false);
    expect(disabled.showStockWarnings).toBe(false);
  });

  it('offers no QuickBooks or inventory synchronisation surface', () => {
    expect(disabled.showSyncActions).toBe(false);
    expect(disabled.showRefreshAction).toBe(false);
    expect(disabled.showSyncStatus).toBe(false);
    expect(disabled.showExternalAccounts).toBe(false);
  });

  it('22 — carries no QuickBooks requirement', () => {
    expect(visibleText(disabled)).not.toMatch(QUICKBOOKS_WORDS);
  });

  it('is distinct from LOCAL, which is the whole reason they are separate classes', () => {
    const local = presentationFor('LOCAL');
    expect(disabled.showStockControls).not.toBe(local.showStockControls);
    expect(disabled.label).not.toBe(local.label);
  });

  it('describes a catalogue save', () => {
    expect(disabled.saveMessage).toBe('Saved to the catalogue.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — EXTERNAL fails safe
// ─────────────────────────────────────────────────────────────────────────────

describe('6 — EXTERNAL fails safely and falls back to nothing', () => {
  const external = presentationFor('EXTERNAL');

  it('shows the generic configuration warning', () => {
    expect(external.managementMode).toBe('UNSUPPORTED');
    expect(external.warning).toBe('External inventory provider is not configured.');
    expect(external.helpText).toBe('External inventory provider is not configured.');
  });

  it('does not fall back to the QuickBooks presentation', () => {
    const qb = presentationFor('QUICKBOOKS');
    expect(external.showSyncActions).toBe(false);
    expect(external.showRefreshAction).toBe(false);
    expect(external.showSyncStatus).toBe(false);
    expect(external.showExternalAccounts).toBe(false);
    expect(external.managementMode).not.toBe(qb.managementMode);
  });

  it('does not fall back to the LOCAL presentation either', () => {
    const local = presentationFor('LOCAL');
    expect(external.managementMode).not.toBe(local.managementMode);
    expect(external.showStockControls).toBe(false);
    expect(external.label).not.toBe(local.label);
  });

  it('claims no source and no stock', () => {
    expect(external.sourceLabel).toBeNull();
    expect(external.sourceDetailLabel).toBeNull();
    expect(external.stockTrackingNote).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7, 8 — the unresolved profile
// ─────────────────────────────────────────────────────────────────────────────

describe('7/8 — an unresolved profile offers nothing external', () => {
  const unresolved = presentationFor(null);

  it('is its own state, not a silent legacy default', () => {
    expect(unresolved.managementMode).toBe('UNRESOLVED');
    expect(unresolved.managementMode).not.toBe(presentationFor('QUICKBOOKS').managementMode);
  });

  it('exposes no QuickBooks action, status or account panel', () => {
    expect(unresolved.showSyncActions).toBe(false);
    expect(unresolved.showRefreshAction).toBe(false);
    expect(unresolved.showSyncStatus).toBe(false);
    expect(unresolved.showExternalAccounts).toBe(false);
  });

  it('claims nothing about stock it cannot know', () => {
    expect(unresolved.showStockControls).toBe(false);
    expect(unresolved.stockTrackingNote).toBeNull();
    expect(unresolved.sourceLabel).toBeNull();
  });

  it('mentions no provider by name in any visible string', () => {
    expect(visibleText(unresolved)).not.toMatch(QUICKBOOKS_WORDS);
  });

  it('a stale quickbooksItemId cannot promote it to the QuickBooks presentation', () => {
    // The single most likely inference bug, asserted directly.
    expect(presentationFor(null, { quickbooksItemId: 'qb-1' }).showSyncActions).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 40, 41 — mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('40/41 — the boundaries these tests guard can actually fail', () => {
  /**
   * A tripwire that cannot fail is not a tripwire. Each proof takes the real
   * presentation, applies the regression the suite is meant to catch, and asserts
   * the guarding expectation flips — so the green above is evidence, not luck.
   */

  it('40 — the QuickBooks-action boundary: a LOCAL tenant gaining sync would fail', () => {
    const real = presentationFor('LOCAL');
    expect(real.showSyncActions).toBe(false);

    const regressed: ProductPresentation = { ...real, showSyncActions: true };
    expect(regressed).not.toEqual(real);
    expect(() => expect(regressed.showSyncActions).toBe(false)).toThrow();
  });

  it('40 — and a QUICKBOOKS tenant losing sync would fail too', () => {
    const real = presentationFor('QUICKBOOKS');
    expect(real.showSyncActions).toBe(true);

    const regressed: ProductPresentation = { ...real, showSyncActions: false };
    expect(() => expect(regressed.showSyncActions).toBe(true)).toThrow();
  });

  it('40 — the "no QuickBooks wording" assertion is not passing on a broken pattern', () => {
    const real = presentationFor('LOCAL');
    expect(visibleText(real)).not.toMatch(QUICKBOOKS_WORDS);

    const regressed: ProductPresentation = { ...real, label: 'Not synced to QuickBooks' };
    expect(visibleText(regressed)).toMatch(QUICKBOOKS_WORDS);
  });

  it('41 — the profile-loading safe default: defaulting to QuickBooks would fail', () => {
    const real = presentationFor(null);
    expect(real.showSyncActions).toBe(false);
    expect(real.managementMode).toBe('UNRESOLVED');

    // The exact regression: treating "unknown" as the legacy default.
    const legacyDefaulted = presentationFor('QUICKBOOKS');
    expect(legacyDefaulted).not.toEqual(real);
    expect(() => expect(legacyDefaulted.showSyncActions).toBe(false)).toThrow();
    expect(() => expect(legacyDefaulted.managementMode).toBe('UNRESOLVED')).toThrow();
  });

  it('41 — and the unresolved state is reachable, not dead code', () => {
    // A guard that no input can ever produce protects nothing.
    expect(presentationFor(null).managementMode).toBe('UNRESOLVED');
  });
});
