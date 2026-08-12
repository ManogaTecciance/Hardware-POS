/**
 * The Tabs primitive, rendered.
 *
 * A source-text spec cannot answer the questions that matter here — "is the
 * inactive panel actually hidden", "does Right arrow move focus and change
 * value" — because those are runtime behaviours. Rendering + RTL asserts them
 * end-to-end.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

afterEach(() => cleanup());

function Harness({
  initial = 'overview',
  onChange,
}: {
  initial?: string;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <Tabs
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    >
      <TabsList aria-label="Product sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="variants">Variants</TabsTrigger>
        <TabsTrigger value="inventory">Inventory</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <p>overview-panel</p>
      </TabsContent>
      <TabsContent value="variants">
        <p>variants-panel</p>
      </TabsContent>
      <TabsContent value="inventory">
        <p>inventory-panel</p>
      </TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('exposes tablist / tab / tabpanel roles', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    // Three triggers with role=tab.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    // Two panels are hidden — getAllByRole excludes hidden by default, so only
    // the active one is returned.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('marks the active trigger with aria-selected and tabIndex 0', () => {
    render(<Harness />);
    const active = screen.getByRole('tab', { name: 'Overview' });
    const inactive = screen.getByRole('tab', { name: 'Variants' });
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.getAttribute('tabindex')).toBe('0');
    expect(inactive.getAttribute('aria-selected')).toBe('false');
    expect(inactive.getAttribute('tabindex')).toBe('-1');
  });

  it('renders only the active panel visibly; inactive panels are marked hidden', () => {
    render(<Harness />);
    // The active panel is discoverable by role.
    expect(screen.getByRole('tabpanel').textContent).toContain('overview-panel');
    // Every panel is in the DOM; the inactive ones carry the hidden attribute so
    // form state under them is preserved between tab flips.
    const panels = document.querySelectorAll('[role=tabpanel]');
    expect(panels).toHaveLength(3);
    let hiddenCount = 0;
    panels.forEach((el) => {
      if ((el as HTMLElement).hasAttribute('hidden')) hiddenCount += 1;
    });
    expect(hiddenCount).toBe(2);
  });

  it('clicking a trigger calls onValueChange with its value', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variants' }));
    expect(onChange).toHaveBeenCalledWith('variants');
    // The panel swaps: variants is now visible, overview is hidden.
    expect(screen.getByRole('tabpanel').textContent).toContain('variants-panel');
  });

  it('Right arrow cycles to the next trigger; Left arrow to the previous', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('variants');

    // From the new active tab, arrow left returns to overview.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Variants' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('overview');
  });

  it('Home jumps to the first trigger; End jumps to the last', () => {
    const onChange = vi.fn();
    render(<Harness initial="variants" onChange={onChange} />);
    const active = screen.getByRole('tab', { name: 'Variants' });
    active.focus();
    fireEvent.keyDown(active, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('inventory');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Inventory' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('overview');
  });

  it('Enter and Space activate the focused trigger', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const variants = screen.getByRole('tab', { name: 'Variants' });
    variants.focus();
    fireEvent.keyDown(variants, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('variants');

    const inventory = screen.getByRole('tab', { name: 'Inventory' });
    inventory.focus();
    fireEvent.keyDown(inventory, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('inventory');
  });
});
