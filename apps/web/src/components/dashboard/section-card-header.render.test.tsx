/**
 * D176 — a section header that breaks rather than crushes itself.
 *
 * ## The defect this pins
 *
 * On a narrow dashboard panel, "Business Attention" rendered its `1 critical`
 * badge across two lines — `1` above `critical` — while the title collapsed to
 * "B.". Three faults compounded:
 *
 *  - `action` was `shrink-0`, so the segmented control never yielded;
 *  - `badge` was neither `shrink-0` nor `whitespace-nowrap`, so the count was
 *    the thing that gave;
 *  - the title has `truncate`, so it absorbed the rest and stopped saying
 *    anything.
 *
 * ## Why this asserts the CSS contract, not pixels
 *
 * jsdom has no layout engine: every element is 0×0 and nothing wraps, so a test
 * that measured would pass against the broken component and the fixed one
 * alike. What IS provable here is the contract that produces the behaviour —
 * the badge is marked un-shrinkable and un-wrappable, and the header is allowed
 * to break onto a second line rather than being a single unbreakable row.
 *
 * That contract is exactly what was missing, so pinning it is pinning the fix.
 * Whether 14rem is the right basis is a judgement about looks, and that belongs
 * in front of a human (DASH-029..031), not in an assertion.
 *
 * ## What makes these non-vacuous (D30)
 *
 * Each class is asserted on the element that must carry it, found by its
 * relationship to the content — the badge's wrapper is located from the badge's
 * own text, not by a container query that would match any div in the header.
 *
 * The negative halves matter more than the positives here. `flex-nowrap` is
 * asserted ABSENT from the header, and the badge wrapper is asserted NOT to
 * carry `min-w-0`: both are the states the component was in when it broke, and
 * a test that only checked for the new classes would pass with the old ones
 * still present beside them.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertTriangle } from 'lucide-react';

import { SectionCard } from './primitives';

afterEach(cleanup);

/** The header element: the card's own banner, not the body. */
function header(): HTMLElement {
  const el = document.querySelector('section > header');
  if (!el) throw new Error('SectionCard rendered no header');
  return el as HTMLElement;
}

function renderCard(props: Partial<React.ComponentProps<typeof SectionCard>> = {}) {
  return render(
    <SectionCard
      title="Business Attention"
      icon={AlertTriangle}
      badge={<span>1 critical</span>}
      action={<button type="button">Critical</button>}
      {...props}
    >
      <p>body</p>
    </SectionCard>,
  );
}

describe('D176 — the section header', () => {
  it('lets the row break instead of forcing one unbreakable line', () => {
    renderCard();
    const classes = header().className;

    expect(classes).toContain('flex-wrap');
    // The state it was in when it broke. Asserting only the presence of
    // `flex-wrap` would pass with `flex-nowrap` still sitting beside it, and the
    // later class in the stylesheet would win.
    expect(classes).not.toContain('flex-nowrap');
  });

  it('measures itself against its own panel, not the window', () => {
    renderCard();
    // A card in a grid can be wide on a dashboard and narrow in a sidebar on the
    // identical screen. A viewport breakpoint cannot tell those apart.
    expect(header().className).toContain('@container');
  });

  it('keeps the count on one line and refuses to let it shrink', () => {
    renderCard();
    // Located from the badge's own text: a `querySelector` for the classes would
    // match whichever div happened to have them and prove nothing about where.
    const wrapper = screen.getByText('1 critical').parentElement;

    expect(wrapper?.className).toContain('shrink-0');
    expect(wrapper?.className).toContain('whitespace-nowrap');
    // `min-w-0` is what let the badge collapse below its content. Its absence is
    // the fix; its presence would reinstate the bug with the new classes on.
    expect(wrapper?.className).not.toContain('min-w-0');
  });

  it('gives the title a width to claim before anything wraps', () => {
    renderCard();
    const group = screen.getByRole('heading', { name: 'Business Attention' }).parentElement
      ?.parentElement;

    // A basis, not `flex-1`. `flex-1` is `flex: 1 1 0%` — basis zero, so the
    // group shrinks away silently and the title truncates to a letter instead of
    // the control wrapping.
    expect(group?.className).toContain('flex-[1_1_14rem]');
    expect(group?.className).not.toContain('flex-1 ');
  });

  it('still renders a card with no badge and no action', () => {
    // Most cards pass neither. The wrapper must not appear as an empty div that
    // adds a gap where nothing is.
    renderCard({ badge: undefined, action: undefined });

    expect(screen.getByRole('heading', { name: 'Business Attention' })).toBeTruthy();
    expect(header().querySelectorAll('.whitespace-nowrap')).toHaveLength(0);
  });

  it('keeps the title truncating, which is still right for a long one', () => {
    // The fix gives the title ROOM; it does not make it unbreakable. A title
    // long enough to fill the row must still clip rather than push the badge
    // off the card.
    renderCard({ title: 'An extremely long section heading that no panel could ever fit' });
    expect(screen.getByRole('heading').className).toContain('truncate');
  });
});
