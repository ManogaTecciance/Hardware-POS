/**
 * Restaurant Menu admin — Slice D43 render coverage.
 *
 * Non-vacuous per D30: every claim about the overflow menu, the image
 * component, or the CRUD dialogs is paired with a negative that would fire if
 * the wiring silently reverted.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageUpload } from './wizard/image-upload';
import { OverflowItem, OverflowMenu } from './overflow-menu';

afterEach(cleanup);

// ── OverflowMenu ─────────────────────────────────────────────────────────

describe('OverflowMenu', () => {
  it('is closed by default and opens on click', () => {
    render(
      <OverflowMenu label="Actions for Mix Kottu">
        {() => <OverflowItem icon={null} label="Edit" onClick={() => {}} />}
      </OverflowMenu>,
    );
    // Positive: the trigger renders.
    const trigger = screen.getByRole('button', { name: /actions for mix kottu/i });
    expect(trigger).toBeDefined();
    // Negative: the menu is not present until click.
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeDefined();
  });

  it('closes on Escape', () => {
    render(
      <OverflowMenu label="a">
        {() => <OverflowItem icon={null} label="X" onClick={() => {}} />}
      </OverflowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: /a/i }));
    expect(screen.getByRole('menu')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('OverflowItem with tone="danger" renders as a menuitem with danger styling', () => {
    render(
      <OverflowMenu label="a">
        {() => (
          <>
            <OverflowItem icon={null} label="Edit" onClick={() => {}} />
            <OverflowItem icon={null} label="Delete permanently" tone="danger" onClick={() => {}} />
          </>
        )}
      </OverflowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: /a/i }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    // Positive: the destructive one carries the text-danger class token.
    const destructive = items.find((i) => /delete permanently/i.test(i.textContent ?? ''))!;
    expect(destructive.className).toMatch(/text-danger/);
    // Negative: the non-destructive one does NOT carry it.
    const edit = items.find((i) => /^edit/i.test(i.textContent ?? ''))!;
    expect(edit.className).not.toMatch(/text-danger/);
  });
});

// ── ImageUpload ──────────────────────────────────────────────────────────

vi.mock('@/lib/restaurant/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/restaurant/api');
  return {
    ...actual,
    uploadMenuItemImage: vi.fn(async (_s: unknown, file: File) => ({
      imageUrl: `/uploads/${file.name}`,
    })),
  };
});

describe('ImageUpload', () => {
  const session = {} as never;

  it('shows Upload + Image URL tabs when no image is set', () => {
    render(<ImageUpload session={session} value="" onChange={() => {}} />);
    // Positive: tabs are present.
    expect(screen.getByRole('tab', { name: /upload/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /image url/i })).toBeDefined();
    // Positive: Browse files button reachable by keyboard.
    expect(screen.getByRole('button', { name: /browse files/i })).toBeDefined();
    // Negative: no preview elements until an image is set.
    expect(screen.queryByRole('button', { name: /replace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('renders the preview + Replace/Remove once a URL is present', () => {
    render(
      <ImageUpload
        session={session}
        value="/uploads/kottu.webp"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /replace/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /remove/i })).toBeDefined();
    // Negative: the capture tabs disappear once an image is chosen — the
    // preview is the whole surface.
    expect(screen.queryByRole('tab', { name: /image url/i })).toBeNull();
  });

  it('Remove clears the value back to empty string', () => {
    let value = '/uploads/kottu.webp';
    const onChange = (next: string) => {
      value = next;
    };
    const { rerender } = render(
      <ImageUpload session={session} value={value} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    // The parent-controlled component only reflects the change after rerender.
    rerender(<ImageUpload session={session} value={value} onChange={onChange} />);
    expect(value).toBe('');
    // Positive control: after clearing, the capture tabs return.
    expect(screen.getByRole('tab', { name: /image url/i })).toBeDefined();
  });

  it('URL tab rejects non-http(s) values with a role=alert', () => {
    render(<ImageUpload session={session} value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /image url/i }));
    const input = screen.getByLabelText(/paste image url/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: /use url/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/http\(s\)/i);
  });
});
