import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sheet } from './sheet';

/**
 * Sheet is the wide popup primitive underneath modifier pickers, payment
 * popups, the dine-in bill and wizard preview overlays. Every assertion here
 * pairs a positive with a negative, so a regression fails visibly rather than
 * passing because a string happens to be absent from both shapes.
 *
 * ## The bottom anchor is gone (PO, 2026-09-09)
 *
 * This file used to assert the OPPOSITE of what it now asserts on two points,
 * and both were true when written: the panel carried a grab handle so it read
 * as a sheet rather than a modal, and its footer carried `pb-safe` so the iOS
 * home indicator could not eat the primary action.
 *
 * Both were consequences of the panel touching the bottom edge of the screen.
 * The product owner's rule is that a popup belongs in the middle of the
 * screen, reported against the dine-in bill filling the window top to bottom.
 * A centred panel reaches no home indicator and affords no pull gesture, so
 * neither claim survives. They are REWRITTEN to assert the new truth, not
 * deleted — the point of each was that the shape is deliberate, and it still
 * is; it is a different shape.
 *
 * ## Mutation proof (D30)
 *
 * Four mutants of sheet.tsx, run against this spec and reverted. All killed:
 *
 *   1. `items-center` back to `items-end` ........... 1 test fails
 *   2. `rounded-2xl` back to `rounded-t-2xl` ........ 1 test fails
 *   3. the grab handle restored ..................... 1 test fails
 *   4. `pb-safe` restored on the footer ............. 1 test fails
 *   5. `p-4` dropped from the overlay ............... 1 test fails
 */

describe('Sheet', () => {
  afterEach(() => {
    // React 18 + vitest do not auto-unmount between tests — a previous open
    // Sheet leaves its overlay in the DOM and `getByRole` finds two Close
    // buttons. `cleanup()` unmounts every render, which also runs the
    // Sheet's body-overflow-restore effect for us.
    cleanup();
    document.body.style.overflow = '';
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <Sheet open={false} onClose={() => {}}>
        body
      </Sheet>,
    );
    expect(container.firstChild).toBeNull();
    // Body should NOT have been locked by an unmounted-but-open sheet.
    expect(document.body.style.overflow).toBe('');
  });

  it('renders title, description, close X, body, and footer when open', () => {
    render(
      <Sheet
        open
        onClose={() => {}}
        title="Modifier picker"
        description="Choose your options"
        footer={<button>Add to cart</button>}
      >
        <p>modifier list</p>
      </Sheet>,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Modifier picker' })).toBeTruthy();
    expect(screen.getByText('Choose your options')).toBeTruthy();
    expect(screen.getByText('modifier list')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('carries no grab-handle, because there is no edge to pull it from', () => {
    const { container } = render(
      <Sheet open onClose={() => {}} title="Any">
        body
      </Sheet>,
    );
    /*
     * The inverse of what this test used to assert. The handle was the cue
     * that the panel could be dragged up from the bottom of the screen; on a
     * card floating in the middle it advertises a gesture that does not
     * exist. Queried the same way the old positive was, so the two are
     * genuinely opposite claims about the same DOM.
     */
    expect(container.querySelector('[aria-hidden="true"] > span.rounded-full')).toBeNull();
    // POSITIVE CONTROL — the panel really did render, so the null above is
    // about the handle and not about an empty container.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Any' })).toBeTruthy();
  });

  it('is CENTRED on both axes, at every width', () => {
    render(
      <Sheet open onClose={() => {}} title="Any">
        body
      </Sheet>,
    );
    const overlay = screen.getByRole('dialog').parentElement!;

    expect(overlay.className).toContain('items-center');
    expect(overlay.className).toContain('justify-center');
    /*
     * The regression this exists for, named. `items-end` is what put the
     * dine-in bill against the bottom of the window with the scrim only
     * above it — and it would satisfy a check for "justify-center" all the
     * same, because that is the other axis.
     */
    for (const pinned of ['items-end', 'items-start', 'items-baseline']) {
      expect(overlay.className).not.toMatch(new RegExp(`(^|\\s)${pinned}(\\s|$)`));
      // …and behind any breakpoint prefix, which is how it was written before.
      expect(overlay.className).not.toMatch(new RegExp(`(^|\\s)[a-z-]+:${pinned}(\\s|$)`));
    }
    // Padding so a tall panel clears both screen edges instead of touching them.
    expect(overlay.className).toMatch(/(^|\s)p-4(\s|$)/);
  });

  it('is rounded on all four corners, now that all four are on screen', () => {
    render(
      <Sheet open onClose={() => {}} title="Any">
        body
      </Sheet>,
    );
    const panel = screen.getByRole('dialog');

    expect(panel.className).toMatch(/(^|\s)rounded-2xl(\s|$)/);
    // `rounded-t-2xl` was correct only while the bottom two corners were
    // below the fold. On a floating card it leaves two square corners.
    expect(panel.className).not.toContain('rounded-t-2xl');
  });

  it('closes on Escape regardless of dismissible=false', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} dismissible={false} title="Locked">
        body
      </Sheet>,
    );
    // Close X is suppressed when dismissible=false.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    // But Escape must still work — a keyboard-only operator must not be trapped.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on overlay click when dismissible (default)', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Any">
        body
      </Sheet>,
    );
    // The overlay is the presentation role wrapping the dialog.
    fireEvent.click(document.querySelector('.fixed.inset-0')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT close on overlay click when dismissible=false', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} dismissible={false} title="Forced decision">
        body
      </Sheet>,
    );
    fireEvent.click(document.querySelector('.fixed.inset-0')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT close when the click starts inside the panel (drag out onto overlay)', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Any">
        <p>panel content</p>
      </Sheet>,
    );
    // Clicks inside the panel must not bubble to the overlay dismiss.
    fireEvent.click(screen.getByText('panel content'));
    expect(onClose).not.toHaveBeenCalled();
  });

  /*
   * D85 — every popup surface tops out at 80dvh, sheets included, so one
   * rule holds across the app instead of each control having its own idea of
   * "tall". `auto` was 85dvh and `full` claimed the viewport minus a 3rem
   * strip; both are now bounded by the same ceiling.
   */
  it('applies the correct height class per `height` prop', () => {
    const { rerender, container } = render(
      <Sheet open onClose={() => {}} title="A" height="auto">
        x
      </Sheet>,
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.className).toMatch(/max-h-\[80dvh\]/);

    rerender(
      <Sheet open onClose={() => {}} title="A" height="half">
        x
      </Sheet>,
    );
    expect(container.querySelector('[role="dialog"]')?.className).toMatch(/h-\[60dvh\]/);

    rerender(
      <Sheet open onClose={() => {}} title="A" height="full">
        x
      </Sheet>,
    );
    expect(container.querySelector('[role="dialog"]')?.className).toMatch(/h-\[80dvh\]/);
    // NEGATIVE — and nothing reaches for the viewport any more.
    expect(container.querySelector('[role="dialog"]')?.className).not.toContain('100dvh');
  });

  it('footer takes no safe-area inset, because it no longer reaches the screen edge', () => {
    const { container } = render(
      <Sheet open onClose={() => {}} title="A" footer={<button>Pay</button>}>
        body
      </Sheet>,
    );
    /*
     * Also the inverse of what it used to assert, and for the same reason.
     * `pb-safe` resolves to `env(safe-area-inset-bottom)`, which on iOS is
     * non-zero wherever the element sits — so on a centred panel it added
     * stray padding under the actions while protecting nothing.
     *
     * POSITIVE first: the footer exists, is pinned, and holds the action.
     */
    const footer = screen.getByRole('button', { name: 'Pay' }).parentElement!;
    expect(footer.className).toContain('shrink-0');
    expect(footer.className).toContain('border-t');
    expect(footer.textContent).toContain('Pay');
    // NEGATIVE — and the inset is gone from the whole panel, not just moved.
    expect(container.querySelector('.pb-safe')).toBeNull();
  });

  it('locks body scroll while open and restores it on close', () => {
    // Positive control: body starts unlocked.
    expect(document.body.style.overflow).toBe('');
    const { unmount } = render(
      <Sheet open onClose={() => {}} title="A">
        body
      </Sheet>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('body region is a scroll container so long content does not push the footer off-screen', () => {
    const { container } = render(
      <Sheet open onClose={() => {}} title="Long" footer={<button>Save</button>}>
        <p>body</p>
      </Sheet>,
    );
    // The min-h-0 + flex-1 + overflow-y-auto trio is what keeps the footer
    // sticky when content overflows. Regressing any one of them breaks the
    // pattern silently on a device that can actually scroll.
    const scroller = container.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toMatch(/min-h-0/);
    expect(scroller?.className).toMatch(/flex-1/);
  });
});
