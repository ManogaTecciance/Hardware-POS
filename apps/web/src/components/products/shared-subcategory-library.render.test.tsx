/**
 * Shared subcategory library — delete confirmation (D141, D30).
 *
 * The delete button drops a subcategory from the shared library AND from every
 * category it is assigned to, so it is guarded by a confirm. That guard moved
 * from `window.confirm` to the app's promise-based `useConfirm`, and the risk of
 * that conversion is exactly one thing: the guard silently disappearing, which a
 * "delete works" test alone cannot see. So each case is paired —
 *
 *   - confirming DOES call `deleteFromLibrary`,
 *   - cancelling does NOT, and the row is still there afterwards,
 *   - `window.confirm` is never reached at all.
 *
 * The service is mocked at the module boundary: these tests are about the guard,
 * not about the LocalStorage adapter behind it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import type { Subcategory } from '@/lib/category-assignments';

// ── Module-boundary mock ─────────────────────────────────────────────────────

function subcategory(id: string, name: string, sortOrder: number): Subcategory {
  return { id, name, isActive: true, sortOrder };
}

let library: Subcategory[] = [];

const deleteFromLibrary = vi.fn<(subcategoryId: string) => void>((id) => {
  library = library.filter((s) => s.id !== id);
});

vi.mock('@/lib/category-assignments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/category-assignments')>();
  return {
    ...actual,
    categoryAssignmentService: {
      ...actual.categoryAssignmentService,
      getLibrary: () => library,
      getAssigned: () => [],
      deleteFromLibrary: (id: string) => deleteFromLibrary(id),
    },
  };
});

// Imported after the mock so the component picks up the stubbed service.
const { SharedSubcategoryLibrary } = await import('./shared-subcategory-library');

const categories = [{ id: 'cat_tiles', name: 'Tiles' }];

/** Fails the run if anything still reaches for the browser dialog (D141). */
const nativeConfirm = vi.fn<(message?: string) => boolean>(() => true);

beforeEach(() => {
  library = [subcategory('lib_fasteners', 'Fasteners', 0)];
  deleteFromLibrary.mockClear();
  nativeConfirm.mockClear();
  vi.spyOn(window, 'confirm').mockImplementation(nativeConfirm);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderLibrary() {
  return render(
    <ConfirmProvider>
      <SharedSubcategoryLibrary categories={categories} canManage />
    </ConfirmProvider>,
  );
}

describe('SharedSubcategoryLibrary — deleting from the shared library is confirmed', () => {
  it('deletes the subcategory once the danger dialog is confirmed', async () => {
    renderLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Fasteners from library' }));

    // The question names the subcategory and the wider consequence, as the old
    // single confirm string did.
    expect(
      await screen.findByRole('heading', { name: 'Delete "Fasteners" from the shared library?' }),
    ).toBeTruthy();
    expect(
      screen.getByText('It is also removed from every category it is assigned to.'),
    ).toBeTruthy();

    // A destructive action gets a verb, never a bare "OK"/"Confirm".
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteFromLibrary).toHaveBeenCalledWith('lib_fasteners'));
    // The list re-reads the service, so the row goes with it. Queried by its
    // delete button: the name also appears in the "assign existing" picker.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete Fasteners from library' })).toBeNull(),
    );
  });

  it('deletes nothing when the dialog is cancelled', async () => {
    renderLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Fasteners from library' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    // The negative that the guard exists for: no service call, row untouched.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /shared library\?$/ })).toBeNull(),
    );
    expect(deleteFromLibrary).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Fasteners from library' })).toBeTruthy();
  });

  it('deletes nothing when the dialog is dismissed with Escape', async () => {
    renderLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Fasteners from library' }));
    await screen.findByRole('button', { name: 'Delete' });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteFromLibrary).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Fasteners from library' })).toBeTruthy();
  });

  it('never falls back to the browser dialog', async () => {
    renderLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Fasteners from library' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteFromLibrary).toHaveBeenCalledTimes(1));
    // Positive above, negative here: the delete happened, and it happened
    // without `window.confirm` being touched.
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});
