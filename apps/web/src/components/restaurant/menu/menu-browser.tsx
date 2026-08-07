'use client';

import { Plus, ChevronRight, Sparkles } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
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
  const [showNewItem, setShowNewItem] = React.useState(false);

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
              onClick={() => setShowNewItem(true)}
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
                <div
                  key={it.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold">{it.name}</p>
                      {it.modifierGroupIds.length > 0 ? (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                          title="This item has modifier groups"
                        >
                          <Sparkles className="h-3 w-3" aria-hidden="true" />
                          {it.modifierGroupIds.length}
                        </span>
                      ) : null}
                    </div>
                    {it.description ? (
                      <p className="truncate text-xs text-muted-foreground">{it.description}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <p className="text-sm font-semibold">{formatMoney(it.basePrice)}</p>
                    {!it.isActive ? <StatusBadge label="Inactive" tone="muted" /> : null}
                  </div>
                </div>
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
      {canManage && showNewItem && selectedSectionId ? (
        <NewItemDialog
          onClose={() => setShowNewItem(false)}
          onCreated={async () => {
            setShowNewItem(false);
            await loadItems(selectedSectionId);
          }}
          session={session}
          sectionId={selectedSectionId}
        />
      ) : null}
    </div>
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

function NewItemDialog({
  onClose,
  onCreated,
  session,
  sectionId,
}: {
  onClose: () => void;
  onCreated: (item: MenuItemView) => void;
  session: Session;
  sectionId: string;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [price, setPrice] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const priceNum = Number(price);
    if (!name.trim() || !Number.isFinite(priceNum) || priceNum < 0) return;
    setSaving(true);
    setError(null);
    try {
      const created = await menuItemsApi.create(session, sectionId, {
        name: name.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create item');
      setSaving(false);
    }
  };

  const priceIsValid = price === '' || (Number.isFinite(Number(price)) && Number(price) >= 0);

  return (
    <Dialog
      open
      onClose={onClose}
      title="New menu item"
      description="Modifier groups, station routing and channel prices can be added after saving."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            isLoading={saving}
            disabled={!name.trim() || !priceIsValid || price === ''}
          >
            Create item
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="item-name">
            Name
          </label>
          <Input
            id="item-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Chicken Fried Rice"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="item-desc">
            Description
          </label>
          <Textarea
            id="item-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional."
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="item-price">
            Base price
          </label>
          <Input
            id="item-price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
          {!priceIsValid ? (
            <p className="text-xs text-danger">Enter a non-negative number.</p>
          ) : null}
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
