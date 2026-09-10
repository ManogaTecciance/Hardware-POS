'use client';

import * as React from 'react';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { InventoryTabs } from '@/components/products/inventory-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  createCategory,
  createSubcategory,
  deactivateCategory,
  deactivateSubcategory,
  fetchCategoryTree,
  moveSubcategory,
  reactivateCategory,
  reactivateSubcategory,
  reorderCategories,
  updateCategory,
  updateSubcategory,
  type CategoryNode,
  type Subcategory,
} from '@/lib/products-api';
import { cn } from '@/lib/utils';

/*
 * Form limits mirror the category/subcategory DTOs
 * (apps/api/src/modules/categories/dto) rather than inventing their own: name
 * @MaxLength(120), description @MaxLength(500), sortOrder @IsInt @Min(0) over
 * an int4 column. The client checks are for fast, in-place feedback only — the
 * server stays the authority, and a 400 or a 409 it still returns (a name
 * another till created a second ago, say) surfaces in the dialog's own error.
 */
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SORT_ORDER = 2_147_483_647;

type TaxonomyErrors = Partial<Record<'name' | 'description' | 'sortOrder' | 'categoryId', string>>;

interface CatDialogState {
  open: boolean;
  editing: CategoryNode | null;
}
interface SubDialogState {
  open: boolean;
  editing: Subcategory | null;
  categoryId: string;
}

export default function CategoriesPage() {
  const { session, hasPermission } = useAuth();
  const canView = hasPermission(Permission.PRODUCT_READ);
  const canManage = hasPermission(Permission.CATEGORY_MANAGE);

  const [categories, setCategories] = React.useState<CategoryNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const [query, setQuery] = React.useState('');
  const [catDialog, setCatDialog] = React.useState<CatDialogState>({ open: false, editing: null });
  const [subDialog, setSubDialog] = React.useState<SubDialogState>({
    open: false,
    editing: null,
    categoryId: '',
  });

  const load = React.useCallback(() => {
    if (!session) return;
    setLoading(true);
    setError(null);
    fetchCategoryTree(session)
      .then(setCategories)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load categories'),
      )
      .finally(() => setLoading(false));
  }, [session]);

  React.useEffect(() => {
    load();
  }, [load]);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runMutation = async (fn: () => Promise<unknown>) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  // Search filters categories by their own name/description or any of their
  // subcategory names. Reorder is disabled while filtering (indices would drift).
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const visibleCategories = React.useMemo(
    () =>
      q
        ? categories.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.description ?? '').toLowerCase().includes(q) ||
              c.subcategories.some((s) => s.name.toLowerCase().includes(q)),
          )
        : categories,
    [categories, q],
  );

  const moveCategory = async (index: number, dir: -1 | 1) => {
    if (!session) return;
    const target = index + dir;
    if (target < 0 || target >= categories.length) return;
    const next = [...categories];
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    setCategories(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      await reorderCategories(
        session,
        next.map((c) => c.id),
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reorder categories');
      load(); // resync with server order
    } finally {
      setBusy(false);
    }
  };

  const submitCategory = async (values: {
    name: string;
    description: string;
    sortOrder: number;
  }) => {
    if (!session) return;
    if (catDialog.editing) {
      await updateCategory(session, catDialog.editing.id, {
        name: values.name,
        description: values.description || null,
        sortOrder: values.sortOrder,
      });
    } else {
      await createCategory(session, {
        name: values.name,
        description: values.description || undefined,
        sortOrder: values.sortOrder,
      });
    }
    setCatDialog({ open: false, editing: null });
    load();
  };

  const submitSubcategory = async (values: {
    categoryId: string;
    name: string;
    description: string;
    sortOrder: number;
  }) => {
    if (!session) return;
    if (subDialog.editing) {
      await updateSubcategory(session, subDialog.editing.id, {
        name: values.name,
        description: values.description || null,
        sortOrder: values.sortOrder,
      });
      if (values.categoryId && values.categoryId !== subDialog.editing.categoryId) {
        await moveSubcategory(session, subDialog.editing.id, values.categoryId);
      }
    } else {
      await createSubcategory(session, {
        categoryId: values.categoryId,
        name: values.name,
        description: values.description || undefined,
        sortOrder: values.sortOrder,
      });
    }
    setSubDialog({ open: false, editing: null, categoryId: '' });
    load();
  };

  if (!session) return null;

  return (
    <div className="space-y-6">
      <InventoryTabs />
      <PageHeader
        title="Categories & Subcategories"
        description="Organize the catalog into categories and subcategories."
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search categories…"
                className="w-48 pl-9 sm:w-64"
                aria-label="Search categories and subcategories"
              />
            </div>
            {canManage ? (
              <Button onClick={() => setCatDialog({ open: true, editing: null })} leftIcon={<FolderPlus className="h-4 w-4" />}>
                New category
              </Button>
            ) : null}
          </div>
        }
      />

      {!canView ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don’t have permission to view categories.
          </CardContent>
        </Card>
      ) : (
        <>
          {error ? <p className="text-sm text-danger">{error}</p> : null}

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 text-right font-medium">Subcategories</th>
                    <th className="px-4 py-3 text-right font-medium">Products</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-center font-medium">Order</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                        Loading categories…
                      </td>
                    </tr>
                  ) : visibleCategories.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                        {searching ? 'No categories match your search.' : 'No categories yet.'}
                      </td>
                    </tr>
                  ) : (
                    visibleCategories.map((cat) => {
                      const index = categories.indexOf(cat);
                      const isOpen = expanded.has(cat.id) || searching;
                      return (
                        <React.Fragment key={cat.id}>
                          <tr className="border-b border-border last:border-0 hover:bg-muted/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => toggleExpand(cat.id)}
                                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                                  aria-expanded={isOpen}
                                  className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
                                >
                                  {isOpen ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </button>
                                <div className="min-w-0">
                                  <div className="font-medium text-foreground">{cat.name}</div>
                                  {cat.description ? (
                                    <div className="truncate text-xs text-muted-foreground">
                                      {cat.description}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-muted-foreground">
                              {cat.subcategoryCount}
                            </td>
                            <td className="px-4 py-3 text-right text-muted-foreground">
                              {cat.productCount}
                            </td>
                            <td className="px-4 py-3">
                              {cat.isActive ? (
                                <Badge variant="success">Active</Badge>
                              ) : (
                                <Badge variant="danger">Inactive</Badge>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-center gap-1">
                                {canManage && !searching ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label="Move up"
                                      disabled={index === 0 || busy}
                                      onClick={() => moveCategory(index, -1)}
                                    >
                                      <ArrowUp className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label="Move down"
                                      disabled={index === categories.length - 1 || busy}
                                      onClick={() => moveCategory(index, 1)}
                                    >
                                      <ArrowDown className="h-4 w-4" />
                                    </Button>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">{cat.sortOrder}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-1">
                                {canManage ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8"
                                      aria-label="Add subcategory"
                                      onClick={() =>
                                        setSubDialog({
                                          open: true,
                                          editing: null,
                                          categoryId: cat.id,
                                        })
                                      }
                                    >
                                      <Plus className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8"
                                      aria-label="Edit category"
                                      onClick={() => setCatDialog({ open: true, editing: cat })}
                                    >
                                      <Pencil className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className={cn(
                                        'h-8 w-8',
                                        cat.isActive ? 'text-danger' : 'text-success',
                                      )}
                                      aria-label={cat.isActive ? 'Deactivate' : 'Reactivate'}
                                      disabled={busy}
                                      onClick={() =>
                                        runMutation(() =>
                                          cat.isActive
                                            ? deactivateCategory(session, cat.id)
                                            : reactivateCategory(session, cat.id),
                                        )
                                      }
                                    >
                                      {cat.isActive ? (
                                        <Ban className="h-4 w-4" />
                                      ) : (
                                        <RotateCcw className="h-4 w-4" />
                                      )}
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </td>
                          </tr>

                          {isOpen ? (
                            <tr className="border-b border-border bg-muted/20 last:border-0">
                              <td colSpan={6} className="px-4 pb-4 pt-0">
                                <SubcategoryList
                                  category={cat}
                                  canManage={canManage}
                                  busy={busy}
                                  onEdit={(sub) =>
                                    setSubDialog({ open: true, editing: sub, categoryId: cat.id })
                                  }
                                  onToggleActive={(sub) =>
                                    runMutation(() =>
                                      sub.isActive
                                        ? deactivateSubcategory(session, sub.id)
                                        : reactivateSubcategory(session, sub.id),
                                    )
                                  }
                                  onAdd={() =>
                                    setSubDialog({ open: true, editing: null, categoryId: cat.id })
                                  }
                                />
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <CategoryFormDialog
        open={catDialog.open}
        editing={catDialog.editing}
        categories={categories}
        onClose={() => setCatDialog({ open: false, editing: null })}
        onSubmit={submitCategory}
      />
      <SubcategoryFormDialog
        open={subDialog.open}
        editing={subDialog.editing}
        categories={categories}
        defaultCategoryId={subDialog.categoryId}
        onClose={() => setSubDialog({ open: false, editing: null, categoryId: '' })}
        onSubmit={submitSubcategory}
      />
    </div>
  );
}

function SubcategoryList({
  category,
  canManage,
  busy,
  onEdit,
  onToggleActive,
  onAdd,
}: {
  category: CategoryNode;
  canManage: boolean;
  busy: boolean;
  onEdit: (sub: Subcategory) => void;
  onToggleActive: (sub: Subcategory) => void;
  onAdd: () => void;
}) {
  if (category.subcategories.length === 0) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
        <span className="text-xs text-muted-foreground">No subcategories yet.</span>
        {canManage ? (
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus className="h-4 w-4" /> Add subcategory
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {category.subcategories.map((sub) => (
        <div
          key={sub.id}
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">{sub.name}</span>
            {!sub.isActive ? <Badge variant="danger">Inactive</Badge> : null}
            <span className="text-xs text-muted-foreground">{sub.productCount} products</span>
          </div>
          {canManage ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Edit subcategory"
                onClick={() => onEdit(sub)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-8 w-8', sub.isActive ? 'text-danger' : 'text-success')}
                aria-label={sub.isActive ? 'Deactivate' : 'Reactivate'}
                disabled={busy}
                onClick={() => onToggleActive(sub)}
              >
                {sub.isActive ? <Ban className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Both dialogs validate against the same rules, so they share one validator.
 *
 * `takenNames` is pre-scoped by the caller because the two levels are unique
 * over different sets: a category name is unique tenant-wide, a subcategory
 * name only within its parent. Lowercased on both sides — the server compares
 * case-insensitively, so accepting "Power Tools" next to "power tools" here
 * would only move the rejection to the 409.
 */
function validateTaxonomyFields(values: {
  name: string;
  description: string;
  sortOrder: string;
  takenNames: Set<string>;
}): TaxonomyErrors {
  const errors: TaxonomyErrors = {};

  const name = values.name.trim();
  if (!name) {
    errors.name = 'Name is required';
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
  } else if (values.takenNames.has(name.toLowerCase())) {
    errors.name = `“${name}” already exists`;
  }

  if (values.description.trim().length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`;
  }

  // Blank is legitimate — it means "leave it at 0", which is what the payload
  // sends. Anything typed has to survive the DTO's @IsInt @Min(0) and the
  // column's int4 range; without this "abc" silently became 0, and a decimal
  // or a negative came back from the server as an unexplained 400.
  const sortOrder = values.sortOrder.trim();
  if (sortOrder) {
    const parsed = Number(sortOrder);
    if (!Number.isInteger(parsed)) {
      errors.sortOrder = 'Sort order must be a whole number';
    } else if (parsed < 0) {
      errors.sortOrder = 'Sort order cannot be negative';
    } else if (parsed > MAX_SORT_ORDER) {
      errors.sortOrder = `Sort order must be ${MAX_SORT_ORDER} or less`;
    }
  }

  return errors;
}

/** `0` for a blank box, matching the placeholder and the column default. */
function parseSortOrder(value: string): number {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : 0;
}

/** Character counter, rendered only near the ceiling so it doesn't nag. */
function lengthHint(value: string, max: number): React.ReactNode {
  if (value.length < max * 0.8) return null;
  return (
    <span className={value.length >= max ? 'text-warning' : undefined}>
      {value.length} / {max}
    </span>
  );
}

/**
 * Focus (and scroll to) the first field a blocked submit flagged.
 *
 * Keyed on a tick rather than on the error map so pressing Create twice with
 * the same fault re-focuses instead of sitting there looking inert.
 * `scrollIntoView` is feature-checked: jsdom does not implement it.
 */
function useFocusFirstInvalid(tick: number, bodyRef: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    if (tick === 0) return;
    const root = bodyRef.current;
    if (!root) return;
    const field = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = field ?? root.querySelector<HTMLElement>('[role="alert"]');
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    field?.focus({ preventScroll: true });
  }, [tick, bodyRef]);
}

/** Label row + inline error, the shape the product wizard's steps use. */
function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={htmlFor}>
          {label}
          {required ? (
            <span className="text-danger" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </Label>
        {/* Advisory only: the input's own maxLength is what enforces the cap,
            and a screen reader gets the limit from that. */}
        {hint ? (
          <span aria-hidden="true" className="text-[11px] text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CategoryFormDialog({
  open,
  editing,
  categories,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: CategoryNode | null;
  categories: CategoryNode[];
  onClose: () => void;
  onSubmit: (values: { name: string; description: string; sortOrder: number }) => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [submitTick, setSubmitTick] = React.useState(0);
  const bodyRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
      setSortOrder(String(editing?.sortOrder ?? 0));
      setSaving(false);
      setError(null);
      setSubmitted(false);
      setSubmitTick(0);
    }
  }, [open, editing]);

  // Every category the tenant already has, active or not — the server's
  // uniqueness check ignores isActive, so skipping inactive ones here would
  // let through a name the API then rejects.
  const takenNames = React.useMemo(
    () =>
      new Set(
        categories.filter((c) => c.id !== editing?.id).map((c) => c.name.trim().toLowerCase()),
      ),
    [categories, editing],
  );

  // Errors follow the values once the operator has pressed Create: a frozen
  // snapshot would leave a message standing under a field they just fixed.
  const errors = React.useMemo(
    () => (submitted ? validateTaxonomyFields({ name, description, sortOrder, takenNames }) : {}),
    [submitted, name, description, sortOrder, takenNames],
  );

  useFocusFirstInvalid(submitTick, bodyRef);

  const submit = async () => {
    setSubmitted(true);
    setSubmitTick((tick) => tick + 1);
    const found = validateTaxonomyFields({ name, description, sortOrder, takenNames });
    if (Object.keys(found).length > 0) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        sortOrder: parseSortOrder(sortOrder),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save category');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit category' : 'New category'}
      description={editing ? 'Update this category’s details.' : 'Create a new top-level category.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {/* Deliberately not disabled on an empty name: a dead button gives
              the operator nothing to act on, where a blocked submit points at
              the field and says what is wrong with it. */}
          <Button onClick={submit} isLoading={saving}>
            {editing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <div ref={bodyRef} className="space-y-4">
        <Field
          label="Name"
          htmlFor="cat-name"
          required
          error={errors.name}
          hint={lengthHint(name, MAX_NAME_LENGTH)}
        >
          <Input
            id="cat-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Power Tools"
            maxLength={MAX_NAME_LENGTH}
            aria-invalid={!!errors.name}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="cat-desc"
          error={errors.description}
          hint={lengthHint(description, MAX_DESCRIPTION_LENGTH)}
        >
          <Textarea
            id="cat-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            rows={3}
            maxLength={MAX_DESCRIPTION_LENGTH}
            aria-invalid={!!errors.description}
          />
        </Field>
        <Field label="Sort order" htmlFor="cat-sort" error={errors.sortOrder}>
          <Input
            id="cat-sort"
            inputMode="numeric"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="0"
            aria-invalid={!!errors.sortOrder}
          />
        </Field>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function SubcategoryFormDialog({
  open,
  editing,
  categories,
  defaultCategoryId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: Subcategory | null;
  categories: CategoryNode[];
  defaultCategoryId: string;
  onClose: () => void;
  onSubmit: (values: {
    categoryId: string;
    name: string;
    description: string;
    sortOrder: number;
  }) => Promise<void>;
}) {
  const [categoryId, setCategoryId] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [submitTick, setSubmitTick] = React.useState(0);
  const bodyRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open) {
      setCategoryId(editing?.categoryId ?? defaultCategoryId);
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
      setSortOrder(String(editing?.sortOrder ?? 0));
      setSaving(false);
      setError(null);
      setSubmitted(false);
      setSubmitTick(0);
    }
  }, [open, editing, defaultCategoryId]);

  // Scoped to the parent currently selected, not the one being edited away
  // from: on a move it is the destination the server checks for a clash.
  const takenNames = React.useMemo(() => {
    const parent = categories.find((c) => c.id === categoryId);
    return new Set(
      (parent?.subcategories ?? [])
        .filter((s) => s.id !== editing?.id)
        .map((s) => s.name.trim().toLowerCase()),
    );
  }, [categories, categoryId, editing]);

  const validate = React.useCallback((): TaxonomyErrors => {
    const found = validateTaxonomyFields({ name, description, sortOrder, takenNames });
    if (!categoryId) found.categoryId = 'A parent category is required';
    return found;
  }, [name, description, sortOrder, takenNames, categoryId]);

  const errors = React.useMemo(
    () => (submitted ? validate() : ({} as TaxonomyErrors)),
    [submitted, validate],
  );

  useFocusFirstInvalid(submitTick, bodyRef);

  const submit = async () => {
    setSubmitted(true);
    setSubmitTick((tick) => tick + 1);
    const found = validate();
    if (Object.keys(found).length > 0) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        categoryId,
        name: name.trim(),
        description: description.trim(),
        sortOrder: parseSortOrder(sortOrder),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save subcategory');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit subcategory' : 'New subcategory'}
      description={
        editing ? 'Update or move this subcategory.' : 'Add a subcategory under a category.'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving}>
            {editing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <div ref={bodyRef} className="space-y-4">
        <Field label="Parent category" htmlFor="sub-cat" required error={errors.categoryId}>
          <Select
            id="sub-cat"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            aria-invalid={!!errors.categoryId}
          >
            <option value="" disabled>
              Select a category
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          {editing ? (
            <p className="text-xs text-muted-foreground">
              Changing the parent category moves this subcategory.
            </p>
          ) : null}
        </Field>
        <Field
          label="Name"
          htmlFor="sub-name"
          required
          error={errors.name}
          hint={lengthHint(name, MAX_NAME_LENGTH)}
        >
          <Input
            id="sub-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Cordless Drills"
            maxLength={MAX_NAME_LENGTH}
            aria-invalid={!!errors.name}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="sub-desc"
          error={errors.description}
          hint={lengthHint(description, MAX_DESCRIPTION_LENGTH)}
        >
          <Textarea
            id="sub-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            rows={3}
            maxLength={MAX_DESCRIPTION_LENGTH}
            aria-invalid={!!errors.description}
          />
        </Field>
        <Field label="Sort order" htmlFor="sub-sort" error={errors.sortOrder}>
          <Input
            id="sub-sort"
            inputMode="numeric"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="0"
            aria-invalid={!!errors.sortOrder}
          />
        </Field>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
