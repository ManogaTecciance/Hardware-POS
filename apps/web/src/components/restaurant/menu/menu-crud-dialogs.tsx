'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Session } from '@/lib/auth';
import { menuSections as sectionsApi, menus as menusApi } from '@/lib/restaurant/api';
import type { MenuView, SectionView } from '@/lib/restaurant/types';

/**
 * Edit / Delete dialogs for Menu and Section rows. Kept as small, single-
 * responsibility components so `menu-browser.tsx` only wires state, not layout.
 *
 * All destructive dialogs use the shared danger variant + the wording the PO
 * approved in Sections 10–12 (historical records remain intact language).
 */

// ── Edit Menu ────────────────────────────────────────────────────────────

export function EditMenuDialog({
  session,
  branchId,
  menu,
  onClose,
  onSaved,
}: {
  session: Session;
  branchId: string;
  menu: MenuView;
  onClose: () => void;
  onSaved: (updated: MenuView) => void;
}) {
  const [name, setName] = React.useState(menu.name);
  const [description, setDescription] = React.useState(menu.description ?? '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await menusApi.update(session, branchId, menu.id, {
        name: name.trim(),
        description: description.trim(),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save menu');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit menu"
      description="Update the menu's name and description."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!name.trim()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-menu-name">
            Name
          </label>
          <Input
            id="edit-menu-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-menu-desc">
            Description
          </label>
          <Textarea
            id="edit-menu-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        </div>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// ── Delete Menu ──────────────────────────────────────────────────────────

export function DeleteMenuDialog({
  session,
  branchId,
  menu,
  onClose,
  onDone,
}: {
  session: Session;
  branchId: string;
  menu: MenuView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await menusApi.remove(session, branchId, menu.id);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete menu');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete "${menu.name}" permanently?`}
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
          Historical restaurant transactions remain intact — the server refuses if the
          menu still contains sections. Remove or move them first.
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

// ── Edit Section ─────────────────────────────────────────────────────────

export function EditSectionDialog({
  session,
  menuId,
  section,
  onClose,
  onSaved,
}: {
  session: Session;
  menuId: string;
  section: SectionView;
  onClose: () => void;
  onSaved: (updated: SectionView) => void;
}) {
  const [name, setName] = React.useState(section.name);
  const [description, setDescription] = React.useState(section.description ?? '');
  const [position, setPosition] = React.useState(String(section.position));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await sectionsApi.update(session, menuId, section.id, {
        name: name.trim(),
        description: description.trim(),
        position: Number(position) || 0,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save section');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit section"
      description="Update this section's name, description or position."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!name.trim()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-section-name">
            Name
          </label>
          <Input
            id="edit-section-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-section-desc">
            Description
          </label>
          <Textarea
            id="edit-section-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-section-pos">
            Position
          </label>
          <Input
            id="edit-section-pos"
            type="number"
            min={0}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            Lower numbers appear first. Ties break alphabetically.
          </p>
        </div>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// ── Delete Section ───────────────────────────────────────────────────────

export function DeleteSectionDialog({
  session,
  menuId,
  section,
  onClose,
  onDone,
}: {
  session: Session;
  menuId: string;
  section: SectionView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await sectionsApi.remove(session, menuId, section.id);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete section');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete "${section.name}" permanently?`}
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
          If the section still contains menu items, the server refuses the delete and
          tells you how many. Move or delete those items first.
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
