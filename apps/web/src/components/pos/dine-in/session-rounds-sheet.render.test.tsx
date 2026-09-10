/**
 * D155 — "order so far": what the table already has, and the void.
 *
 * ## Why these claims
 *
 * This sheet carries the two capabilities the retired `/tables/session/[id]`
 * screen held and the POS did not: the kitchen's progress on each round, and
 * `ORDER_VOID_SENT`. Both fail silently if they are wrong —
 *
 *   - a sheet that rendered rounds without their status would look complete and
 *     answer the wrong question (the bill sheet already prices the order; what
 *     this adds is whether it is cooked), so the STATUS is asserted, per round
 *     and per item;
 *   - a void offered to every role looks identical to a correct gate until a
 *     waiter taps it and the server answers 403, so Void is asserted present
 *     WITH the permission and absent without it, on the same fixture;
 *   - a void that posted no reason would still close the dialog and reload, so
 *     the reason that reaches `voidItem` is asserted, and the guard that refuses
 *     an empty one with it.
 *
 * Mutation-proven, each mutation run against the component itself:
 *   1. `canVoid` ignored (Void rendered unconditionally) — 1 failed, 5 passed:
 *      the permission case, which is the only one that can catch it;
 *   2. the DRAFT skip removed from `flattenSubmittedRounds` — 3 failed, 3
 *      passed: the draft round joins the list, the reported count becomes 3,
 *      and its line offers a Void for something the kitchen has never seen;
 *   3. `onConfirm(reason.trim())` called with `''` — 1 failed, 5 passed: the
 *      posted reason is what the audit record is made of.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionDetail, SessionDetailItem } from '@/lib/restaurant/types';

const item = (
  id: string,
  name: string,
  status: SessionDetailItem['status'],
  extra: Partial<SessionDetailItem> = {},
): SessionDetailItem =>
  ({
    id,
    menuItemId: `p_${id}`,
    menuItemName: name,
    variantName: null,
    unitPrice: '500.00',
    modifierTotal: '0.00',
    quantity: '2',
    specialInstructions: null,
    status,
    modifiers: [],
    ...extra,
  }) as SessionDetailItem;

/**
 * Three rounds: one the kitchen has finished, one it is still cooking, and a
 * DRAFT that is an artefact of composition rather than something the table has.
 */
const DETAIL = {
  session: { id: 'ses_1', sessionNumber: 'TS-000042' },
  orders: [
    {
      order: { id: 'ord_1', orderNumber: 'ORD-7', status: 'OPEN' },
      rounds: [
        {
          round: { id: 'rnd_1', roundNumber: 1, status: 'READY' },
          items: [
            item('it_1', 'Rice and Curry', 'READY'),
            // A voided line STAYS on the list: the guest can see the bill, so
            // "it was taken off" is more useful than "it is not there".
            item('it_2', 'Fish Cutlet', 'VOIDED'),
          ],
        },
        {
          round: { id: 'rnd_2', roundNumber: 2, status: 'IN_PROGRESS' },
          items: [item('it_3', 'Kottu', 'IN_PROGRESS', { specialInstructions: 'no chilli' })],
        },
        {
          round: { id: 'rnd_3', roundNumber: 3, status: 'DRAFT' },
          items: [item('it_4', 'Ice Cream', 'PENDING')],
        },
      ],
    },
  ],
} as unknown as SessionDetail;

const getDetail = vi.fn<() => Promise<SessionDetail>>();
const voidItem = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('@/lib/restaurant/api', () => ({
  tableSessions: {
    getDetail: () => getDetail(),
    voidItem: (...args: unknown[]) => voidItem(...args),
  },
}));

const { SessionRoundsSheet } = await import('./session-rounds-sheet');

const session = { token: 't', user: { id: 'usr_1', tenantId: 'tnt' } } as never;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function mount(canVoid: boolean, onLoaded = vi.fn()) {
  render(
    <SessionRoundsSheet
      session={session}
      sessionId="ses_1"
      tableLabel="Table 1"
      canVoid={canVoid}
      onClose={vi.fn()}
      onLoaded={onLoaded}
    />,
  );
  return { onLoaded };
}

beforeEach(() => {
  getDetail.mockResolvedValue(DETAIL);
  voidItem.mockResolvedValue(undefined);
  // The sheet polls on an interval; `shouldAdvanceTime` keeps awaits working
  // while letting the poll be driven deliberately (the floor plan's specs do
  // the same, for the same poll).
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('the order so far (D155)', () => {
  it('lists the sent rounds newest first, with what the kitchen has done to each', async () => {
    mount(true);
    await settle();

    // POSITIVE — the round, its kitchen status, and the per-item status.
    expect(await screen.findByText('Round #2')).toBeTruthy();
    expect(screen.getByText('Round #1')).toBeTruthy();
    /*
     * TWICE each, and that is the point: the round carries the kitchen's
     * verdict on the whole ticket and every line carries its own, which is what
     * lets a waiter answer "the kottu is coming, the rice is at the pass".
     */
    expect(screen.getAllByText('Preparing')).toHaveLength(2); // round 2 + its item
    expect(screen.getAllByText('Ready')).toHaveLength(2); // round 1 + its live item
    // Newest first: the question is nearly always about the last round.
    expect(
      screen
        .getByText('Round #2')
        .compareDocumentPosition(screen.getByText('Round #1')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // D72 — the guest's note, on the line they will point at.
    expect(screen.getByText(/no chilli/)).toBeTruthy();
    // A voided line is shown, struck through, rather than dropped.
    expect(screen.getByText(/Fish Cutlet/)).toBeTruthy();
    expect(screen.getByText('Voided')).toBeTruthy();

    // NEGATIVE — the DRAFT round is not something the table has.
    expect(screen.queryByText('Round #3')).toBeNull();
    expect(screen.queryByText(/Ice Cream/)).toBeNull();
  });

  it('reports the sent-round count, so the strip behind it stops guessing', async () => {
    const { onLoaded } = mount(true);
    await settle();

    // Two, not three: the DRAFT round is excluded here exactly as it is above.
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(2));
  });

  it('offers Void on a live line, and never on one already voided', async () => {
    mount(true);
    await settle();
    await screen.findByText('Round #2');

    // Two live lines (Rice and Curry, Kottu); the voided one carries no verb.
    expect(screen.getAllByRole('button', { name: 'Void' })).toHaveLength(2);
  });

  it('NEGATIVE — a role without ORDER_VOID_SENT gets the list and no Void', async () => {
    mount(false);
    await settle();

    // The list is the same list: this is a gate on the verb, not on the read.
    expect(await screen.findByText('Round #2')).toBeTruthy();
    expect(screen.getByText(/Rice and Curry/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('posts the reason the void was given, and refuses to post without one', async () => {
    mount(true);
    await settle();
    await screen.findByText('Round #2');

    /*
     * Addressed through the LINE, not by position: the list is newest-first, so
     * the first Void on screen belongs to round 2 (the kottu). A positional tap
     * would void a different dish than the one asserted below and still pass.
     */
    const riceLine = screen.getByText(/Rice and Curry/).closest('li')!;
    fireEvent.click(within(riceLine).getByRole('button', { name: 'Void' }));
    expect(await screen.findByRole('heading', { name: /Void Rice and Curry\?/ })).toBeTruthy();

    // The guard: voids are audited, so an empty reason cannot be submitted.
    const confirmVoid = screen.getByRole('button', { name: 'Void item' });
    expect(confirmVoid.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirmVoid);
    expect(voidItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: '  guest changed mind  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Void item' }));

    // The item id and the TRIMMED reason — what the audit record is made of.
    await waitFor(() =>
      expect(voidItem).toHaveBeenCalledWith(session, 'it_1', { reason: 'guest changed mind' }),
    );
    // And the list is re-read, because the void changed what the table has.
    await waitFor(() => expect(getDetail.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('keeps the last good list when a refresh fails, and says so', async () => {
    mount(true);
    await settle();
    await screen.findByText('Round #2');

    getDetail.mockRejectedValueOnce(new Error('Network unreachable'));
    // The poll cadence is the floor's 8 s; driven here rather than waited out.
    await act(async () => {
      vi.advanceTimersByTime(8000);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(await screen.findByText(/Network unreachable/)).toBeTruthy();
    // NEGATIVE — blanking a waiter's order because one refresh timed out is the
    // worse of the two failures.
    expect(screen.getByText('Round #2')).toBeTruthy();
  });
});
