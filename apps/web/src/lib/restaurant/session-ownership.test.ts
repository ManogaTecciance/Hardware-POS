/**
 * D151 — the my-tables / all-tables resolver.
 *
 * Two screens read it (the floor plan and the POS picker) and the failures it
 * prevents are both silent: a default that ignored the operator's choice would
 * snap a waiter back to their own tables on the next 8 s poll while they were
 * reading a colleague's order, and a default that never fired would open a
 * cashier — who owns no sessions — on an empty screen that looks exactly like a
 * branch with nobody in it.
 */
import { describe, expect, it } from 'vitest';

import type { OpenSessionView } from './types';
import {
  countAll,
  countMine,
  isMySession,
  otherWaiterLabel,
  resolveOwnerScope,
  sessionsVisibleTo,
} from './session-ownership';

const ME = 'usr_me';

const session = (
  id: string,
  tableId: string,
  waiterUserId: string | null,
  waiterName: string | null = 'Nimal',
): OpenSessionView =>
  ({
    id,
    tableId,
    waiterUserId,
    waiterName,
    sessionNumber: `TS-${id}`,
    status: 'OPEN',
    openedAt: '2026-09-10T10:00:00.000Z',
    readyTicketIds: [],
    activeOrderId: null,
    tabName: null,
  }) as unknown as OpenSessionView;

/** Two of mine on one table each, one of someone else's, two tabs on an arrangement. */
const byTable = new Map<string, OpenSessionView[]>([
  ['tbl_1', [session('a', 'tbl_1', ME, 'Me')]],
  ['tbl_2', [session('b', 'tbl_2', 'usr_other', 'Sunil')]],
  ['tbl_open', [session('c', 'tbl_open', ME, 'Me'), session('d', 'tbl_open', 'usr_other', 'Sunil')]],
]);

describe('resolveOwnerScope', () => {
  it('D152b — defaults to mine, and takes NO input that could move it', () => {
    /*
     * The two flickers this closes, in order: the default used to be computed
     * from `mineCount`, which is zero before the first response — so a screen
     * opened on ALL and snapped to mine (D152a), and once that was fixed by
     * distinguishing "not counted yet", the OTHER direction showed up for an
     * operator who genuinely owns none: mine, then automatically all
     * ("it's working backward"). A default that moves after the screen has
     * answered is worse than an empty list.
     *
     * The signature is the assertion: with nothing but the operator's choice
     * to read, there is no data that can move it.
     */
    expect(resolveOwnerScope(null)).toBe('mine');
    expect(resolveOwnerScope.length).toBe(1);
  });

  it('lets an explicit choice win, in both directions', () => {
    // The poll-stomping case: a waiter reading the floor must stay on the
    // floor, however many tables of their own they have.
    expect(resolveOwnerScope('all')).toBe('all');
    // And asking for your own sticks even with none — no silent re-widening.
    expect(resolveOwnerScope('mine')).toBe('mine');
  });
});

describe('sessionsVisibleTo', () => {
  it('keeps only my sessions under "mine", dropping a table that has none of them', () => {
    const visible = sessionsVisibleTo(byTable, 'mine', ME);
    expect([...visible.keys()].sort()).toEqual(['tbl_1', 'tbl_open']);
    // The arrangement keeps MY tab and loses the other party's — the D104 case
    // a per-table filter would have got wrong in either direction.
    expect(visible.get('tbl_open')!.map((s) => s.id)).toEqual(['c']);
    // NEGATIVE — the colleague's table is gone entirely, key and all, so
    // "is there a session here" stays one `.get()`.
    expect(visible.has('tbl_2')).toBe(false);
  });

  it('keeps everything under "all", including tables with none of mine', () => {
    const visible = sessionsVisibleTo(byTable, 'all', ME);
    expect([...visible.keys()].sort()).toEqual(['tbl_1', 'tbl_2', 'tbl_open']);
    expect(visible.get('tbl_open')!.map((s) => s.id)).toEqual(['c', 'd']);
  });

  it('does not mutate the map it was given', () => {
    // The caller holds the full snapshot and re-filters it on every poll; a
    // resolver that filtered in place would make the counts drift downwards.
    sessionsVisibleTo(byTable, 'mine', ME);
    expect(byTable.get('tbl_open')!).toHaveLength(2);
    expect(byTable.size).toBe(3);
  });
});

describe('counts', () => {
  it('counts sessions, not tables — an arrangement carries several', () => {
    expect(countMine(byTable, ME)).toBe(2);
    expect(countAll(byTable)).toBe(4);
    // A stranger owns none of them: the count is per caller, not a total in
    // disguise.
    expect(countMine(byTable, 'usr_nobody')).toBe(0);
  });
});

describe('whose table it is', () => {
  it('names a colleague and stays silent about me', () => {
    expect(otherWaiterLabel(session('x', 't', 'usr_other', 'Sunil'), ME)).toBe('Sunil');
    // Mine needs no label: putting my own name on my own cards buries the ones
    // that matter.
    expect(otherWaiterLabel(session('y', 't', ME, 'Me'), ME)).toBeNull();
  });

  it('says nothing rather than inventing a name', () => {
    // A session with no waiter recorded (seeded, or pre-D69) and one whose user
    // no longer resolves must not both render as "Unknown".
    expect(otherWaiterLabel(session('z', 't', 'usr_other', null), ME)).toBeNull();
    expect(otherWaiterLabel(session('w', 't', 'usr_other', '   '), ME)).toBeNull();
    expect(otherWaiterLabel(session('v', 't', null, null), ME)).toBeNull();
  });

  it('isMySession is an identity test, not a name test', () => {
    // Two waiters can share a first name; the id is what decides.
    expect(isMySession(session('n', 't', ME, 'Sunil'), ME)).toBe(true);
    expect(isMySession(session('n', 't', 'usr_other', 'Me'), ME)).toBe(false);
    expect(isMySession(session('n', 't', null), ME)).toBe(false);
  });
});
