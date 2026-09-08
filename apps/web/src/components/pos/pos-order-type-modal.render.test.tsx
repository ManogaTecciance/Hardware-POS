/**
 * PosOrderTypeModal — the very first thing a cashier sees on `/pos`.
 *
 * Load-bearing behaviour: one click selects a mode and calls back
 * immediately (no Continue), and the three options are a radiogroup so
 * keyboard navigation is real. Every assertion below is paired with a
 * positive control so a component that always/never rendered would fail.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PosOrderTypeModal } from './pos-order-type-modal';

afterEach(cleanup);

describe('PosOrderTypeModal', () => {
  it('renders exactly three options: Dine In, Takeaway, Delivery', () => {
    render(<PosOrderTypeModal onSelect={() => {}} onCancel={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('Dine In'),
      expect.stringContaining('Takeaway'),
      expect.stringContaining('Delivery'),
    ]);
    // POSITIVE CONTROL: options carry hints so a screen reader user does
    // not have to guess what each mode means.
    // Dine In is the WAITER flow since 2026-08-18 — the hint must say so,
    // not describe a guest paying at the till.
    for (const label of ['at a table', 'picks up', 'rider']) {
      expect(document.body.textContent).toMatch(new RegExp(label, 'i'));
    }
  });

  it('clicking a card selects the mode with a single call', () => {
    const onSelect = vi.fn();
    render(<PosOrderTypeModal onSelect={onSelect} onCancel={() => {}} />);
    screen.getByRole('radio', { name: /takeaway/i }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('TAKEAWAY');
  });

  it('does NOT render a Continue button — one click is one selection', () => {
    render(<PosOrderTypeModal onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
  });

  it('exposes the options as a radiogroup for keyboard/screen-reader nav', () => {
    render(<PosOrderTypeModal onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('radiogroup')).toBeDefined();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // Only the currently-focused radio is tabbable; the other two are
    // reached via arrow keys — the correct pattern for a radiogroup.
    const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('close button/backdrop invokes onCancel (a path back to where they came from)', () => {
    const onCancel = vi.fn();
    render(<PosOrderTypeModal onSelect={() => {}} onCancel={onCancel} />);
    // Dialog primitive renders an X close button — same pattern as every
    // other dialog in the app.
    screen.getByRole('button', { name: /close/i }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

/**
 * D87 — the modal offers only what the signed-in role can complete.
 *
 * An option a role cannot finish is worse than a missing one: it is a door
 * that opens onto a refusal, and nothing on the screen says which of the
 * three will work until the operator picks one. The waiter case is the live
 * one — they take dine-in AND takeaway (a seated guest ordering something to
 * take home is still their order) but not delivery.
 */
describe('D87 — mode filtering', () => {
  it('shows only the modes it is given', () => {
    render(
      <PosOrderTypeModal
        modes={['DINE_IN', 'TAKEAWAY']}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // POSITIVE — both of the waiter's modes are offered…
    expect(screen.getByText('Dine In')).toBeTruthy();
    expect(screen.getByText('Takeaway')).toBeTruthy();
    // …NEGATIVE — and the one they cannot complete is absent, not disabled.
    expect(screen.queryByText('Delivery')).toBeNull();
  });

  it('shows all three when no restriction is given', () => {
    render(<PosOrderTypeModal onSelect={vi.fn()} onCancel={vi.fn()} />);
    /*
     * The default has to stay open, or every existing caller silently loses
     * options — which is the same defect in the other direction.
     */
    expect(screen.getByText('Dine In')).toBeTruthy();
    expect(screen.getByText('Takeaway')).toBeTruthy();
    expect(screen.getByText('Delivery')).toBeTruthy();
  });
});
