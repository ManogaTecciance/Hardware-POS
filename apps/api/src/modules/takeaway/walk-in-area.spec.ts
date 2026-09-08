import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { WALK_IN_AREA_NAME, WALK_IN_AREA_POSITION } from './takeaway.service';

/**
 * D92 — the synthetic walk-in area's name is shown to people.
 *
 * A `DiningArea` row's `name` IS its display name, so `__walk_in__` was never
 * only internal: it appeared verbatim as a chip in the waiter's table picker
 * and on the floor plan. The rename is asserted POSITIVELY (the constant is
 * the readable name, and the service uses the constant) as well as
 * negatively, because a spec that only checks a string is missing passes just
 * as happily when the whole feature has been deleted.
 */

const SOURCE = resolve(__dirname, 'takeaway.service.ts');

function source(): string {
  const text = readFileSync(SOURCE, 'utf8');
  // D30.7 — an analyser that inspected nothing must fail, not pass quietly.
  if (text.trim().length === 0) throw new Error(`${SOURCE} is empty`);
  if (!text.includes('ensureWalkInTable')) {
    throw new Error(`${SOURCE} no longer defines ensureWalkInTable — this spec is inspecting the wrong thing`);
  }
  return text;
}

/** Strip line and block comments: the old string is DISCUSSED in comments. */
function code(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('D92 — the walk-in area is named for a person to read', () => {
  it('the name is a readable one, and the position is the reserved slot', () => {
    expect(WALK_IN_AREA_NAME).toBe('Walk In');
    // Not merely "not the old string": asserted as the exact value, because
    // any placeholder would satisfy a `not.toBe('__walk_in__')`.
    expect(WALK_IN_AREA_POSITION).toBe(999);
    // 998 is the delivery hub's slot; colliding would put takeaway orders on
    // the delivery area.
    expect(WALK_IN_AREA_POSITION).not.toBe(998);
  });

  it('the service writes the constant, not a literal', () => {
    const text = code();
    expect(text).toContain('name: WALK_IN_AREA_NAME');
    expect(text).toContain('position: WALK_IN_AREA_POSITION');
    // NEGATIVE — the old magic string is gone from the CODE. Comments still
    // explain it, which is why they are stripped first; without that this
    // assertion would fail on the very comment that documents the fix.
    expect(text).not.toContain('__walk_in__');
    // The mutation this pairs with: the analyser must actually be reading the
    // service. If the comment-stripper ever swallowed the file, the negative
    // above would pass on an empty string.
    expect(text).toContain('ensureWalkInTable');
  });

  it('identifies the row by its reserved position, not by the display name', () => {
    /*
     * `@@unique([branchId, name])` — an owner who names a floor "Walk In"
     * would otherwise collide with the synthetic row and fail every takeaway
     * order on that branch. The position is the part that identifies it; the
     * name is a fallback for a row the rename migration had to skip.
     */
    const text = code();
    const lookup = text.slice(text.indexOf('ensureWalkInTable'));
    const byPosition = lookup.indexOf('position: WALK_IN_AREA_POSITION');
    const byName = lookup.indexOf('name: WALK_IN_AREA_NAME');
    expect(byPosition).toBeGreaterThan(-1);
    expect(byName).toBeGreaterThan(-1);
    // Position is consulted FIRST. Reversed, a branch with an operator's own
    // "Walk In" floor would hang takeaway tables off it in preference to the
    // synthetic row that already exists.
    expect(byPosition).toBeLessThan(byName);
  });

  it('the rename migration is guarded against the unique constraint', () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../../../../packages/database/prisma/migrations/20260905000000_rename_walk_in_area/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain(`SET name = 'Walk In'`);
    expect(sql).toContain(`a.name = '__walk_in__'`);
    // Without the guard a single branch that already has a "Walk In" floor
    // aborts the whole migration, and with it the deploy.
    expect(sql).toContain('NOT EXISTS');
  });
});
