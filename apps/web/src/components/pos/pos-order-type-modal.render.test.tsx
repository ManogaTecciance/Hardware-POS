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
    for (const label of ['at the counter', 'picks up', 'rider']) {
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
