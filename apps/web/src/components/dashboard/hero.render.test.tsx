/**
 * D177 — the hero's "More actions" menu is not clipped by its own card.
 *
 * ## The defect this pins
 *
 * The hero root carried `overflow-hidden`. Below the container-query threshold
 * the secondary actions collapse into a "More actions" menu, so on a narrow
 * screen that dropdown was the ONLY route to Create Quote — and it was cut off
 * at the card's bottom edge. `z-30` on the menu could not help: `overflow:
 * hidden` clips regardless of stacking.
 *
 * ## Why the class, and not a measurement
 *
 * jsdom has no layout engine and no painting, so nothing is ever clipped in it:
 * a test that measured would pass against the broken card and the fixed one
 * alike. The presence of `overflow-hidden` on that element IS the defect, so
 * asserting its absence is asserting the fix.
 *
 * The menu's own `overflow-hidden` is fine and deliberate — it rounds the
 * corners of its items — which is why this looks at the CARD element
 * specifically rather than searching the tree for the class.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FileText, ShoppingCart } from 'lucide-react';

import { DashboardHero } from './hero';

afterEach(cleanup);

function renderHero() {
  return render(
    <DashboardHero
      greeting="Good morning"
      name="Nimal"
      subtitle="Here's what's happening across your business today."
      meta={[]}
      primary={{ key: 'sale', label: 'New Sale', href: '/pos', icon: ShoppingCart }}
      secondary={[{ key: 'quote', label: 'Create Quote', href: '/quotations/new', icon: FileText }]}
    />,
  );
}

/** The card element itself — the one that was doing the clipping. */
function card(): HTMLElement {
  const el = screen.getByRole('heading', { name: /Good morning, Nimal/ }).closest('.rounded-2xl');
  if (!el) throw new Error('hero card not found');
  return el as HTMLElement;
}

describe('D177 — the dashboard hero', () => {
  it('does not clip its own overflow', () => {
    renderHero();
    expect(card().className).not.toContain('overflow-hidden');
  });

  it('still rounds and paints as a card', () => {
    // The classes `overflow-hidden` was wrongly credited with. Removing it must
    // not quietly remove the card's appearance with it.
    renderHero();
    const classes = card().className;
    expect(classes).toContain('rounded-2xl');
    expect(classes).toContain('bg-hero-gradient');
    expect(classes).toContain('@container');
  });

  it('keeps the secondary action reachable through the More menu', () => {
    // The thing being protected. If the collapse-into-a-menu behaviour ever
    // goes, this test should say so rather than silently guarding a class on a
    // card whose menu no longer exists.
    renderHero();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /Create Quote/ })).toBeTruthy();
  });
});
