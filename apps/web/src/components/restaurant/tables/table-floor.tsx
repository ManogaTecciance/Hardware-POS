'use client';

import { Building2, Plus, Users } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Session } from '@/lib/auth';
import { diningAreas, restaurantTables } from '@/lib/restaurant/api';
import {
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TONES,
} from '@/lib/restaurant/labels';
import type { DiningAreaView, RestaurantTableView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
  canManage: boolean;
}

interface Snapshot {
  areas: DiningAreaView[];
  tablesByArea: Map<string, RestaurantTableView[]>;
}

const EMPTY: Snapshot = { areas: [], tablesByArea: new Map() };

/**
 * Visual floor plan grouped by dining area.
 *
 * Layout: an area filter across the top, then one section per area with a
 * responsive card grid. Cards show only the fields the operator needs at a
 * glance (code, capacity, status) — session detail is a click into the
 * open-table flow (Phase D).
 */
export function TableFloor({ session, branchId, canManage }: Props) {
  const [state, setState] = React.useState<{
    status: 'loading' | 'ready' | 'error';
    snapshot: Snapshot;
    error?: string;
  }>({ status: 'loading', snapshot: EMPTY });
  const [selectedArea, setSelectedArea] = React.useState<string | 'ALL'>('ALL');
  const [showNewArea, setShowNewArea] = React.useState(false);
  const [showNewTable, setShowNewTable] = React.useState<{ areaId: string } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const areas = await diningAreas.list(session, branchId, false);
      const areaSorted = areas.slice().sort((a, b) => a.position - b.position);
      const lists = await Promise.all(
        areaSorted.map((a) => restaurantTables.list(session, a.id, false).catch(() => [])),
      );
      const tablesByArea = new Map<string, RestaurantTableView[]>();
      areaSorted.forEach((a, i) => {
        const rows = lists[i] ?? [];
        tablesByArea.set(
          a.id,
          rows
            .slice()
            .sort((x, y) =>
              x.code.localeCompare(y.code, undefined, { numeric: true, sensitivity: 'base' }),
            ),
        );
      });
      setState({ status: 'ready', snapshot: { areas: areaSorted, tablesByArea } });
    } catch (err) {
      setState({
        status: 'error',
        snapshot: EMPTY,
        error: err instanceof Error ? err.message : 'Failed to load floor plan',
      });
    }
  }, [session, branchId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const { snapshot, status } = state;
  const visibleAreas =
    selectedArea === 'ALL'
      ? snapshot.areas
      : snapshot.areas.filter((a) => a.id === selectedArea);

  return (
    <div className="space-y-4">
      {/* Area filter + management actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Show
        </span>
        <AreaChip
          label="All"
          active={selectedArea === 'ALL'}
          onClick={() => setSelectedArea('ALL')}
        />
        {snapshot.areas.map((a) => (
          <AreaChip
            key={a.id}
            label={a.name}
            active={selectedArea === a.id}
            onClick={() => setSelectedArea(a.id)}
          />
        ))}
        <div className="ml-auto flex items-center gap-2">
          {canManage ? (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Building2 className="h-4 w-4" />}
              onClick={() => setShowNewArea(true)}
            >
              New area
            </Button>
          ) : null}
        </div>
      </div>

      {status === 'loading' ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading the floor plan…
          </CardContent>
        </Card>
      ) : status === 'error' ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">
            Could not load the floor plan. {state.error ?? ''}
          </CardContent>
        </Card>
      ) : snapshot.areas.length === 0 ? (
        <Card>
          <CardContent className="space-y-4 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              No dining areas configured yet.{' '}
              {canManage
                ? 'Create your first area to start seating guests.'
                : 'Ask an administrator to configure the floor.'}
            </p>
            {canManage ? (
              <Button
                variant="outline"
                leftIcon={<Building2 className="h-4 w-4" />}
                onClick={() => setShowNewArea(true)}
              >
                Create dining area
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        visibleAreas.map((area) => {
          const tables = snapshot.tablesByArea.get(area.id) ?? [];
          return (
            <Card key={area.id}>
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>{area.name}</CardTitle>
                  {area.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{area.description}</p>
                  ) : null}
                </div>
                {canManage ? (
                  <Button
                    size="sm"
                    leftIcon={<Plus className="h-4 w-4" />}
                    onClick={() => setShowNewTable({ areaId: area.id })}
                  >
                    New table
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                {tables.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No tables in this area yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {tables.map((t) => (
                      <TableCard key={t.id} table={t} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {canManage && showNewArea ? (
        <NewAreaDialog
          onClose={() => setShowNewArea(false)}
          onCreated={async (created) => {
            setShowNewArea(false);
            await load();
            setSelectedArea(created.id);
          }}
          session={session}
          branchId={branchId}
        />
      ) : null}
      {canManage && showNewTable ? (
        <NewTableDialog
          onClose={() => setShowNewTable(null)}
          onCreated={async () => {
            const areaId = showNewTable!.areaId;
            setShowNewTable(null);
            await load();
            setSelectedArea(areaId);
          }}
          session={session}
          areaId={showNewTable.areaId}
        />
      ) : null}
    </div>
  );
}

function AreaChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center rounded-full px-3 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-foreground hover:bg-border'
      }`}
    >
      {label}
    </button>
  );
}

function TableCard({ table }: { table: RestaurantTableView }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold">{table.label ?? table.code}</p>
          {table.label ? <p className="text-xs text-muted-foreground">{table.code}</p> : null}
        </div>
        <StatusBadge
          label={TABLE_STATUS_LABELS[table.status]}
          tone={TABLE_STATUS_TONES[table.status]}
        />
      </div>
      <div className="mt-auto flex items-center gap-1 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Seats {table.capacity}</span>
      </div>
    </div>
  );
}

// ── Dialogs ───────────────────────────────────────────────────────────────

function NewAreaDialog({
  onClose,
  onCreated,
  session,
  branchId,
}: {
  onClose: () => void;
  onCreated: (area: DiningAreaView) => void;
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
      const created = await diningAreas.create(session, branchId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create area');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New dining area"
      description="A section of the floor plan, e.g. Ground Floor, Outdoor, Bar."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!name.trim()}>
            Create area
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="area-name">
            Name
          </label>
          <Input
            id="area-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ground floor"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="area-desc">
            Description
          </label>
          <Input
            id="area-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function NewTableDialog({
  onClose,
  onCreated,
  session,
  areaId,
}: {
  onClose: () => void;
  onCreated: (table: RestaurantTableView) => void;
  session: Session;
  areaId: string;
}) {
  const [code, setCode] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [capacity, setCapacity] = React.useState('4');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const capacityNum = Number(capacity);
  const codeIsValid = /^[A-Z0-9][A-Z0-9-]*$/.test(code);

  const submit = async () => {
    if (!codeIsValid || !Number.isInteger(capacityNum) || capacityNum < 1) return;
    setSaving(true);
    setError(null);
    try {
      const created = await restaurantTables.create(session, areaId, {
        code,
        label: label.trim() || undefined,
        capacity: capacityNum,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create table');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New table"
      description="Codes are unique per area (e.g. T1, BAR-3). Case-insensitive; stored as uppercase."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            isLoading={saving}
            disabled={!codeIsValid || !capacityNum || capacityNum < 1}
          >
            Create table
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="table-code">
            Code
          </label>
          <Input
            id="table-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="T1"
            autoFocus
          />
          {code && !codeIsValid ? (
            <p className="text-xs text-danger">
              Codes must start with a letter or digit; letters, digits and hyphens only.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="table-label">
            Display label
          </label>
          <Input
            id="table-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional — e.g. Window 1"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="table-capacity">
            Capacity (seats)
          </label>
          <Input
            id="table-capacity"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            inputMode="numeric"
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
