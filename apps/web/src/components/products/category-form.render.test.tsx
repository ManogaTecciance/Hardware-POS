/**
 * The category / subcategory dialogs, rendered, against their validation rules.
 *
 * These are render tests rather than source-text checks for the reason the
 * architectural-test standard gives: the claim is "a blocked Create names the
 * offending field AND does not reach the API". A regex over the source passes
 * equally when the guard is present, when it was renamed, and when the dialog
 * stopped rendering at all. Driving the real dialog and asserting on the
 * accessible tree plus the API spy can only pass one way.
 *
 * Only the boundaries are stubbed: the API client and the session. The dialogs,
 * the validator and the page wiring between them are real.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/products-api';

// ── boundaries ───────────────────────────────────────────────────────────────

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/products/categories',
  useSearchParams: () => new URLSearchParams(),
}));

const session = {
  token: 't',
  refreshToken: 'r',
  user: {
    id: 'u1',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'OWNER' as const,
    tenantId: 'tnt_a',
    permissions: [Permission.PRODUCT_READ, Permission.CATEGORY_MANAGE] as Permission[],
  },
  branchId: 'b1',
  registerId: null,
  branchName: 'Main',
  registerName: '—',
};

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session,
    loading: false,
    isAuthenticated: true,
    hasPermission: (p: string) => session.user.permissions.includes(p as Permission),
    loginWithEmail: vi.fn(),
    logout: vi.fn(),
  }),
}));

/** One existing category with one existing subcategory — the collision fixtures. */
const powerTools: CategoryNode = {
  id: 'cat-1',
  name: 'Power Tools',
  slug: 'power-tools',
  description: null,
  imageUrl: null,
  sortOrder: 0,
  isActive: true,
  productCount: 3,
  quickbooksItemId: null,
  subcategoryCount: 1,
  subcategories: [
    {
      id: 'sub-1',
      categoryId: 'cat-1',
      name: 'Cordless Drills',
      slug: 'cordless-drills',
      description: null,
      imageUrl: null,
      sortOrder: 0,
      isActive: true,
      productCount: 2,
    },
  ],
};

const createCategory = vi.fn().mockResolvedValue({ id: 'cat-2' });
const createSubcategory = vi.fn().mockResolvedValue({ id: 'sub-2' });

vi.mock('@/lib/products-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/products-api')>();
  return {
    ...actual,
    fetchCategoryTree: vi.fn().mockResolvedValue([powerTools]),
    createCategory,
    createSubcategory,
    updateCategory: vi.fn(),
    updateSubcategory: vi.fn(),
    moveSubcategory: vi.fn(),
    reorderCategories: vi.fn(),
    deactivateCategory: vi.fn(),
    reactivateCategory: vi.fn(),
    deactivateSubcategory: vi.fn(),
    reactivateSubcategory: vi.fn(),
  };
});

// Imported after the mocks so the page under test picks them up.
const CategoriesPage = (await import('@/app/(app)/products/categories/page')).default;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Render the page and open the New category dialog. */
async function openCategoryDialog() {
  render(<CategoriesPage />);
  await screen.findByText('Power Tools');
  fireEvent.click(screen.getByRole('button', { name: 'New category' }));
  return within(await screen.findByRole('dialog'));
}

/** Render the page and open the New subcategory dialog under Power Tools. */
async function openSubcategoryDialog() {
  render(<CategoriesPage />);
  await screen.findByText('Power Tools');
  fireEvent.click(screen.getByRole('button', { name: 'Add subcategory' }));
  return within(await screen.findByRole('dialog'));
}

/** Type into a field the dialog labels, without assuming its element type. */
function type(dialog: ReturnType<typeof within>, label: RegExp, value: string) {
  fireEvent.change(dialog.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  createCategory.mockClear();
  createSubcategory.mockClear();
});

afterEach(cleanup);

// ── specs ────────────────────────────────────────────────────────────────────

describe('New category dialog', () => {
  it('blocks an empty name, says so, and does not call the API', async () => {
    const dialog = await openCategoryDialog();

    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    expect(await dialog.findByText('Name is required')).toBeTruthy();
    expect(createCategory).not.toHaveBeenCalled();
    // The blocked field is the one focus lands on, so the next keystroke fixes it.
    expect(document.activeElement).toBe(dialog.getByLabelText(/^Name/));
  });

  it('rejects a name that already exists, case-insensitively, before the round trip', async () => {
    const dialog = await openCategoryDialog();

    // The server compares with mode: 'insensitive'; a differently-cased name is
    // the same name to it, so it must not look acceptable here.
    type(dialog, /^Name/, 'power tools');
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    expect(await dialog.findByText(/already exists/)).toBeTruthy();
    expect(createCategory).not.toHaveBeenCalled();
  });

  it('rejects a non-integer and a negative sort order', async () => {
    const dialog = await openCategoryDialog();
    type(dialog, /^Name/, 'Hand Tools');

    // Left unvalidated this parsed to 0 and saved silently under a name the
    // operator believed they had ordered.
    type(dialog, /Sort order/, 'abc');
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    expect(await dialog.findByText('Sort order must be a whole number')).toBeTruthy();

    type(dialog, /Sort order/, '-1');
    expect(await dialog.findByText('Sort order cannot be negative')).toBeTruthy();

    expect(createCategory).not.toHaveBeenCalled();
  });

  it('caps the name and description at the DTO lengths', async () => {
    const dialog = await openCategoryDialog();

    expect(dialog.getByLabelText(/^Name/).getAttribute('maxlength')).toBe('120');
    expect(dialog.getByLabelText(/Description/).getAttribute('maxlength')).toBe('500');
  });

  it('clears the message as soon as the field is corrected', async () => {
    const dialog = await openCategoryDialog();

    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    expect(await dialog.findByText('Name is required')).toBeTruthy();

    // A snapshot of the errors taken at submit time would leave this standing
    // under a field that is now valid.
    type(dialog, /^Name/, 'Hand Tools');
    await waitFor(() => expect(dialog.queryByText('Name is required')).toBeNull());
  });

  it('submits a trimmed name and a parsed sort order once the form is valid', async () => {
    const dialog = await openCategoryDialog();

    type(dialog, /^Name/, '  Hand Tools  ');
    type(dialog, /Sort order/, '3');
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCategory).toHaveBeenCalledTimes(1));
    expect(createCategory.mock.calls[0]?.[1]).toMatchObject({ name: 'Hand Tools', sortOrder: 3 });
  });
});

describe('New subcategory dialog', () => {
  it('rejects a name already used under the selected parent', async () => {
    const dialog = await openSubcategoryDialog();

    // Uniqueness is per-parent server-side, so the check has to be scoped to the
    // selected category rather than to every subcategory in the tenant.
    type(dialog, /^Name/, 'cordless drills');
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    expect(await dialog.findByText(/already exists/)).toBeTruthy();
    expect(createSubcategory).not.toHaveBeenCalled();
  });

  it('accepts a name only used under a different parent', async () => {
    const dialog = await openSubcategoryDialog();

    type(dialog, /^Name/, 'Power Tools');
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createSubcategory).toHaveBeenCalledTimes(1));
    expect(createSubcategory.mock.calls[0]?.[1]).toMatchObject({
      categoryId: 'cat-1',
      name: 'Power Tools',
    });
  });
});
