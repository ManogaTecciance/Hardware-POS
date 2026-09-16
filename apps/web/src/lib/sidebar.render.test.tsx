/**
 * D177 — the drawer stays open once it is opened.
 *
 * ## The defect this pins
 *
 * Below the `tab:` (900px) cutover the rail is hidden and the off-canvas drawer
 * is the ONLY way to reach navigation. Tapping the header's opener appeared to
 * do nothing.
 *
 * The button was fine. `SidebarProvider` built its callbacks inside a `useMemo`
 * keyed on `[collapsed, mobileOpen, hydrated]`, so every state change minted a
 * new `closeMobile`. `Sidebar` closes the drawer on navigation with
 *
 *     React.useEffect(() => { closeMobile(); }, [pathname, closeMobile]);
 *
 * so opening the drawer changed `mobileOpen` → rebuilt the memo → new
 * `closeMobile` identity → that effect re-ran → the drawer shut. It opened and
 * closed itself in the same tick, which is indistinguishable from a dead button.
 *
 * ## What makes these non-vacuous (D30)
 *
 * The first case reproduces the CYCLE rather than asserting a flag. A consumer
 * that mirrors the real effect — depending on `closeMobile` and calling it — is
 * mounted, so the test fails against the old provider for the original reason
 * and not because of anything it was told to expect.
 *
 * Identity is then asserted DIRECTLY, in both directions: the callbacks must be
 * the same objects across a state change, and `collapsed` must still actually
 * change. Without the second half, a provider that had frozen its state
 * entirely would pass the first.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { SidebarProvider, useSidebar } from './sidebar';

afterEach(cleanup);

/**
 * Stands in for `Sidebar`'s route-change effect.
 *
 * Deliberately written the way the real one is — depending on `closeMobile` and
 * calling it — because that dependency IS the bug. A consumer that omitted it
 * would pass against the broken provider and prove nothing.
 */
function DrawerConsumer() {
  const { mobileOpen, openMobile, closeMobile, collapsed, toggleCollapsed } = useSidebar();
  const pathname = '/dashboard';

  React.useEffect(() => {
    closeMobile();
  }, [pathname, closeMobile]);

  return (
    <div>
      <button type="button" onClick={openMobile}>
        Open navigation
      </button>
      <button type="button" onClick={toggleCollapsed}>
        Toggle rail
      </button>
      <span data-testid="drawer">{mobileOpen ? 'open' : 'closed'}</span>
      <span data-testid="rail">{collapsed ? 'collapsed' : 'expanded'}</span>
    </div>
  );
}

function renderProvider() {
  return render(
    <SidebarProvider>
      <DrawerConsumer />
    </SidebarProvider>,
  );
}

describe('D177 — SidebarProvider', () => {
  it('opens the drawer and leaves it open', () => {
    renderProvider();
    expect(screen.getByTestId('drawer').textContent).toBe('closed');

    act(() => {
      screen.getByRole('button', { name: 'Open navigation' }).click();
    });

    // Against the old provider this read "closed": the open re-ran the
    // route-change effect through a fresh `closeMobile` and shut it again.
    expect(screen.getByTestId('drawer').textContent).toBe('open');
  });

  it('survives an unrelated state change', () => {
    // Collapsing the rail also rebuilt the memo, so it closed the drawer too.
    // Different trigger, same cause — worth pinning separately so a partial fix
    // cannot look complete.
    renderProvider();
    act(() => screen.getByRole('button', { name: 'Open navigation' }).click());
    act(() => screen.getByRole('button', { name: 'Toggle rail' }).click());

    expect(screen.getByTestId('drawer').textContent).toBe('open');
  });

  it('hands out the same callbacks across a state change', () => {
    const seen: { open: unknown; close: unknown; toggle: unknown }[] = [];

    function Probe() {
      const { openMobile, closeMobile, toggleCollapsed } = useSidebar();
      seen.push({ open: openMobile, close: closeMobile, toggle: toggleCollapsed });
      const { toggleCollapsed: t } = useSidebar();
      return (
        <button type="button" onClick={t}>
          Toggle rail
        </button>
      );
    }

    render(
      <SidebarProvider>
        <Probe />
      </SidebarProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Toggle rail' }).click());

    expect(seen.length).toBeGreaterThan(1);
    const first = seen[0]!;
    const last = seen[seen.length - 1]!;
    // Identity, not equality: `toBe`. These land in effect dependency arrays,
    // so a new object each render silently re-runs every effect that took one.
    expect(last.open).toBe(first.open);
    expect(last.close).toBe(first.close);
    expect(last.toggle).toBe(first.toggle);
  });

  it('still changes the state the callbacks are for', () => {
    // The other half of the identity test. A provider that had frozen its state
    // entirely would hand out stable callbacks and pass the case above while
    // doing nothing at all.
    renderProvider();
    const before = screen.getByTestId('rail').textContent;

    act(() => screen.getByRole('button', { name: 'Toggle rail' }).click());

    expect(screen.getByTestId('rail').textContent).not.toBe(before);
  });

  it('closing still closes', () => {
    // The drawer must not become un-closable in the course of making it
    // openable — the overlay, Escape and navigation all rely on this.
    function Closer() {
      const { mobileOpen, openMobile, closeMobile } = useSidebar();
      return (
        <div>
          <button type="button" onClick={openMobile}>
            Open navigation
          </button>
          <button type="button" onClick={closeMobile}>
            Close navigation
          </button>
          <span data-testid="drawer">{mobileOpen ? 'open' : 'closed'}</span>
        </div>
      );
    }

    render(
      <SidebarProvider>
        <Closer />
      </SidebarProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Open navigation' }).click());
    expect(screen.getByTestId('drawer').textContent).toBe('open');

    act(() => screen.getByRole('button', { name: 'Close navigation' }).click());
    expect(screen.getByTestId('drawer').textContent).toBe('closed');
  });
});
