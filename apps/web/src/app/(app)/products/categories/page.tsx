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
import { SharedSubcategoryLibrary } from '@/components/products/shared-subcategory-library';
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

          <SharedSubcategoryLibrary
            categories={categories.map((c) => ({ id: c.id, name: c.name }))}
            canManage={canManage}
          />
        </>
      )}

      <CategoryFormDialog
        open={catDialog.open}
        editing={catDialog.editing}
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

function CategoryFormDialog({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: CategoryNode | null;
  onClose: () => void;
  onSubmit: (values: { name: string; description: string; sortOrder: number }) => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
      setSortOrder(String(editing?.sortOrder ?? 0));
      setSaving(false);
      setError(null);
    }
  }, [open, editing]);

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        sortOrder: Number(sortOrder) || 0,
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
          <Button onClick={submit} disabled={!name.trim()} isLoading={saving}>
            {editing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="cat-name">Name *</Label>
          <Input
            id="cat-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Power Tools"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cat-desc">Description</Label>
          <Textarea
            id="cat-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            rows={3}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cat-sort">Sort order</Label>
          <Input
            id="cat-sort"
            inputMode="numeric"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="0"
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
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

  React.useEffect(() => {
    if (open) {
      setCategoryId(editing?.categoryId ?? defaultCategoryId);
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
      setSortOrder(String(editing?.sortOrder ?? 0));
      setSaving(false);
      setError(null);
    }
  }, [open, editing, defaultCategoryId]);

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!categoryId) {
      setError('A parent category is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        categoryId,
        name: name.trim(),
        description: description.trim(),
        sortOrder: Number(sortOrder) || 0,
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
          <Button onClick={submit} disabled={!name.trim()} isLoading={saving}>
            {editing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sub-cat">Parent category</Label>
          <Select id="sub-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sub-name">Name *</Label>
          <Input
            id="sub-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Cordless Drills"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sub-desc">Description</Label>
          <Textarea
            id="sub-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            rows={3}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sub-sort">Sort order</Label>
          <Input
            id="sub-sort"
            inputMode="numeric"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="0"
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
