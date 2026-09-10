/**
 * The command palette after D151 took its header trigger away.
 *
 * The PO asked for the search bar beside the theme toggle to go. The palette
 * itself was not what they asked about, so the keyboard route stays — and that
 * split is exactly the kind of thing that rots. Someone tidying "dead" code
 * finds a component that renders nothing and deletes it; someone restoring
 * "discoverability" puts the button back. Both are pinned here.
 *
 * The gate lives in `command-palette.gate.test.ts`, which is data. This file is
 * about what is on screen and what a keystroke does.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

// Every permission, so the absence of a search bar below is never the absence
// of a palette this session was not allowed to see.
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

import { CommandPalette } from './command-palette';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openWithShortcut = () => fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

describe('the header carries no search bar (D151)', () => {
  it('renders NOTHING until someone asks for it', () => {
    const { container } = render(<CommandPalette />);

    /*
     * The removal, asserted three ways, because each catches a different way
     * of putting it back: by role (a plain button), by its old accessible
     * name, and by its old visible text.
     */
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Open command search')).toBeNull();
    expect(screen.queryByText(/search or jump to/i)).toBeNull();
    // …and nothing at all reaches the header row, not even an empty wrapper
    // that would still take the gap the flex row puts between its children.
    expect(container.innerHTML).toBe('');
  });

  it('NEGATIVE — the shortcut still opens it, so "renders nothing" is not "is broken"', () => {
    render(<CommandPalette />);

    openWithShortcut();

    /*
     * The positive control for the test above, and the reason the queries
     * there are not vacuous: the very strings and roles that are absent
     * before the keystroke are present after it. A component that had been
     * gutted rather than made headless would fail here.
     */
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByPlaceholderText(/search actions, pages, records/i)).toBeTruthy();
  });

  it('closes again on Escape, and on the second press of the shortcut', () => {
    render(<CommandPalette />);

    openWithShortcut();
    // On the INPUT, which is where the handler lives and where focus already
    // is — the dialog autofocuses it on open. A window-level Escape never
    // reaches it, so firing there would prove nothing about the real path.
    fireEvent.keyDown(screen.getByPlaceholderText(/search actions, pages, records/i), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    // The shortcut toggles — it always did, and losing that would strand
    // anyone who opened it by accident with no visible way back.
    openWithShortcut();
    expect(screen.getByRole('dialog')).toBeTruthy();
    openWithShortcut();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still navigates, so the palette is a live feature and not a husk', () => {
    render(<CommandPalette />);
    openWithShortcut();

    const input = screen.getByPlaceholderText(/search actions, pages, records/i);
    fireEvent.change(input, { target: { value: 'ticket history' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Keeping the shortcut is only defensible if it still does something.
    expect(push).toHaveBeenCalledWith('/kitchen/history');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('finds the ticket history by a lane name, not only by "done" (D150)', () => {
    render(<CommandPalette />);
    openWithShortcut();

    /*
     * The screen now holds queued and in-progress work too, so its keywords
     * had to stop describing only the past. Someone typing what they see on
     * the board must reach it.
     */
    fireEvent.change(screen.getByPlaceholderText(/search actions, pages, records/i), {
      target: { value: 'preparing' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/search actions, pages, records/i), {
      key: 'Enter',
    });

    expect(push).toHaveBeenCalledWith('/kitchen/history');
  });
});
