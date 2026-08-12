'use client';

import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Package,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
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
import {
  DeleteMenuDialog,
  DeleteSectionDialog,
  EditMenuDialog,
  EditSectionDialog,
} from './menu-crud-dialogs';
import { OverflowMenu, OverflowItem } from './overflow-menu';

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
  // Delete-confirmation state — D42 (updated this slice) — hard delete.
  const [pendingDelete, setPendingDelete] = React.useState<MenuItemView | null>(null);
  // Menu + Section CRUD state.
  const [editingMenu, setEditingMenu] = React.useState<MenuView | null>(null);
  const [deletingMenu, setDeletingMenu] = React.useState<MenuView | null>(null);
  const [editingSection, setEditingSection] = React.useState<SectionView | null>(null);
  const [deletingSection, setDeletingSection] = React.useState<SectionView | null>(null);
  // Items column filter state — stays inside the column so Menu/Section
  // selection remains stable while item results change.
  const [itemQuery, setItemQuery] = React.useState('');
  const [itemStatus, setItemStatus] = React.useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  // Inline mutation state — Set Active/Inactive optimistic + real POST.
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  const [toggleError, setToggleError] = React.useState<string | null>(null);

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
              <MenuRow
                key={m.id}
                menu={m}
                selected={selectedMenuId === m.id}
                canManage={canManage}
                onSelect={() => setSelectedMenuId(m.id)}
                onEdit={() => setEditingMenu(m)}
                onDelete={() => setDeletingMenu(m)}
              />
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
                <SectionRow
                  key={s.id}
                  section={s}
                  selected={selectedSectionId === s.id}
                  canManage={canManage}
                  onSelect={() => setSelectedSectionId(s.id)}
                  onEdit={() => setEditingSection(s)}
                  onDelete={() => setDeletingSection(s)}
                />
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
          {selectedSectionId ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search menu items"
                  placeholder="Search items…"
                  value={itemQuery}
                  onChange={(e) => setItemQuery(e.target.value)}
                  className="h-9 pl-8 text-sm"
                />
              </div>
              <div role="tablist" aria-label="Item status filter" className="inline-flex rounded-md border border-border">
                {(['ALL', 'ACTIVE', 'INACTIVE'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={itemStatus === s}
                    onClick={() => setItemStatus(s)}
                    className={`px-2.5 py-1.5 text-xs font-medium transition-colors first:rounded-l-md last:rounded-r-md motion-reduce:transition-none ${
                      itemStatus === s
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {s === 'ALL' ? 'All' : s === 'ACTIVE' ? 'Active' : 'Inactive'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {toggleError ? (
            <p className="text-xs text-danger" role="alert">
              {toggleError}
            </p>
          ) : null}
          {!selectedSectionId ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Pick a section to see its items.
            </p>
          ) : items === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : itemsError ? (
            <p className="py-6 text-center text-sm text-danger">{itemsError}</p>
          ) : (() => {
              const filtered = items
                .filter((it) => {
                  if (itemStatus === 'ACTIVE' && !it.isActive) return false;
                  if (itemStatus === 'INACTIVE' && it.isActive) return false;
                  if (itemQuery.trim()) {
                    const q = itemQuery.trim().toLowerCase();
                    if (!it.name.toLowerCase().includes(q)) return false;
                  }
                  return true;
                })
                .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
              if (items.length === 0) {
                return (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No items in this section yet.
                    {canManage ? ' Create one with the New button above.' : ''}
                  </div>
                );
              }
              if (filtered.length === 0) {
                return (
                  <div className="space-y-2 py-6 text-center text-sm text-muted-foreground">
                    <p>
                      {itemStatus === 'ACTIVE'
                        ? 'No active items match.'
                        : itemStatus === 'INACTIVE'
                          ? 'No inactive items match.'
                          : 'No items match.'}
                    </p>
                    {itemStatus !== 'ALL' ? (
                      <Button variant="ghost" size="sm" onClick={() => setItemStatus('ALL')}>
                        Show all statuses
                      </Button>
                    ) : null}
                  </div>
                );
              }
              return filtered.map((it) => (
                <MenuItemCard
                  key={it.id}
                  item={it}
                  canManage={canManage}
                  toggling={togglingId === it.id}
                  onToggleActive={async () => {
                    if (!selectedSectionId) return;
                    setTogglingId(it.id);
                    setToggleError(null);
                    try {
                      await menuItemsApi.update(session, selectedSectionId, it.id, {
                        isActive: !it.isActive,
                      });
                      await loadItems(selectedSectionId);
                    } catch (err) {
                      setToggleError(
                        err instanceof Error ? err.message : 'Failed to update item status',
                      );
                    } finally {
                      setTogglingId(null);
                    }
                  }}
                  onDelete={() => setPendingDelete(it)}
                />
              ));
            })()}
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
      {canManage && editingMenu ? (
        <EditMenuDialog
          session={session}
          branchId={branchId}
          menu={editingMenu}
          onClose={() => setEditingMenu(null)}
          onSaved={async () => {
            setEditingMenu(null);
            await loadMenus();
          }}
        />
      ) : null}
      {canManage && deletingMenu ? (
        <DeleteMenuDialog
          session={session}
          branchId={branchId}
          menu={deletingMenu}
          onClose={() => setDeletingMenu(null)}
          onDone={async () => {
            setDeletingMenu(null);
            if (selectedMenuId === deletingMenu.id) {
              setSelectedMenuId(null);
              setSelectedSectionId(null);
            }
            await loadMenus();
          }}
        />
      ) : null}
      {canManage && editingSection && selectedMenuId ? (
        <EditSectionDialog
          session={session}
          menuId={selectedMenuId}
          section={editingSection}
          onClose={() => setEditingSection(null)}
          onSaved={async () => {
            setEditingSection(null);
            await loadSections(selectedMenuId);
          }}
        />
      ) : null}
      {canManage && deletingSection && selectedMenuId ? (
        <DeleteSectionDialog
          session={session}
          menuId={selectedMenuId}
          section={deletingSection}
          onClose={() => setDeletingSection(null)}
          onDone={async () => {
            setDeletingSection(null);
            if (selectedSectionId === deletingSection.id) setSelectedSectionId(null);
            await loadSections(selectedMenuId);
          }}
        />
      ) : null}
    </div>
  );
}

// ── MenuRow (with ••• overflow) ──────────────────────────────────────────

function MenuRow({
  menu,
  selected,
  canManage,
  onSelect,
  onEdit,
  onDelete,
}: {
  menu: MenuView;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-start justify-between gap-2 rounded-xl border p-3 transition-colors motion-reduce:transition-none ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
      >
        <p className="truncate text-sm font-semibold">{menu.name}</p>
        {menu.description ? (
          <p className="truncate text-xs text-muted-foreground">{menu.description}</p>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {!menu.isActive ? <StatusBadge label="Inactive" tone="muted" /> : null}
        {canManage ? (
          <OverflowMenu label={`Actions for ${menu.name}`}>
            {({ close }) => (
              <>
                <OverflowItem
                  icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="Edit menu"
                  onClick={() => {
                    close();
                    onEdit();
                  }}
                />
                <OverflowItem
                  icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="Delete permanently"
                  tone="danger"
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                />
              </>
            )}
          </OverflowMenu>
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// ── SectionRow ───────────────────────────────────────────────────────────

function SectionRow({
  section,
  selected,
  canManage,
  onSelect,
  onEdit,
  onDelete,
}: {
  section: SectionView;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-start justify-between gap-2 rounded-xl border p-3 transition-colors motion-reduce:transition-none ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="truncate text-sm font-semibold">{section.name}</p>
        {section.description ? (
          <p className="truncate text-xs text-muted-foreground">{section.description}</p>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {!section.isActive ? <StatusBadge label="Inactive" tone="muted" /> : null}
        {canManage ? (
          <OverflowMenu label={`Actions for ${section.name}`}>
            {({ close }) => (
              <>
                <OverflowItem
                  icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="Edit section"
                  onClick={() => {
                    close();
                    onEdit();
                  }}
                />
                <OverflowItem
                  icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="Delete permanently"
                  tone="danger"
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                />
              </>
            )}
          </OverflowMenu>
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// ── MenuItemCard ─────────────────────────────────────────────────────────
// Restaurant Menu wizard follow-up (this slice): the overflow menu splits
// availability (Set Active / Set Inactive, PATCH isActive) from removal
// (Delete permanently, hard DELETE). Status text is always rendered — colour
// never carries the state alone (brief §6, §29).

function MenuItemCard({
  item,
  canManage,
  toggling,
  onToggleActive,
  onDelete,
}: {
  item: MenuItemView;
  canManage: boolean;
  toggling: boolean;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group relative flex items-start justify-between gap-3 rounded-xl border p-3 transition-colors motion-reduce:transition-none ${
        item.isActive
          ? 'border-border hover:border-primary'
          : 'border-border/60 bg-muted/20 opacity-80'
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
        {/* Status line — text + icon, never colour alone. */}
        <p
          className={`mt-1 inline-flex items-center gap-1 text-[11px] font-medium ${
            item.isActive ? 'text-success' : 'text-muted-foreground'
          }`}
        >
          {item.isActive ? (
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          ) : (
            <Circle className="h-3 w-3" aria-hidden="true" />
          )}
          {item.isActive ? 'Active' : 'Inactive'}
          {toggling ? <span className="ml-1 text-muted-foreground">· updating…</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <p className="text-sm font-semibold">{formatMoney(item.basePrice)}</p>
      </div>

      {canManage ? (
        <OverflowMenu label={`Actions for ${item.name}`} disabled={toggling}>
          {({ close }) => (
            <>
              <OverflowItem
                icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                label="Edit item"
                asChild={<Link href={`/menu/items/${item.id}/edit`} />}
                onClick={close}
              />
              <OverflowItem
                icon={
                  item.isActive ? (
                    <Circle className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )
                }
                label={item.isActive ? 'Set Inactive' : 'Set Active'}
                onClick={() => {
                  close();
                  onToggleActive();
                }}
              />
              <OverflowItem
                icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                label="Delete permanently"
                tone="danger"
                onClick={() => {
                  close();
                  onDelete();
                }}
              />
            </>
          )}
        </OverflowMenu>
      ) : null}
    </div>
  );
}

// ── DeleteMenuItemDialog — hard delete (D42 updated) ─────────────────────
// Historical RestaurantOrderItem / KitchenTicketItem rows snapshot the
// menuItemName/price at submit time and reference the item by a loose (non-FK)
// id, so a delete is domain-safe. The server refuses if the item is on any
// open order (DRAFT / SUBMITTED / PARTIAL); that 409 surfaces here.

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
      await menuItemsApi.remove(session, sectionId, item.id);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${item.name} permanently?`}
      description={undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} isLoading={busy}>
            Delete permanently
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <p className="text-sm">This action cannot be undone.</p>
        <p className="text-xs text-muted-foreground">
          <span className="mr-1 font-medium text-foreground">{item.name}</span>
          will be permanently removed from Menu Management. Historical orders, kitchen
          tickets, bills and reports remain intact — they carry a snapshot of the item
          from when it was ordered.
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
