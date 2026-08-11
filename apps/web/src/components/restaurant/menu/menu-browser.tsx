'use client';

import { ChevronRight, MoreVertical, Package, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import type { ManagedProduct } from '@/lib/products-api';
import {
  menuItems as menuItemsApi,
  menuSections as menuSectionsApi,
  menus as menusApi,
} from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type {
  MenuItemView,
  MenuView,
  SectionView,
} from '@/lib/restaurant/types';
import { StatusBadge } from '@/components/restaurant/status-badge';

import { AddItemChoiceDialog, type AddItemChoice } from './item-add/add-item-choice-dialog';
import { LinkedProductDialog } from './item-add/linked-product-dialog';
import { PreparedDishDialog } from './item-add/prepared-dish-dialog';
import { ProductSelectorDialog } from './item-add/product-selector-dialog';

interface Props {
  session: Session;
  branchId: string;
  canManage: boolean;
}

/**
 * Three-column menu browser: menus → sections → items.
 *
 * Selection state is deliberately local: opening a menu reveals its sections,
 * opening a section reveals its items. Fetches are lazy and cached against
 * the current selection, so a menu with a hundred sections doesn't load every
 * item on first click.
 */
export function MenuBrowser({ session, branchId, canManage }: Props) {
  const [menus, setMenus] = React.useState<MenuView[] | null>(null);
  const [menuError, setMenuError] = React.useState<string | null>(null);
  const [selectedMenuId, setSelectedMenuId] = React.useState<string | null>(null);
  const [sections, setSections] = React.useState<SectionView[] | null>(null);
  const [sectionsError, setSectionsError] = React.useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<MenuItemView[] | null>(null);
  const [itemsError, setItemsError] = React.useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = React.useState(false);
  const [showNewSection, setShowNewSection] = React.useState(false);
  /**
   * Add-item flow state machine (Pilot Change 4):
   *   `null`         — flow closed
   *   `'CHOICE'`     — the "Prepared Dish vs Existing Product" dialog is open
   *   `'PREPARED'`   — prepared-dish form is open
   *   `'PICK_PRODUCT'` — product selector dialog is open
   *   `'LINK_PRODUCT'` — linked-product form is open (holds the picked product)
   */
  type AddStage =
    | null
    | { kind: 'CHOICE' }
    | { kind: 'PREPARED' }
    | { kind: 'PICK_PRODUCT' }
    | { kind: 'LINK_PRODUCT'; product: ManagedProduct };
  const [addStage, setAddStage] = React.useState<AddStage>(null);
  // Delete-confirmation state — D42 archive semantics.
  const [pendingDelete, setPendingDelete] = React.useState<MenuItemView | null>(null);

  const loadMenus = React.useCallback(async () => {
    setMenuError(null);
    try {
      const rows = await menusApi.list(session, branchId, true);
      setMenus(rows);
      const first = rows[0];
      if (first && !selectedMenuId) setSelectedMenuId(first.id);
    } catch (err) {
      setMenuError(err instanceof Error ? err.message : 'Failed to load menus');
      setMenus([]);
    }
  }, [session, branchId, selectedMenuId]);

  const loadSections = React.useCallback(
    async (menuId: string) => {
      setSectionsError(null);
      setSections(null);
      try {
        const rows = await menuSectionsApi.list(session, menuId);
        setSections(rows);
      } catch (err) {
        setSectionsError(err instanceof Error ? err.message : 'Failed to load sections');
        setSections([]);
      }
    },
    [session],
  );

  const loadItems = React.useCallback(
    async (sectionId: string) => {
      setItemsError(null);
      setItems(null);
      try {
        const rows = await menuItemsApi.list(session, sectionId, true);
        setItems(rows);
      } catch (err) {
        setItemsError(err instanceof Error ? err.message : 'Failed to load items');
        setItems([]);
      }
    },
    [session],
  );

  React.useEffect(() => {
    void loadMenus();
  }, [loadMenus]);

  React.useEffect(() => {
    if (selectedMenuId) {
      void loadSections(selectedMenuId);
      setSelectedSectionId(null);
      setItems(null);
    }
  }, [selectedMenuId, loadSections]);

  React.useEffect(() => {
    if (selectedSectionId) void loadItems(selectedSectionId);
  }, [selectedSectionId, loadItems]);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {/* Menus column */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Menus</CardTitle>
          {canManage ? (
            <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowNewMenu(true)}>
              New
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {menus === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : menuError ? (
            <p className="py-6 text-center text-sm text-danger">{menuError}</p>
          ) : menus.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No menus yet.{' '}
              {canManage ? 'Create one to get started.' : 'Ask an administrator to create one.'}
            </p>
          ) : (
            menus.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedMenuId(m.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border p-3 text-left transition-colors ${
                  selectedMenuId === m.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted'
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{m.name}</p>
                  {m.description ? (
                    <p className="truncate text-xs text-muted-foreground">{m.description}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {!m.isActive ? (
                    <StatusBadge label="Inactive" tone="muted" />
                  ) : null}
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      {/* Sections column */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Sections</CardTitle>
          {canManage && selectedMenuId ? (
            <Button
              size="sm"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setShowNewSection(true)}
            >
              New
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {!selectedMenuId ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Pick a menu to see its sections.
            </p>
          ) : sections === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : sectionsError ? (
            <p className="py-6 text-center text-sm text-danger">{sectionsError}</p>
          ) : sections.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No sections yet in this menu.
            </p>
          ) : (
            sections
              .slice()
              .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSectionId(s.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl border p-3 text-left transition-colors ${
                    selectedSectionId === s.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{s.name}</p>
                    {s.description ? (
                      <p className="truncate text-xs text-muted-foreground">{s.description}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {!s.isActive ? <StatusBadge label="Inactive" tone="muted" /> : null}
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </div>
                </button>
              ))
          )}
        </CardContent>
      </Card>

      {/* Items column */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Items</CardTitle>
          {canManage && selectedSectionId ? (
            <Button
              size="sm"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setAddStage({ kind: 'CHOICE' })}
            >
              New
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {!selectedSectionId ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Pick a section to see its items.
            </p>
          ) : items === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : itemsError ? (
            <p className="py-6 text-center text-sm text-danger">{itemsError}</p>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No items in this section yet.
            </p>
          ) : (
            items
              .slice()
              .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
              .map((it) => (
                <MenuItemCard
                  key={it.id}
                  item={it}
                  canManage={canManage}
                  onDelete={() => setPendingDelete(it)}
                />
              ))
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      {canManage && showNewMenu ? (
        <NewMenuDialog
          onClose={() => setShowNewMenu(false)}
          onCreated={async (menu) => {
            setShowNewMenu(false);
            await loadMenus();
            setSelectedMenuId(menu.id);
          }}
          session={session}
          branchId={branchId}
        />
      ) : null}
      {canManage && showNewSection && selectedMenuId ? (
        <NewSectionDialog
          onClose={() => setShowNewSection(false)}
          onCreated={async (section) => {
            setShowNewSection(false);
            await loadSections(selectedMenuId);
            setSelectedSectionId(section.id);
          }}
          session={session}
          menuId={selectedMenuId}
        />
      ) : null}
      {canManage && addStage && selectedSectionId ? (
        <AddItemFlow
          stage={addStage}
          session={session}
          sectionId={selectedSectionId}
          onStage={setAddStage}
          onCreated={async () => {
            setAddStage(null);
            await loadItems(selectedSectionId);
          }}
        />
      ) : null}
      {canManage && pendingDelete && selectedSectionId ? (
        <DeleteMenuItemDialog
          item={pendingDelete}
          session={session}
          sectionId={selectedSectionId}
          onClose={() => setPendingDelete(null)}
          onDone={async () => {
            setPendingDelete(null);
            await loadItems(selectedSectionId);
          }}
        />
      ) : null}
    </div>
  );
}

// ── MenuItemCard ─────────────────────────────────────────────────────────

function MenuItemCard({
  item,
  canManage,
  onDelete,
}: {
  item: MenuItemView;
  canManage: boolean;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [menuOpen]);

  return (
    <div
      className={`group relative flex items-start justify-between gap-3 rounded-xl border border-border p-3 transition-colors hover:border-primary motion-reduce:transition-none ${
        item.isActive ? '' : 'opacity-70'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{item.name}</p>
          {item.productId ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="Linked to an inventory product — stock is tracked by that product"
            >
              <Package className="h-3 w-3" aria-hidden="true" />
              Inventory linked
            </span>
          ) : null}
          {item.modifierGroupIds.length > 0 ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title="This item has modifier groups"
            >
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {item.modifierGroupIds.length}
            </span>
          ) : null}
        </div>
        {item.description ? (
          <p className="truncate text-xs text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <p className="text-sm font-semibold">{formatMoney(item.basePrice)}</p>
        {!item.isActive ? <StatusBadge label="Unavailable" tone="muted" /> : null}
      </div>

      {canManage ? (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={`Actions for ${item.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 motion-reduce:transition-none"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-10 mt-1 w-40 rounded-lg border border-border bg-popover p-1 shadow-pop"
            >
              <Link
                role="menuitem"
                href={`/menu/items/${item.id}/edit`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                onClick={() => setMenuOpen(false)}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-danger hover:bg-danger-soft focus-visible:bg-danger-soft focus-visible:outline-none"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete item
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── DeleteMenuItemDialog — archive semantics per D42 ──────────────────────

function DeleteMenuItemDialog({
  item,
  session,
  sectionId,
  onClose,
  onDone,
}: {
  item: MenuItemView;
  session: Session;
  sectionId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await menuItemsApi.update(session, sectionId, item.id, { isActive: false });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove item');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${item.name}?`}
      description={undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} isLoading={busy}>
            Delete item
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <p className="text-sm">
          This item will no longer be available for new orders.
        </p>
        <p className="text-xs text-muted-foreground">
          Historical orders, kitchen tickets, bills and reports for
          <span className="mx-1 font-medium text-foreground">{item.name}</span>
          remain unchanged — the item is archived, not deleted from history.
        </p>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// ── Dialogs ───────────────────────────────────────────────────────────────

function NewMenuDialog({
  onClose,
  onCreated,
  session,
  branchId,
}: {
  onClose: () => void;
  onCreated: (menu: MenuView) => void;
  session: Session;
  branchId: string;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await menusApi.create(session, branchId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create menu');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New menu"
      description="A menu belongs to a branch and holds sections and items."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!name.trim()}>
            Create menu
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="menu-name">
            Name
          </label>
          <Input
            id="menu-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lunch"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="menu-desc">
            Description
          </label>
          <Textarea
            id="menu-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional short summary shown to staff."
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function NewSectionDialog({
  onClose,
  onCreated,
  session,
  menuId,
}: {
  onClose: () => void;
  onCreated: (section: SectionView) => void;
  session: Session;
  menuId: string;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await menuSectionsApi.create(session, menuId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create section');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New section"
      description="Sections group items on a menu (e.g. Starters, Mains, Drinks)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!name.trim()}>
            Create section
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="section-name">
            Name
          </label>
          <Input
            id="section-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mains"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="section-desc">
            Description
          </label>
          <Textarea
            id="section-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional summary."
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

// The old `NewItemDialog` was replaced by the multi-step flow — see
// `AddItemFlow` below and the three step components in `./item-add/`.

type AddStage =
  | { kind: 'CHOICE' }
  | { kind: 'PREPARED' }
  | { kind: 'PICK_PRODUCT' }
  | { kind: 'LINK_PRODUCT'; product: ManagedProduct };

/**
 * The four-step add-menu-item flow (Pilot Change 4). Kept as a single
 * component so the state transitions between the choice dialog, the two
 * form dialogs, and the product selector all live in one place — the
 * transitions have "Back" semantics and it's important they always land
 * on the right previous step.
 */
function AddItemFlow({
  stage,
  session,
  sectionId,
  onStage,
  onCreated,
}: {
  stage: AddStage;
  session: Session;
  sectionId: string;
  onStage: (next: AddStage | null) => void;
  onCreated: () => void;
}) {
  if (stage.kind === 'CHOICE') {
    return (
      <AddItemChoiceDialog
        onChoose={(choice: AddItemChoice) =>
          onStage(
            choice === 'PREPARED' ? { kind: 'PREPARED' } : { kind: 'PICK_PRODUCT' },
          )
        }
        onClose={() => onStage(null)}
      />
    );
  }
  if (stage.kind === 'PREPARED') {
    return (
      <PreparedDishDialog
        session={session}
        sectionId={sectionId}
        onCreated={onCreated}
        onBack={() => onStage({ kind: 'CHOICE' })}
      />
    );
  }
  if (stage.kind === 'PICK_PRODUCT') {
    return (
      <ProductSelectorDialog
        session={session}
        onSelect={(product) => onStage({ kind: 'LINK_PRODUCT', product })}
        onBack={() => onStage({ kind: 'CHOICE' })}
      />
    );
  }
  // LINK_PRODUCT — the product has been picked; open the linked-product form.
  return (
    <LinkedProductDialog
      session={session}
      sectionId={sectionId}
      product={stage.product}
      onCreated={onCreated}
      onBack={() => onStage({ kind: 'PICK_PRODUCT' })}
    />
  );
}
