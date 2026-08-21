import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sheet } from './sheet';

/**
 * Sheet is the tablet-responsive primitive underneath modifier pickers,
 * payment popups, and wizard preview overlays. Every assertion here pairs
 * a positive with a negative so a component regressing to a `<Dialog>`-like
 * (no handle, no safe-area footer, no scroll body) shape fails visibly.
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

  it('renders a grab-handle so operators see it as a sheet, not a modal', () => {
    // POSITIVE — the handle DOM is present.
    const { container } = render(
      <Sheet open onClose={() => {}} title="Any">
        body
      </Sheet>,
    );
    // The handle is a decorative aria-hidden strip; find via its class.
    const handle = container.querySelector('[aria-hidden="true"] > span.rounded-full');
    expect(handle).not.toBeNull();
    // NEGATIVE — the handle is not a keyboard target (a11y noise if it were).
    expect(handle?.getAttribute('tabindex')).toBeNull();
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

  it('footer receives safe-area padding so iOS home indicator does not eat the primary action', () => {
    const { container } = render(
      <Sheet open onClose={() => {}} title="A" footer={<button>Pay</button>}>
        body
      </Sheet>,
    );
    // The footer wrapper must carry `pb-safe`. A regression to a plain `pb-3`
    // would look correct on jsdom but eat the Pay button on iOS Safari with
    // viewport-fit: cover.
    const footerWrapper = container.querySelector('.pb-safe');
    expect(footerWrapper).not.toBeNull();
    expect(footerWrapper?.textContent).toContain('Pay');
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
