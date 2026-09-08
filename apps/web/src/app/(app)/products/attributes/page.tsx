'use client';

/**
 * D125 / D125a — the tenant option library (Phase 5, `5.1` / `5.2`).
 *
 * This screen exists because D125 decided the migration of existing per-product
 * dimensions is a UI task, not a SQL backfill: whether `Colour` or `Color` wins
 * is a judgement nobody should make in a migration script, and eleven dimension
 * rows across two tenants is small enough for an operator to map by hand.
 *
 * The code preview uses the SAME shared functions the API validates with, so
 * what this form shows and what the server accepts cannot drift apart — the
 * structural answer to the defect Phase 4 shipped three times.
 */

import * as React from 'react';
import { AlertTriangle, Palette, Plus, Save, Trash2, X } from 'lucide-react';
import {
  attributeCodeIssue,
  normaliseAttributeCode,
  normaliseSwatchHex,
  suggestAttributeCode,
} from '@hardware-pos/shared';

import { PageHeader } from '@/components/page-header';
import { InventoryTabs } from '@/components/products/inventory-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Toast, type ToastTone } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { fetchCategoryTree, type CategoryNode } from '@/lib/products-api';
import {
  createAttributeDefinition,
  deleteAttributeDefinition,
  fetchAttributeLibrary,
  updateAttributeDefinition,
  type AttributeDefinition,
} from '@/lib/products/attribute-library-api';

interface OptionDraft {
  name: string;
  code: string;
  swatchHex: string;
}

interface EditorState {
  open: boolean;
  editing: AttributeDefinition | null;
  name: string;
  categoryId: string;
  options: OptionDraft[];
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  editing: null,
  name: '',
  categoryId: '',
  options: [{ name: '', code: '', swatchHex: '' }],
};

export default function AttributeLibraryPage() {
  const { session, hasPermission } = useAuth();
  const canView = hasPermission(Permission.PRODUCT_READ);
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);

  const [definitions, setDefinitions] = React.useState<AttributeDefinition[]>([]);
  const [categories, setCategories] = React.useState<CategoryNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editor, setEditor] = React.useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = React.useState(false);
  const [toast, setToast] = React.useState<{ message: string; tone: ToastTone } | null>(
    null,
  );

  // `Toast` renders a message and nothing else — no dismiss affordance — so the
  // page owns how long it stays. Cleared on unmount so a navigation mid-timer
  // does not set state on a component that is gone.
  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const load = React.useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [library, tree] = await Promise.all([
        fetchAttributeLibrary(session),
        fetchCategoryTree(session).catch(() => [] as CategoryNode[]),
      ]);
      setDefinitions(library);
      setCategories(tree);
    } catch (err) {
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setLoading(false);
    }
  }, [session]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditor({ ...EMPTY_EDITOR, open: true });
  }

  function openEdit(definition: AttributeDefinition) {
    setEditor({
      open: true,
      editing: definition,
      name: definition.name,
      categoryId: definition.categoryId ?? '',
      options: definition.options.map((o) => ({
        name: o.name,
        code: o.code,
        swatchHex: o.swatchHex ?? '',
      })),
    });
  }

  /**
   * The code follows the name only while the operator has not typed a code of
   * their own. Overwriting a deliberate `BLK` because someone corrected a typo
   * in `Black` would change a SKU segment behind their back.
   */
  function setOptionName(index: number, name: string) {
    setEditor((prev) => {
      const options = [...prev.options];
      const current = options[index]!;
      const wasSuggested = current.code === suggestAttributeCode(current.name);
      options[index] = {
        ...current,
        name,
        code: wasSuggested ? suggestAttributeCode(name) : current.code,
      };
      return { ...prev, options };
    });
  }

  function setOptionField(index: number, field: 'code' | 'swatchHex', value: string) {
    setEditor((prev) => {
      const options = [...prev.options];
      options[index] = { ...options[index]!, [field]: value };
      return { ...prev, options };
    });
  }

  const optionIssues = editor.options.map((option) => {
    if (option.name.trim() === '' && option.code.trim() === '') return null;
    if (option.name.trim() === '') return 'This option needs a name.';
    const issue = attributeCodeIssue(normaliseAttributeCode(option.code));
    if (issue) return issue;
    if (option.swatchHex.trim() !== '' && normaliseSwatchHex(option.swatchHex) === null) {
      return 'Use #RRGGBB, for example #1A1A1A.';
    }
    return null;
  });

  const filledOptions = editor.options.filter((o) => o.name.trim() !== '');
  const canSave =
    editor.name.trim() !== '' && filledOptions.length > 0 && optionIssues.every((i) => i === null);

  async function save() {
    if (!session || !canSave) return;
    setSaving(true);
    try {
      const payload = {
        name: editor.name.trim(),
        categoryId: editor.categoryId === '' ? null : editor.categoryId,
        options: filledOptions.map((o, index) => ({
          name: o.name.trim(),
          code: normaliseAttributeCode(o.code),
          position: index,
          swatchHex: o.swatchHex.trim() === '' ? null : normaliseSwatchHex(o.swatchHex),
        })),
      };
      if (editor.editing) {
        await updateAttributeDefinition(session, editor.editing.id, payload);
      } else {
        await createAttributeDefinition(session, payload);
      }
      setEditor(EMPTY_EDITOR);
      setToast({ message: 'Attribute saved.', tone: 'success' });
      await load();
    } catch (err) {
      setToast({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  async function remove(definition: AttributeDefinition) {
    if (!session) return;
    try {
      await deleteAttributeDefinition(session, definition.id);
      setToast({ message: `Deleted "${definition.name}".`, tone: 'success' });
      await load();
    } catch (err) {
      // The server refuses while any product points at it, and names the
      // count. Surfacing that message verbatim is the whole point.
      setToast({ message: (err as Error).message, tone: 'danger' });
    }
  }

  if (!canView) {
    return <PageHeader title="Attributes" description="You do not have access to the catalogue." />;
  }

  return (
    <div className="space-y-4">
      <InventoryTabs />
      <PageHeader
        title="Attribute library"
        description="Size and colour scales defined once and shared by every product that adopts them. A product keeps working whether or not it is mapped."
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> New attribute
            </Button>
          ) : null
        }
      />

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      ) : definitions.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 py-10 text-center">
            <p className="text-sm font-medium">No attributes yet.</p>
            <p className="text-sm text-muted-foreground">
              Until a product&apos;s dimension is mapped to one of these, its SKU segment is derived
              from the option name — correct today, and it changes if the option is renamed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {definitions.map((definition) => (
            <Card key={definition.id}>
              <CardContent className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">{definition.name}</span>
                    {definition.categoryName ? (
                      <Badge variant="primary">{definition.categoryName}</Badge>
                    ) : (
                      <Badge variant="neutral">All categories</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {definition.linkedDimensionCount === 0
                        ? 'Not used by any product yet'
                        : `Used by ${definition.linkedDimensionCount} product dimension${definition.linkedDimensionCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  {canManage ? (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(definition)}>
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void remove(definition)}
                        disabled={definition.linkedDimensionCount > 0}
                        title={
                          definition.linkedDimensionCount > 0
                            ? 'Unmap it from every product before deleting it.'
                            : undefined
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {definition.options.map((option) => (
                    <span
                      key={option.id}
                      className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                    >
                      {option.swatchHex ? (
                        <span
                          className="h-3 w-3 rounded-full border"
                          style={{ backgroundColor: option.swatchHex }}
                          aria-hidden
                        />
                      ) : null}
                      <span>{option.name}</span>
                      <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{option.code}</code>
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editor.open}
        onClose={() => setEditor(EMPTY_EDITOR)}
        title={editor.editing ? `Edit ${editor.editing.name}` : 'New attribute'}
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="attr-name">Name</Label>
              <Input
                id="attr-name"
                value={editor.name}
                placeholder="Size — apparel"
                onChange={(e) => setEditor((prev) => ({ ...prev, name: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Two scales need two names. &quot;Size — apparel&quot; and &quot;Size — footwear&quot;
                are different scales, not one.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="attr-category">Category</Label>
              <Select
                id="attr-category"
                value={editor.categoryId}
                onChange={(e) => setEditor((prev) => ({ ...prev, categoryId: e.target.value }))}
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                A hint for what the picker offers first — never a restriction.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Options</Label>
              <span className="text-xs text-muted-foreground">
                The code becomes part of every generated SKU.
              </span>
            </div>

            {editor.options.map((option, index) => (
              <div key={index} className="space-y-1">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={`Option ${index + 1} name`}
                    placeholder="Black"
                    value={option.name}
                    onChange={(e) => setOptionName(index, e.target.value)}
                  />
                  <Input
                    aria-label={`Option ${index + 1} code`}
                    className="w-28 font-mono uppercase"
                    placeholder="BLK"
                    value={option.code}
                    onChange={(e) => setOptionField(index, 'code', e.target.value)}
                  />
                  <div className="flex w-32 items-center gap-1">
                    <Palette className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <Input
                      aria-label={`Option ${index + 1} colour`}
                      className="font-mono"
                      placeholder="#1A1A1A"
                      value={option.swatchHex}
                      onChange={(e) => setOptionField(index, 'swatchHex', e.target.value)}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove option ${index + 1}`}
                    onClick={() =>
                      setEditor((prev) => ({
                        ...prev,
                        options: prev.options.filter((_, i) => i !== index),
                      }))
                    }
                    disabled={editor.options.length === 1}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {optionIssues[index] ? (
                  <p className="flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    {optionIssues[index]}
                  </p>
                ) : option.code.trim() !== '' &&
                  normaliseAttributeCode(option.code) !== option.code ? (
                  <p className="text-xs text-muted-foreground">
                    Will be stored as{' '}
                    <code className="font-mono">{normaliseAttributeCode(option.code)}</code>
                  </p>
                ) : null}
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setEditor((prev) => ({
                  ...prev,
                  options: [...prev.options, { name: '', code: '', swatchHex: '' }],
                }))
              }
            >
              <Plus className="mr-2 h-4 w-4" /> Add option
            </Button>
          </div>

          {editor.editing && editor.editing.linkedDimensionCount > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              This attribute is mapped to {editor.editing.linkedDimensionCount} product dimension
              {editor.editing.linkedDimensionCount === 1 ? '' : 's'}. Removing an option that a
              product still uses will be refused.
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditor(EMPTY_EDITOR)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!canSave || saving}>
              <Save className="mr-2 h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Dialog>

      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </div>
  );
}
