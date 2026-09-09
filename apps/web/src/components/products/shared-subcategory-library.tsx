'use client';

import * as React from 'react';
import { Info, Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  categoryAssignmentService as svc,
  type Subcategory,
} from '@/lib/category-assignments';

/**
 * Reusable ("shared") subcategory library UI. Demonstrates the many-to-many
 * model the spec asks for — one subcategory assignable to many categories and
 * removable from one without a global delete. Backed by the LocalStorage mock
 * adapter (`category-assignments.ts`); see its TODO(backend) for the real API.
 *
 * This is ADDITIVE and does not touch the real (server) category CRUD above it.
 */
export function SharedSubcategoryLibrary({
  categories,
  canManage,
}: {
  categories: { id: string; name: string }[];
  canManage: boolean;
}) {
  const confirm = useConfirm();
  const [library, setLibrary] = React.useState<Subcategory[]>([]);
  const [selectedCat, setSelectedCat] = React.useState<string>('');
  const [assigned, setAssigned] = React.useState<Subcategory[]>([]);
  const [newName, setNewName] = React.useState('');
  const [assignPick, setAssignPick] = React.useState('');

  const refresh = React.useCallback(() => {
    setLibrary(svc.getLibrary());
    setAssigned(selectedCat ? svc.getAssigned(selectedCat) : []);
  }, [selectedCat]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    const first = categories[0];
    if (!selectedCat && first) setSelectedCat(first.id);
  }, [categories, selectedCat]);

  const create = () => {
    if (!newName.trim()) return;
    svc.createSubcategory(newName);
    setNewName('');
    refresh();
  };

  const assignedIds = new Set(assigned.map((s) => s.id));
  const assignable = library.filter((s) => !assignedIds.has(s.id));

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <h3 className="text-base font-semibold">Shared subcategory library</h3>
            <p className="text-sm text-muted-foreground">
              Reusable subcategories that can be assigned to more than one category.
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">
            <Info className="h-3.5 w-3.5" /> Frontend preview
          </span>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          {/* Library */}
          <div className="space-y-3">
            <Label>Library ({library.length})</Label>
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
              {library.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No shared subcategories yet.
                </p>
              ) : (
                library.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
                    <span className="truncate text-sm">{s.name}</span>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-danger"
                        aria-label={`Delete ${s.name} from library`}
                        onClick={async () => {
                          // Awaited because the app's confirm is a promise, not a
                          // blocking native dialog (D145). The guard is unchanged:
                          // anything but an explicit yes leaves the library alone.
                          const ok = await confirm({
                            title: `Delete "${s.name}" from the shared library?`,
                            message: 'It is also removed from every category it is assigned to.',
                            confirmLabel: 'Delete',
                            tone: 'danger',
                          });
                          if (!ok) return;
                          svc.deleteFromLibrary(s.id);
                          refresh();
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            {canManage ? (
              <div className="flex items-center gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && create()}
                  placeholder="New shared subcategory"
                />
                <Button onClick={create} disabled={!newName.trim()} leftIcon={<Plus className="h-4 w-4" />}>
                  Add
                </Button>
              </div>
            ) : null}
          </div>

          {/* Assignments */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="assign-cat">Assign to category</Label>
              <Select id="assign-cat" value={selectedCat} onChange={(e) => setSelectedCat(e.target.value)}>
                {categories.length === 0 ? <option value="">No categories</option> : null}
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex min-h-[3rem] flex-wrap gap-2 rounded-xl border border-border p-2">
              {assigned.length === 0 ? (
                <span className="px-1 py-1 text-sm text-muted-foreground">No subcategories assigned.</span>
              ) : (
                assigned.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 py-1 pl-3 pr-1.5 text-sm font-medium text-brand-700">
                    {s.name}
                    {canManage ? (
                      <button
                        onClick={() => {
                          svc.unassign(selectedCat, s.id);
                          refresh();
                        }}
                        aria-label={`Unassign ${s.name}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-brand-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </span>
                ))
              )}
            </div>

            {canManage ? (
              <div className="flex items-center gap-2">
                <Select value={assignPick} onChange={(e) => setAssignPick(e.target.value)} disabled={assignable.length === 0}>
                  <option value="">{assignable.length ? 'Assign existing…' : 'All assigned'}</option>
                  {assignable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  disabled={!assignPick || !selectedCat}
                  onClick={() => {
                    svc.assign(selectedCat, assignPick);
                    setAssignPick('');
                    refresh();
                  }}
                >
                  Assign
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
