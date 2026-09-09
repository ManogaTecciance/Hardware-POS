/**
 * The app's own confirm and prompt (D141) — the primitive every converted call
 * site now depends on.
 *
 * Nine guards moved onto this hook in one change. Each of them reads
 * `if (!(await confirm(…))) return;` or `if (raw == null) return;`, which means
 * a single mistake HERE is a mistake at all nine at once — and the two ways it
 * would fail are both silent:
 *
 *   • Resolving the wrong value. `confirm` answering true on Cancel deletes the
 *     thing the person just declined to delete. `prompt` answering `''` where
 *     `window.prompt` answered `null` turns "I changed my mind" into "clear the
 *     field", which is exactly the distinction the wizard's reorder-point guard
 *     is built on (`raw == null`, deliberately not `!raw`).
 *   • Resolving NOTHING. A promise nobody settles is an `await` that never
 *     returns: the handler behind it simply stops, with no error, no dialog and
 *     nothing on screen. Every outcome below is therefore asserted through
 *     `outcome()`, which races the promise against a timer — so "never
 *     answered" fails as itself rather than as a five-second timeout.
 *
 * The three paths that can leave a promise hanging each get their own test:
 * unmount, a second question arriving over the first, and dismissal.
 *
 * ## Mutation proof (D30)
 *
 * Seven mutants of `confirm.tsx`, each run against this spec in a scratch copy
 * and then reverted. All seven were killed:
 *
 *   1. Cancel resolves `true` ....................... 5 tests fail
 *   2. prompt dismissal resolves `''`, not `null` ... 5 tests fail
 *   3. the unmount effect stops settling ............ 1 test fails
 *   4. a second question DROPS the first ............ 3 tests fail
 *   5. `tone: 'danger'` no longer focuses Cancel .... 1 test fails
 *   6. the field is not reset between questions ..... 1 test fails
 *   7. the hook falls back to a stub instead of
 *      throwing without its provider ................ 1 test fails
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider, useConfirm, usePrompt, type ConfirmOptions } from './confirm';
import type { PromptOptions } from './confirm';

afterEach(cleanup);

let ask: {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
} | null = null;

function Capture() {
  ask = { confirm: useConfirm(), prompt: usePrompt() };
  return <p>the screen behind the question</p>;
}

function mount() {
  const view = render(
    <ConfirmProvider>
      <Capture />
    </ConfirmProvider>,
  );
  return view;
}

/**
 * The value a request settled on, or the PENDING marker if it never settled.
 *
 * `await expect(p).resolves.toBe(false)` cannot tell "answered false" from
 * "still waiting" except by timing out, and a timeout reads as a slow test
 * rather than as the bug. This says which happened.
 */
const PENDING = 'NEVER SETTLED';
function outcome<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 60)),
  ]);
}

/** Open a question and hand back its promise, with React settled around it. */
function open<T>(request: () => Promise<T>): Promise<T> {
  let promise!: Promise<T>;
  act(() => {
    promise = request();
  });
  return promise;
}

const button = (name: string) => screen.getByRole('button', { name });

describe('confirm — what each way out answers', () => {
  it('answers true only when the confirm action is pressed', async () => {
    mount();
    const answer = open(() => ask!.confirm({ title: 'Void this ticket?' }));

    // The question is on screen before anything is answered — a guard that
    // resolved immediately would never show it.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Void this ticket?' })).toBeTruthy();

    fireEvent.click(button('Confirm'));

    expect(await outcome(answer)).toBe(true);
    // …and the question goes away by itself; nothing at the call site closes it.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('answers false on Cancel, on Escape and on the overlay', async () => {
    for (const dismiss of [
      () => fireEvent.click(button('Cancel')),
      () => fireEvent.keyDown(window, { key: 'Escape' }),
      () => fireEvent.click(screen.getByRole('dialog').parentElement!),
      () => fireEvent.click(button('Close')),
    ]) {
      cleanup();
      mount();
      const answer = open(() => ask!.confirm({ title: 'Void this ticket?' }));

      dismiss();

      // false, not PENDING and not null: every call site spells this
      // `if (!(await confirm(…))) return;`, so a hang stops the handler dead.
      expect(await outcome(answer)).toBe(false);
    }
  });

  it('NEGATIVE — nothing is answered while the question is still open', async () => {
    mount();
    const answer = open(() => ask!.confirm({ title: 'Void this ticket?' }));

    /*
     * The control for every test above. If the promise settled on open, each
     * of them would pass for the wrong reason — the click would be incidental
     * and a dialog that answered "yes" to everything would look correct.
     */
    expect(await outcome(answer)).toBe(PENDING);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('prompt — a value, or the absence of one', () => {
  it('answers with what was typed', async () => {
    mount();
    const answer = open(() => ask!.prompt({ title: 'Generate SKUs', label: 'SKU prefix' }));

    fireEvent.change(screen.getByLabelText('SKU prefix'), { target: { value: 'COKE' } });
    fireEvent.click(button('Save'));

    expect(await outcome(answer)).toBe('COKE');
  });

  it('answers with an empty string when the box is empty — NOT null', async () => {
    mount();
    const answer = open(() =>
      ask!.prompt({ title: 'Reorder point', label: 'Reorder point', defaultValue: '12' }),
    );

    fireEvent.change(screen.getByLabelText('Reorder point'), { target: { value: '' } });
    fireEvent.click(button('Save'));

    /*
     * The distinction the wizard's bulk action is built on: blank means
     * "clear the reorder point on every row", dismissal means "leave them".
     * Collapsing the two — resolving null here — silently turns a deliberate
     * clear into a no-op, and `!raw` at the call site would hide it.
     */
    expect(await outcome(answer)).toBe('');
  });

  it('answers null when dismissed, whichever way', async () => {
    for (const dismiss of [
      () => fireEvent.click(button('Cancel')),
      () => fireEvent.keyDown(window, { key: 'Escape' }),
      () => fireEvent.click(screen.getByRole('dialog').parentElement!),
    ]) {
      cleanup();
      mount();
      const answer = open(() => ask!.prompt({ title: 'Generate SKUs', label: 'SKU prefix' }));
      fireEvent.change(screen.getByLabelText('SKU prefix'), { target: { value: 'TYPED' } });

      dismiss();

      // null, exactly as `window.prompt` answered — and specifically not the
      // text that was typed before the person changed their mind.
      expect(await outcome(answer)).toBeNull();
    }
  });

  it('seeds the field with the default, and does not carry it to the next question', async () => {
    mount();
    const first = open(() =>
      ask!.prompt({ title: 'Reorder point', label: 'Reorder point', defaultValue: '12' }),
    );
    expect((screen.getByLabelText('Reorder point') as HTMLInputElement).value).toBe('12');
    fireEvent.click(button('Cancel'));
    expect(await outcome(first)).toBeNull();

    const second = open(() => ask!.prompt({ title: 'Generate SKUs', label: 'SKU prefix' }));

    // NEGATIVE — a leftover '12' would be pre-typed into an unrelated question
    // and saved by anyone who pressed the action without reading the box.
    expect((screen.getByLabelText('SKU prefix') as HTMLInputElement).value).toBe('');
    fireEvent.click(button('Cancel'));
    expect(await outcome(second)).toBeNull();
  });

  it('submits on Enter, as a native prompt does', async () => {
    mount();
    const answer = open(() => ask!.prompt({ title: 'Generate SKUs', label: 'SKU prefix' }));

    const field = screen.getByLabelText('SKU prefix');
    fireEvent.change(field, { target: { value: 'MILK' } });
    // The field sits in a form whose submit is the same `settle` the action
    // button calls; without it, Enter reloads nothing and the person types
    // again.
    fireEvent.submit(field.closest('form')!);

    expect(await outcome(answer)).toBe('MILK');
  });

  it('shows no text field for a yes/no question', async () => {
    mount();
    const answer = open(() => ask!.confirm({ title: 'Void this ticket?' }));

    // POSITIVE CONTROL for the queries above: they find a field only because
    // a prompt renders one, and a confirm does not.
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(button('Cancel'));
    expect(await outcome(answer)).toBe(false);
  });
});

describe('the wording and focus a question opens with', () => {
  it('uses the given labels, and sensible defaults otherwise', async () => {
    mount();
    const custom = open(() =>
      ask!.confirm({
        title: 'Discard basket #4?',
        message: 'The items go back on the shelf.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep it',
      }),
    );

    expect(button('Discard')).toBeTruthy();
    expect(button('Keep it')).toBeTruthy();
    expect(screen.getByText('The items go back on the shelf.')).toBeTruthy();
    fireEvent.click(button('Keep it'));
    expect(await outcome(custom)).toBe(false);

    // Defaults differ by kind: a yes/no question confirms, a prompt saves.
    const plain = open(() => ask!.confirm({ title: 'Sure?' }));
    expect(button('Confirm')).toBeTruthy();
    fireEvent.click(button('Cancel'));
    expect(await outcome(plain)).toBe(false);

    const typed = open(() => ask!.prompt({ title: 'Name?', label: 'Name' }));
    expect(button('Save')).toBeTruthy();
    fireEvent.click(button('Cancel'));
    expect(await outcome(typed)).toBeNull();
  });

  it('a destructive question opens with Cancel focused and the action in red', async () => {
    mount();
    const answer = open(() =>
      ask!.confirm({ title: 'Reset to defaults?', confirmLabel: 'Reset', tone: 'danger' }),
    );

    /*
     * Native `confirm` focuses OK. On a wall-mounted tablet, halfway through a
     * sentence, a stray Enter then destroyed the thing. The destructive tone
     * inverts that: the safe answer is the one under the cursor.
     */
    expect(document.activeElement).toBe(button('Cancel'));
    expect(button('Reset').className).toContain('bg-danger');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await outcome(answer)).toBe(false);
  });

  it('NEGATIVE — a neutral question keeps the native focus, on the action', async () => {
    mount();
    const answer = open(() => ask!.confirm({ title: 'Clear the cart?' }));

    // Both directions, because "danger focuses Cancel" would also pass for a
    // component that focused Cancel always — losing the fast path on every
    // ordinary question.
    expect(document.activeElement).toBe(button('Confirm'));
    expect(button('Confirm').className).not.toContain('bg-danger');

    fireEvent.click(button('Confirm'));
    expect(await outcome(answer)).toBe(true);
  });

  it('a prompt focuses the FIELD, not either button', async () => {
    mount();
    const answer = open(() => ask!.prompt({ title: 'Generate SKUs', label: 'SKU prefix' }));

    // Otherwise the person has to reach for the box before they can type,
    // which a native prompt never made them do.
    expect(document.activeElement).toBe(screen.getByLabelText('SKU prefix'));

    fireEvent.click(button('Cancel'));
    expect(await outcome(answer)).toBeNull();
  });
});

describe('nothing is ever left waiting', () => {
  it('answers an open question when the screen unmounts', async () => {
    const view = mount();
    const answer = open(() => ask!.confirm({ title: 'Void this ticket?' }));
    const typed = open(() => ask!.prompt({ title: 'Name?', label: 'Name' }));

    act(() => view.unmount());

    /*
     * A route change with a question open. Without the unmount handler both
     * promises stay pending forever and the handlers behind them stop
     * mid-flight — no error, no dialog, and a person watching a button that
     * did nothing.
     */
    expect(await outcome(answer)).toBe(false);
    expect(await outcome(typed)).toBeNull();
  });

  it('a second question answers the first rather than dropping it', async () => {
    mount();
    const first = open(() => ask!.confirm({ title: 'First question' }));

    const second = open(() => ask!.confirm({ title: 'Second question' }));

    /*
     * Two questions at once is a bug at the CALL SITE — natively it could not
     * happen at all. What must not follow from it is a hang: the first is
     * answered "no", which is the safe reading of a question nobody saw.
     */
    expect(await outcome(first)).toBe(false);
    expect(screen.getByRole('heading', { name: 'Second question' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'First question' })).toBeNull();

    fireEvent.click(button('Confirm'));
    expect(await outcome(second)).toBe(true);
  });

  it('a prompt cancelled by a second question answers null, not false', async () => {
    mount();
    const first = open(() => ask!.prompt({ title: 'First question', label: 'Name' }));
    const second = open(() => ask!.confirm({ title: 'Second question' }));

    // The two kinds settle differently even on the same path — a shared
    // `resolve(false)` would hand a boolean to code expecting a string|null.
    expect(await outcome(first)).toBeNull();
    fireEvent.click(button('Cancel'));
    expect(await outcome(second)).toBe(false);
  });
});

describe('a screen that forgot the provider', () => {
  it('throws, rather than quietly falling back to the browser', () => {
    /*
     * The whole point of D141 is that no screen asks the BROWSER a question.
     * A fallback to `window.confirm` would keep such a screen working — badly,
     * blocking the main thread, unstyled, suppressible by Chrome — and nobody
     * would find out. Failing loudly means it is found the first time the
     * screen renders.
     */
    const noise = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Capture />)).toThrow(/ConfirmProvider/);
    } finally {
      noise.mockRestore();
    }
  });

  it('POSITIVE CONTROL — the same component renders fine inside it', () => {
    mount();
    expect(screen.getByText('the screen behind the question')).toBeTruthy();
    expect(ask).not.toBeNull();
  });
});
