'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The app's own confirm and prompt (D141), replacing `window.confirm` and
 * `window.prompt`.
 *
 * The native dialogs had to go for reasons that are not cosmetic. They are
 * drawn by the BROWSER, so they carry the app's neither theme nor its wording,
 * they cannot be styled or made touch-sized on the tablets the POS runs on,
 * Chrome suppresses them outright after a few in a row and in a cross-origin
 * frame, and they BLOCK the main thread — the kitchen board's five-second poll
 * and the cart's midnight rollover both stall behind one open confirm.
 *
 * They are promise-based on purpose. Every call site reads exactly as it did:
 *
 *     if (!(await confirm({ title: 'Discard this basket?' }))) return;
 *
 * so converting nine of them could not quietly change what any of them guarded.
 * Local dialog state at each site would have meant splitting nine handlers into
 * an opener and a callback, which is nine chances to drop a branch.
 *
 * Mounted once, in the authenticated shell. `useConfirm` outside the provider
 * throws rather than falling back to `window.confirm`: a silent fallback would
 * reintroduce exactly what this replaces, on whichever screen forgot it.
 */

export interface ConfirmOptions {
  title: string;
  /** The consequence, in a sentence. Native `confirm` had one string; this is it. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirm red and focuses CANCEL instead — see below. */
  tone?: 'default' | 'danger';
}

export interface PromptOptions extends ConfirmOptions {
  /** The field's label. Always visible: a placeholder is not a label. */
  label: string;
  defaultValue?: string;
  placeholder?: string;
  inputMode?: 'text' | 'numeric' | 'decimal';
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

interface ConfirmApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const ConfirmContext = React.createContext<ConfirmApi | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [value, setValue] = React.useState('');

  /*
   * The resolver lives in a ref as well as in state so that unmounting, or a
   * second request arriving, can still settle the first promise. A promise
   * nobody resolves is an `await` that never returns — the handler behind it
   * would simply stop, with no error and nothing on screen.
   */
  const openRef = React.useRef<Pending | null>(null);

  const settle = React.useCallback((outcome: boolean | string | null) => {
    const open = openRef.current;
    openRef.current = null;
    setPending(null);
    setValue('');
    if (!open) return;
    if (open.kind === 'confirm') open.resolve(outcome === true);
    else open.resolve(typeof outcome === 'string' ? outcome : null);
  }, []);

  const start = React.useCallback((next: Pending, initial: string) => {
    // A request arriving while one is open cancels the first, the way a second
    // native dialog could never happen at all. Overlap is a bug at the call
    // site; resolving rather than dropping keeps it from hanging.
    const previous = openRef.current;
    if (previous) {
      if (previous.kind === 'confirm') previous.resolve(false);
      else previous.resolve(null);
    }
    openRef.current = next;
    setPending(next);
    setValue(initial);
  }, []);

  const api = React.useMemo<ConfirmApi>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) => start({ kind: 'confirm', options, resolve }, '')),
      prompt: (options) =>
        new Promise<string | null>((resolve) =>
          start({ kind: 'prompt', options, resolve }, options.defaultValue ?? ''),
        ),
    }),
    [start],
  );

  // Unmounting with a question open answers it as cancelled, for the same
  // reason: nothing downstream may be left waiting forever.
  React.useEffect(() => () => settle(null), [settle]);

  const options = pending?.options;
  const danger = options?.tone === 'danger';
  const isPrompt = pending?.kind === 'prompt';

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {pending && options ? (
        <Dialog
          open
          // Escape and the overlay mean "no", exactly as they do natively.
          onClose={() => settle(isPrompt ? null : false)}
          title={options.title}
          description={options.message}
          footer={
            <>
              <Button
                variant="outline"
                onClick={() => settle(isPrompt ? null : false)}
                /*
                 * A destructive question opens with CANCEL focused. Native
                 * `confirm` focuses OK, so a stray Enter on a tablet already
                 * halfway through a sentence deleted the thing. The neutral
                 * case keeps the native behaviour.
                 */
                autoFocus={danger}
              >
                {options.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                variant={danger ? 'danger' : undefined}
                onClick={() => settle(isPrompt ? value : true)}
                autoFocus={!danger && !isPrompt}
              >
                {options.confirmLabel ?? (isPrompt ? 'Save' : 'Confirm')}
              </Button>
            </>
          }
        >
          {isPrompt ? (
            <form
              // Enter submits, as it does in a native prompt.
              onSubmit={(event) => {
                event.preventDefault();
                settle(value);
              }}
              className="space-y-1.5"
            >
              <Label htmlFor="confirm-prompt-value">{(options as PromptOptions).label}</Label>
              <Input
                id="confirm-prompt-value"
                autoFocus
                value={value}
                inputMode={(options as PromptOptions).inputMode}
                placeholder={(options as PromptOptions).placeholder}
                onChange={(event) => setValue(event.target.value)}
              />
            </form>
          ) : null}
        </Dialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

function useConfirmApi(hook: string): ConfirmApi {
  const api = React.useContext(ConfirmContext);
  if (!api) {
    throw new Error(
      `${hook} needs <ConfirmProvider>. It is mounted in the authenticated shell; ` +
        'a screen outside it must wrap itself rather than fall back to window.confirm.',
    );
  }
  return api;
}

/** Ask a yes/no question. Resolves false on Cancel, Escape or the overlay. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useConfirmApi('useConfirm').confirm;
}

/** Ask for a value. Resolves `null` when dismissed, like `window.prompt`. */
export function usePrompt(): (options: PromptOptions) => Promise<string | null> {
  return useConfirmApi('usePrompt').prompt;
}
