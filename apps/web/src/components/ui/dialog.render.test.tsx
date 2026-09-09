/**
 * D85 — a modal never grows past the screen.
 *
 * ## What actually breaks
 *
 * A dialog with no height cap grows with its content and runs off BOTH ends
 * of the viewport — and the footer goes with it, so the confirm button on a
 * long bill or a long split list sits below the fold with no way to reach it
 * and no scrollbar to find it. The content is not the casualty; the actions
 * are.
 *
 * Three rules make that impossible, and each is asserted separately because
 * any one of them alone leaves the bug intact:
 *
 *   • the card is capped and lays out as a column;
 *   • the BODY is the scroller — `min-h-0` included, without which a flex
 *     child's min-height is its content and the card grows past the cap
 *     instead of overflowing inside it;
 *   • header and footer are `shrink-0`, so the body is the only thing that
 *     gives.
 *
 * ## Where it sits (PO, 2026-09-09)
 *
 * The second contract, asserted below: a modal is centred at EVERY width. It
 * used to be `items-end … sm:items-center` — a bottom sheet on a phone, a
 * centred card from `sm` up. Every question the app asks now goes through this
 * one component, so the position it picks is the position all of them get.
 *
 * Mutation-proved (D30): restoring the old overlay
 * (`items-end justify-center sm:items-center … p-0 sm:p-4`) fails 2 tests, and
 * restoring `rounded-t-2xl` on the card fails 1 — both run in a scratch copy
 * and reverted.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from './dialog';

afterEach(cleanup);

function open(
  children: React.ReactNode = <p>body</p>,
  footer?: React.ReactNode,
  toolbar?: React.ReactNode,
) {
  render(
    <Dialog
      open
      onClose={vi.fn()}
      title="A bill"
      description="Long"
      footer={footer}
      toolbar={toolbar}
    >
      {children}
    </Dialog>,
  );
  return screen.getByRole('dialog');
}

describe('Dialog height', () => {
  it('caps the card at 80% of the viewport and lays it out as a column', () => {
    const card = open();
    /*
     * `dvh`, not `vh`: on a phone or an iPad in Safari the toolbar collapses
     * and expands, and `vh` measures the TALLEST state — exactly the state
     * where the dialog does not fit.
     */
    expect(card.className).toContain('max-h-[80dvh]');
    expect(card.className).toContain('flex');
    expect(card.className).toContain('flex-col');
    // A maximum, not a height: a short dialog stays short.
    expect(card.className).not.toMatch(/(^|\s)h-\[80dvh\]/);
  });

  it('scrolls the BODY, not the card', () => {
    const card = open(<p data-testid="content">a very long bill</p>);
    const body = screen.getByTestId('content').parentElement!;

    expect(body.className).toContain('overflow-y-auto');
    /*
     * The one that is easy to leave out and impossible to notice: without
     * `min-h-0` the body's min-height is its content, so the card grows past
     * the cap rather than the body overflowing inside it. The cap then reads
     * as working while the footer is still off-screen.
     */
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('flex-1');
    // NEGATIVE — the card itself must not be the scroller, or the header and
    // footer scroll away with the content.
    expect(card.className).not.toContain('overflow-y-auto');
  });

  it('holds the header and footer at their size', () => {
    open(<p>body</p>, <button type="button">Confirm</button>);
    const footer = screen.getByRole('button', { name: 'Confirm' }).parentElement!;
    const header = screen.getByRole('heading', { name: 'A bill' }).parentElement!.parentElement!;

    // Both must refuse to shrink, so a tall body cannot squeeze the confirm
    // action down to nothing instead of scrolling.
    expect(footer.className).toContain('shrink-0');
    expect(header.className).toContain('shrink-0');
  });

  /*
   * The toolbar slot, added for the product picker's search box.
   *
   * It exists because `position: sticky` inside the body could not do the job:
   * a sticky element only hides what passes BEHIND its own painted box, so the
   * body's padding and the gap to the first row each became a strip where rows
   * were seen sliding through. Pinning it outside the scroller removes the
   * class of bug rather than closing the strips one at a time — which is the
   * claim these two cases make.
   */
  it('pins a toolbar outside the scroller, and takes the body’s top padding away', () => {
    open(<p data-testid="content">rows</p>, undefined, <input aria-label="Search" />);
    const toolbar = screen.getByLabelText('Search').parentElement!;
    const body = screen.getByTestId('content').parentElement!;

    // POSITIVE: pinned like the header and footer, so it cannot scroll away…
    expect(toolbar.className).toContain('shrink-0');
    // …and NOT the scroller itself, or it would take the rows with it.
    expect(toolbar.className).not.toContain('overflow-y-auto');

    /*
     * The one that closes the seam: with a toolbar above it, the body's own
     * top padding would be a transparent band INSIDE the scrollport — content
     * is clipped at the padding box, not the content box, so rows are visible
     * crossing it. The toolbar owns that gap instead.
     */
    expect(body.className).toContain('pt-0');
    expect(body.className).not.toMatch(/(^|\s)pt-2(\s|$)/);
  });

  it('keeps the body’s own top padding when there is no toolbar', () => {
    open(<p data-testid="content">rows</p>);
    const body = screen.getByTestId('content').parentElement!;

    // NEGATIVE ARM: every other dialog in the app renders without a toolbar
    // and must be spaced exactly as it was. Without this, "pt-0" above would
    // pass for a build that dropped the padding everywhere.
    expect(body.className).toContain('pt-2');
    expect(screen.queryByLabelText('Search')).toBeNull();
  });

  it('renders nothing at all when closed', () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="A bill">
        <p>body</p>
      </Dialog>,
    );
    // POSITIVE CONTROL for the queries above: they resolve a real element
    // only because the dialog mounts when open.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Dialog placement', () => {
  const overlay = () => screen.getByRole('dialog').parentElement!;

  it('centres the card on both axes, at every width', () => {
    open();

    // Both axes: `justify-center` alone leaves a card pinned to an edge that
    // is horizontally centred, which is what a bottom sheet is.
    expect(overlay().className).toContain('items-center');
    expect(overlay().className).toContain('justify-center');
  });

  it('NEGATIVE — no edge-pinning class survives, at any breakpoint', () => {
    open();
    const classes = overlay().className;

    /*
     * The regression this exists for, spelled out. `items-end sm:items-center`
     * passed the positive check above at every width — the string is right
     * there — while a phone still got a sheet flush to the bottom edge. So the
     * pinning alignments are named and excluded, bare and behind a variant.
     */
    for (const pinned of ['items-end', 'items-start', 'items-baseline']) {
      expect(classes).not.toMatch(new RegExp(`(^|\\s)${pinned}(\\s|$)`));
      // …and behind any variant prefix (`sm:`, `md:`, `print:`, …).
      expect(classes).not.toMatch(new RegExp(`(^|\\s)[a-z-]+:${pinned}(\\s|$)`));
    }
    // Unconditional centring: a `sm:items-center` would mean the base state is
    // something else, which is the bug.
    expect(classes).toMatch(/(^|\s)items-center(\s|$)/);
  });

  it('keeps the card off the screen edge and rounded on all four corners', () => {
    const card = open();

    // `p-4` at every width. It used to be `p-0 sm:p-4`, because a sheet flush
    // to the bottom wanted no padding — a floating card always does.
    expect(overlay().className).toMatch(/(^|\s)p-4(\s|$)/);
    expect(overlay().className).not.toMatch(/(^|\s)p-0(\s|$)/);
    // `rounded-t-2xl` was right for a sheet whose bottom corners were
    // off-screen. A centred card shows all four.
    expect(card.className).toMatch(/(^|\s)rounded-2xl(\s|$)/);
    expect(card.className).not.toContain('rounded-t-2xl');
  });
});
