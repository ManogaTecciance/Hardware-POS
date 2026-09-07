'use client';

import { Archive, Building2, ConciergeBell, DoorOpen, Link2, MoreVertical, Pencil, Plus, Unlink, Users } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { AreaChip } from '@/components/restaurant/area-chip';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  diningAreas,
  openTables,
  restaurantTables,
  tableSessions,
} from '@/lib/restaurant/api';
import {
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TONES,
  formatElapsed,
} from '@/lib/restaurant/labels';
import { playFoodReadyChime } from '@/lib/restaurant/new-order-chime';
import type {
  DiningAreaView,
  OpenSessionView,
  OpenTableView,
  RestaurantTableView,
  TableSessionView,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
  canManage: boolean;
}

interface Snapshot {
  areas: DiningAreaView[];
  tablesByArea: Map<string, RestaurantTableView[]>;
  sessionByTableId: Map<string, OpenSessionView>;
  /** D49 — live ad-hoc joined tables for this branch. */
  openTables: OpenTableView[];
}

/**
 * D105 — "Food ready" acknowledgements survive the trip into the session
 * screen and back (this component unmounts on navigation), but stay
 * per-device: serving is whoever carried the plate, so one tablet's ack
 * must not clear another's bell. Same sessionStorage idiom as the POS cart.
 */
const READY_ACK_KEY = 'hpos.tables.readyAck';

function readAckedIds(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(READY_ACK_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeAckedIds(ids: Set<string>): void {
  try {
    window.sessionStorage.setItem(READY_ACK_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage refusing (private mode, quota) costs a lingering badge, nothing more.
  }
}

const EMPTY: Snapshot = {
  areas: [],
  tablesByArea: new Map(),
  sessionByTableId: new Map(),
  openTables: [],
};

/**
 * Visual floor plan grouped by dining area.
 *
 * Layout: an area filter across the top, then one section per area with a
 * responsive card grid. Cards show table code + capacity + status. When a
 * session is open on the table, the card also shows the elapsed time since
 * open plus a "View order" link to the order-entry screen. Available tables
 * expose an "Open table" action (Phase D) gated on `TABLE_OPEN`.
 */
export function TableFloor({ session, branchId, canManage }: Props) {
  const { hasPermission } = useAuth();
  const canOpenTable = hasPermission(Permission.TABLE_OPEN);
  const [state, setState] = React.useState<{
    status: 'loading' | 'ready' | 'error';
    snapshot: Snapshot;
    error?: string;
  }>({ status: 'loading', snapshot: EMPTY });
  const [selectedArea, setSelectedArea] = React.useState<string | 'ALL'>('ALL');
  const [showNewArea, setShowNewArea] = React.useState(false);
  const [showNewTable, setShowNewTable] = React.useState<{ areaId: string } | null>(null);
  const [openTarget, setOpenTarget] = React.useState<RestaurantTableView | null>(null);
  const [editArea, setEditArea] = React.useState<DiningAreaView | null>(null);
  const [archiveArea, setArchiveArea] = React.useState<DiningAreaView | null>(null);
  const [editTable, setEditTable] = React.useState<RestaurantTableView | null>(null);
  const [archiveTable, setArchiveTable] = React.useState<RestaurantTableView | null>(null);
  const canCreateArea = hasPermission(Permission.DINING_AREA_CREATE);
  const canCreateTable = hasPermission(Permission.TABLE_CREATE);
  // D49: joining tables is a shift decision, not creator-owned floor admin.
  const canManageOpenTables = hasPermission(Permission.OPEN_TABLE_MANAGE);
  const [showNewOpenTable, setShowNewOpenTable] = React.useState(false);
  const [dissolveTarget, setDissolveTarget] = React.useState<OpenTableView | null>(null);
  const [releaseTarget, setReleaseTarget] = React.useState<{
    table: RestaurantTableView;
    heldBy: OpenTableView[];
  } | null>(null);
  const canEditOwnArea = hasPermission(Permission.DINING_AREA_EDIT_OWN);
  const canArchiveOwnArea = hasPermission(Permission.DINING_AREA_ARCHIVE_OWN);
  const canEditOwnTable = hasPermission(Permission.TABLE_EDIT_OWN);
  const canArchiveOwnTable = hasPermission(Permission.TABLE_ARCHIVE_OWN);
  const currentUserId = session.user.id;
  /**
   * The card menu is a per-row affordance: only the row's creator sees it,
   * and only when they still hold the *_OWN permission. Hidden entirely
   * otherwise — never rendered as a disabled control, because a greyed-out
   * "Edit floor" reads to a manager as "you almost can, but not quite,"
   * which is worse than absent.
   */
  const areaOwnsIt = (area: DiningAreaView) => area.createdByUserId === currentUserId;
  const tableOwnsIt = (table: RestaurantTableView) => table.createdByUserId === currentUserId;

  /**
   * D50 — which open tables hold each physical table. Derived from the
   * open-table list rather than fetched: it is the same data, and a table
   * that carries no entry here is RESERVED for some other reason and must
   * never be offered an unreserve control.
   */
  const heldByTableId = React.useMemo(() => {
    const map = new Map<string, OpenTableView[]>();
    for (const open of state.snapshot.openTables) {
      for (const member of open.members) {
        const list = map.get(member.id) ?? [];
        list.push(open);
        map.set(member.id, list);
      }
    }
    return map;
  }, [state.snapshot.openTables]);

  /*
   * D105 — the chime's memory: every ready ticket id seen on the LAST
   * open-sessions response. Null until one lands, so mounting the floor never
   * rings — the same first-load discipline as the orders queue and the
   * kitchen board. Acked ids are state (they gate badges, so they must
   * re-render) seeded from sessionStorage.
   */
  const readyBaseline = React.useRef<Set<string> | null>(null);
  const [ackedReady, setAckedReady] = React.useState<Set<string>>(() =>
    typeof window === 'undefined' ? new Set() : readAckedIds(),
  );

  const absorbOpenSessions = React.useCallback((rows: OpenSessionView[]) => {
    const allReady = new Set(rows.flatMap((r) => r.readyTicketIds));
    const prev = readyBaseline.current;
    if (prev && [...allReady].some((id) => !prev.has(id))) playFoodReadyChime();
    readyBaseline.current = allReady;
    // Prune acks the server no longer lists: a closed session's tickets are
    // gone for good, and a RECALLED ticket must ring and badge again when the
    // kitchen re-bumps it — its id leaves this set, taking the ack with it.
    setAckedReady((cur) => {
      const next = new Set([...cur].filter((id) => allReady.has(id)));
      if (next.size === cur.size) return cur;
      writeAckedIds(next);
      return next;
    });
  }, []);

  /** The waiter tapped into the table: its bell is answered on this device. */
  const ackReady = React.useCallback((s: OpenSessionView) => {
    if (s.readyTicketIds.length === 0) return;
    setAckedReady((cur) => {
      const next = new Set(cur);
      for (const id of s.readyTicketIds) next.add(id);
      writeAckedIds(next);
      return next;
    });
  }, []);

  const load = React.useCallback(async () => {
    try {
      const [areas, openSessionsRaw, liveOpenTables] = await Promise.all([
        // null, not []: a failed sessions read must skip the chime baseline —
        // resetting it to "no ready tickets" would make the next good poll
        // re-ring every bell the waiter already heard.
        diningAreas.list(session, branchId, false),
        tableSessions.listOpen(session, branchId).catch(() => null),
        openTables.list(session, branchId).catch(() => []),
      ]);
      if (openSessionsRaw) absorbOpenSessions(openSessionsRaw);
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
      const sessionByTableId = new Map(
        (openSessionsRaw ?? []).map((s) => [s.tableId, s] as const),
      );
      setState({
        status: 'ready',
        snapshot: { areas: areaSorted, tablesByArea, sessionByTableId, openTables: liveOpenTables },
      });
    } catch (err) {
      setState({
        status: 'error',
        snapshot: EMPTY,
        error: err instanceof Error ? err.message : 'Failed to load floor plan',
      });
    }
  }, [session, branchId, absorbOpenSessions]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /*
   * D105 — the floor plan's only live loop. It refreshes SESSIONS, not the
   * furniture: areas and tables change at admin cadence and keep their
   * explicit loads, but "whose food is up" is worthless stale. 8 s like the
   * orders queue (5 s is the kitchen's urgency, not the floor's), gated to a
   * visible tab, with an immediate catch-up on return — a waiter pulling the
   * tablet out of an apron pocket hears the bells that landed meanwhile.
   */
  const refreshSessions = React.useCallback(async () => {
    try {
      const rows = await tableSessions.listOpen(session, branchId);
      absorbOpenSessions(rows);
      setState((cur) =>
        cur.status === 'ready'
          ? {
              ...cur,
              snapshot: {
                ...cur.snapshot,
                sessionByTableId: new Map(rows.map((s) => [s.tableId, s] as const)),
              },
            }
          : cur,
      );
    } catch {
      // Keep the last known floor; the next tick retries.
    }
  }, [session, branchId, absorbOpenSessions]);

  React.useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void refreshSessions();
    };
    const t = setInterval(refreshIfVisible, 8000);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [refreshSessions]);

  const { snapshot, status } = state;
  const visibleAreas =
    selectedArea === 'ALL'
      ? snapshot.areas
      : snapshot.areas.filter((a) => a.id === selectedArea);

  return (
    <div className="space-y-4">
      {/* Area filter + management actions.
          The chip strip is wrapped in <ChipRow> so branches with 8+ dining
          areas scroll horizontally on tablet portrait instead of wrapping to
          three-plus rows and eating vertical space. The "Show" label and the
          "New area" action sit outside the scrollable region so they stay
          reachable at both ends. */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Show
        </span>
        <ChipRow
          ariaLabel="Filter by dining area"
          activeKey={String(selectedArea)}
          className="min-w-0 flex-1"
        >
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
        </ChipRow>
        {canManage && canCreateArea ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Building2 className="h-4 w-4" />}
            onClick={() => setShowNewArea(true)}
            className="shrink-0"
          >
            New area
          </Button>
        ) : null}
      </div>

      {/* D49 — open tables: ad-hoc joined arrangements. Shown whenever any
          exist, plus the create affordance for shift staff. Rendered FIRST,
          above the physical floor: an open table is a live party that someone
          is serving right now, whereas the floor plan is mostly static
          furniture — so it is what staff need without scrolling past every
          area to reach it. */}
      {status === 'ready' && (snapshot.openTables.length > 0 || canManageOpenTables) ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Open tables</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Joined tables for parties that outgrow the floor plan. Several
                parties can share one table, each with its own tab; a table is
                freed when the last of those tabs closes.
              </p>
            </div>
            {canManageOpenTables ? (
              <Button
                size="sm"
                leftIcon={<Link2 className="h-4 w-4" />}
                onClick={() => setShowNewOpenTable(true)}
              >
                New open table
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {snapshot.openTables.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No open tables right now.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 tab:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {snapshot.openTables.map((t) => {
                  const s = snapshot.sessionByTableId.get(t.id) ?? null;
                  return (
                    <OpenTableCard
                      key={t.id}
                      table={t}
                      session={s}
                      readyCount={s ? s.readyTicketIds.filter((id) => !ackedReady.has(id)).length : 0}
                      onViewOrder={() => s && ackReady(s)}
                      canOpen={canOpenTable}
                      onOpenClick={() => setOpenTarget(t)}
                      canDissolve={canManageOpenTables}
                      onDissolve={() => setDissolveTarget(t)}
                    />
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

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
            {canManage && canCreateArea ? (
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
                <div className="flex items-center gap-2">
                  {canManage && canCreateTable ? (
                    <Button
                      size="sm"
                      leftIcon={<Plus className="h-4 w-4" />}
                      onClick={() => setShowNewTable({ areaId: area.id })}
                    >
                      New table
                    </Button>
                  ) : null}
                  {areaOwnsIt(area) && (canEditOwnArea || canArchiveOwnArea) ? (
                    <OwnerMenu
                      label={`Manage ${area.name}`}
                      items={[
                        canEditOwnArea && {
                          key: 'edit',
                          label: 'Edit floor',
                          icon: <Pencil className="h-4 w-4" />,
                          onClick: () => setEditArea(area),
                        },
                        canArchiveOwnArea && {
                          key: 'archive',
                          label: 'Archive floor',
                          icon: <Archive className="h-4 w-4" />,
                          onClick: () => setArchiveArea(area),
                          danger: true,
                        },
                      ]}
                    />
                  ) : null}
                </div>
              </CardHeader>
              <CardContent>
                {tables.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No tables in this area yet.
                  </p>
                ) : (
                  // iPad portrait (768) keeps 3 columns for breathing room;
                  // the 4-column step is deferred to tab: (900) so landscape
                  // tablets get the denser grid without cramping portrait.
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 tab:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {tables.map((t) => {
                      const s = snapshot.sessionByTableId.get(t.id) ?? null;
                      return (
                        <TableCard
                          key={t.id}
                          table={t}
                          session={s}
                          readyCount={
                            s ? s.readyTicketIds.filter((id) => !ackedReady.has(id)).length : 0
                          }
                          onViewOrder={() => s && ackReady(s)}
                          canOpen={canOpenTable}
                          onOpenClick={() => setOpenTarget(t)}
                          heldBy={heldByTableId.get(t.id) ?? []}
                          canRelease={canManageOpenTables}
                          onRelease={() =>
                            setReleaseTarget({ table: t, heldBy: heldByTableId.get(t.id) ?? [] })
                          }
                          ownsIt={tableOwnsIt(t)}
                          canEdit={canEditOwnTable}
                          canArchive={canArchiveOwnTable}
                          onEdit={() => setEditTable(t)}
                          onArchive={() => setArchiveTable(t)}
                        />
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {canManageOpenTables && showNewOpenTable ? (
        <CreateOpenTableDialog
          onClose={() => setShowNewOpenTable(false)}
          onCreated={async () => {
            setShowNewOpenTable(false);
            await load();
          }}
          session={session}
          branchId={branchId}
          areas={snapshot.areas}
          tablesByArea={snapshot.tablesByArea}
        />
      ) : null}
      {releaseTarget ? (
        <ReleaseMemberDialog
          onClose={() => setReleaseTarget(null)}
          onReleased={async () => {
            setReleaseTarget(null);
            await load();
          }}
          session={session}
          branchId={branchId}
          table={releaseTarget.table}
          heldBy={releaseTarget.heldBy}
        />
      ) : null}
      {dissolveTarget ? (
        <DissolveOpenTableDialog
          onClose={() => setDissolveTarget(null)}
          onDissolved={async () => {
            setDissolveTarget(null);
            await load();
          }}
          session={session}
          branchId={branchId}
          table={dissolveTarget}
        />
      ) : null}

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
      {openTarget ? (
        <OpenTableDialog
          onClose={() => setOpenTarget(null)}
          onOpened={async () => {
            setOpenTarget(null);
            await load();
          }}
          session={session}
          branchId={branchId}
          table={openTarget}
        />
      ) : null}
      {editArea ? (
        <EditAreaDialog
          onClose={() => setEditArea(null)}
          onSaved={async () => {
            setEditArea(null);
            await load();
          }}
          session={session}
          branchId={branchId}
          area={editArea}
        />
      ) : null}
      {archiveArea ? (
        <ArchiveAreaDialog
          onClose={() => setArchiveArea(null)}
          onArchived={async () => {
            setArchiveArea(null);
            await load();
          }}
          session={session}
          branchId={branchId}
          area={archiveArea}
        />
      ) : null}
      {editTable ? (
        <EditTableDialog
          onClose={() => setEditTable(null)}
          onSaved={async () => {
            setEditTable(null);
            await load();
          }}
          session={session}
          table={editTable}
        />
      ) : null}
      {archiveTable ? (
        <ArchiveTableDialog
          onClose={() => setArchiveTable(null)}
          onArchived={async () => {
            setArchiveTable(null);
            await load();
          }}
          session={session}
          table={archiveTable}
        />
      ) : null}
    </div>
  );
}

function TableCard({
  table,
  session,
  readyCount,
  onViewOrder,
  canOpen,
  onOpenClick,
  heldBy,
  canRelease,
  onRelease,
  ownsIt,
  canEdit,
  canArchive,
  onEdit,
  onArchive,
}: {
  table: RestaurantTableView;
  session: OpenSessionView | null;
  /** D105 — bumped tickets this device has not answered; >0 shows the bell. */
  readyCount: number;
  /** Tapping View order answers the bell for this session on this device. */
  onViewOrder: () => void;
  canOpen: boolean;
  onOpenClick: () => void;
  /** D50 — open tables currently holding this table; empty for every other reason a table is RESERVED. */
  heldBy: OpenTableView[];
  canRelease: boolean;
  onRelease: () => void;
  ownsIt: boolean;
  canEdit: boolean;
  canArchive: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const isAvailable = table.status === 'AVAILABLE';
  const isHeld = heldBy.length > 0;
  const showMenu = ownsIt && (canEdit || canArchive);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold">{table.label ?? table.code}</p>
          {table.label ? <p className="text-xs text-muted-foreground">{table.code}</p> : null}
        </div>
        <div className="flex items-center gap-1">
          <StatusBadge
            label={TABLE_STATUS_LABELS[table.status]}
            tone={TABLE_STATUS_TONES[table.status]}
          />
          {showMenu ? (
            <OwnerMenu
              label={`Manage ${table.label ?? table.code}`}
              items={[
                canEdit && {
                  key: 'edit',
                  label: 'Edit table',
                  icon: <Pencil className="h-4 w-4" />,
                  onClick: onEdit,
                },
                canArchive && {
                  key: 'archive',
                  label: 'Archive table',
                  icon: <Archive className="h-4 w-4" />,
                  onClick: onArchive,
                  danger: true,
                },
              ]}
            />
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{table.capacity != null ? `Seats ${table.capacity}` : 'Seats as arranged'}</span>
        {session ? (
          <span className="ml-auto">Open {formatElapsed(session.openedAt)}</span>
        ) : null}
      </div>
      {/* D50 — why this table is Reserved. Naming the holders is what stops an
          operator unreserving something that is reserved for another reason:
          a table with no line here has no unreserve control at all. */}
      {isHeld ? (
        <p className="flex items-start gap-1 text-xs text-info">
          <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Held by {heldBy.map((o) => o.label ?? o.code).join(', ')}</span>
        </p>
      ) : null}
      {/* D105 — the bell the food-ready chime points at. Cleared per device
          by opening the order, not by any server state: serving has no verb
          here, carrying the plate is the acknowledgement. */}
      {readyCount > 0 ? (
        <p className="flex items-center gap-1 text-xs font-semibold text-success">
          <ConciergeBell className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Food ready</span>
        </p>
      ) : null}
      <div className="mt-auto flex gap-2 pt-1">
        {/* `size="md"` (44px) unconditionally — this is the card's primary
            action, and the sm variant (36px) sits just under the touch line
            even on desktop. The empty spacer matches the same height so
            cards without an action don't jitter the grid row. */}
        {session ? (
          <Button asChild size="md" fullWidth variant="secondary">
            <Link href={`/tables/session/${session.id}`} onClick={onViewOrder}>
              View order
            </Link>
          </Button>
        ) : isAvailable && canOpen ? (
          <Button
            size="md"
            fullWidth
            leftIcon={<DoorOpen className="h-4 w-4" />}
            onClick={onOpenClick}
          >
            Open table
          </Button>
        ) : isHeld && canRelease ? (
          <Button
            size="md"
            fullWidth
            variant="outline"
            leftIcon={<Unlink className="h-4 w-4" />}
            onClick={onRelease}
          >
            Unreserve
          </Button>
        ) : (
          <div className="h-11" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// ── Dialogs ───────────────────────────────────────────────────────────────

function OpenTableDialog({
  onClose,
  onOpened,
  session,
  branchId,
  table,
}: {
  onClose: () => void;
  onOpened: (opened: TableSessionView) => void;
  session: Session;
  branchId: string;
  table: RestaurantTableView;
}) {
  const [guestCount, setGuestCount] = React.useState(String(Math.min(table.capacity ?? 2, 2)));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const guestNum = Number(guestCount);
  // An open table (D49) has no registered capacity — any positive count is fine.
  const valid = Number.isInteger(guestNum) && guestNum >= 1 && (table.capacity == null || guestNum <= table.capacity);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const opened = await tableSessions.open(session, branchId, {
        tableId: table.id,
        guestCount: guestNum,
        waiterUserId: session.user.id,
      });
      onOpened(opened);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open table');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Open ${table.label ?? table.code}`}
      description={table.capacity != null ? `Seats up to ${table.capacity} guests.` : 'Seating as arranged — no registered capacity.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!valid}>
            Open table
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="guest-count">
            Guest count
          </label>
          <Input
            id="guest-count"
            value={guestCount}
            onChange={(e) => setGuestCount(e.target.value)}
            inputMode="numeric"
            autoFocus
          />
          {guestCount && !valid ? (
            <p className="text-xs text-danger">
              {table.capacity != null
                ? `Between 1 and ${table.capacity} (the table's capacity).`
                : 'The number of guests being seated.'}
            </p>
          ) : null}
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

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

// ── Owner-scoped menus + dialogs (Restaurant Pilot Change 1) ──────────────

/**
 * A tiny click-out dropdown for the per-row overflow menu. Only rendered by
 * the caller when the caller has proven ownership *and* holds at least one
 * of the item permissions — the menu itself never re-decides that.
 */
function OwnerMenu({
  label,
  items,
}: {
  label: string;
  items: Array<
    | false
    | {
        key: string;
        label: string;
        icon: React.ReactNode;
        onClick: () => void;
        danger?: boolean;
      }
  >;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const real = items.filter(
    (it): it is Exclude<typeof it, false> => it !== false,
  );
  if (real.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // touch-target-coarse expands the tap area to 44×44 on touch devices
        // without changing the mouse footprint — the icon stays the same
        // visual size in both places.
        className="touch-target-coarse inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {real.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                it.danger ? 'text-danger hover:bg-danger/10' : 'text-foreground hover:bg-muted'
              }`}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Turns the server's error code into the copy the directive specifies.
 * Falls back to the raw message for anything unmapped — server-provided
 * messages already carry the generic wording, so a fallback here does not
 * regress an unmapped case to "Something went wrong."
 */
function translateError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { code?: string; message?: string } | undefined;
    switch (body?.code) {
      case 'FORBIDDEN_NOT_CREATOR':
        return 'You can only edit tables or dining areas that you created.';
      case 'TABLE_IN_SERVICE':
        return 'This table is currently in service and cannot be archived.';
      case 'AREA_HAS_TABLES':
        return 'Move or archive the tables in this dining area before archiving it.';
      case 'AREA_NAME_TAKEN':
        return body?.message ?? 'That area name is already in use on this branch.';
      case 'TABLE_CODE_TAKEN':
        return body?.message ?? 'That table code is already in use in this area.';
      default:
        return body?.message ?? err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function EditAreaDialog({
  onClose,
  onSaved,
  session,
  branchId,
  area,
}: {
  onClose: () => void;
  onSaved: () => void;
  session: Session;
  branchId: string;
  area: DiningAreaView;
}) {
  const [name, setName] = React.useState(area.name);
  const [description, setDescription] = React.useState(area.description ?? '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await diningAreas.update(session, branchId, area.id, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(translateError(err));
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${area.name}`}
      description="Rename this floor or update its description."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-area-name">
            Name
          </label>
          <Input
            id="edit-area-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-area-desc">
            Description
          </label>
          <Input
            id="edit-area-desc"
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

function ArchiveAreaDialog({
  onClose,
  onArchived,
  session,
  branchId,
  area,
}: {
  onClose: () => void;
  onArchived: () => void;
  session: Session;
  branchId: string;
  area: DiningAreaView;
}) {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await diningAreas.archive(session, branchId, area.id);
      onArchived();
    } catch (err) {
      setError(translateError(err));
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Archive ${area.name}?`}
      description="All active tables must first be moved or archived."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} isLoading={saving}>
            Archive floor
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Historical orders and reports for this floor will remain available.
        </p>
      )}
    </Dialog>
  );
}

function EditTableDialog({
  onClose,
  onSaved,
  session,
  table,
}: {
  onClose: () => void;
  onSaved: () => void;
  session: Session;
  table: RestaurantTableView;
}) {
  const [label, setLabel] = React.useState(table.label ?? '');
  const [capacity, setCapacity] = React.useState(String(table.capacity ?? ''));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const capacityNum = Number(capacity);
  const valid = Number.isInteger(capacityNum) && capacityNum >= 1;
  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await restaurantTables.update(session, table.areaId ?? '', table.id, {
        label: label.trim() || undefined,
        capacity: capacityNum,
      });
      onSaved();
    } catch (err) {
      setError(translateError(err));
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${table.label ?? table.code}`}
      description={`Code (${table.code}) is fixed for consistency with the shared vocabulary.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-table-label">
            Display label
          </label>
          <Input
            id="edit-table-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional — e.g. Window 1"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="edit-table-capacity">
            Capacity (seats)
          </label>
          <Input
            id="edit-table-capacity"
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

function ArchiveTableDialog({
  onClose,
  onArchived,
  session,
  table,
}: {
  onClose: () => void;
  onArchived: () => void;
  session: Session;
  table: RestaurantTableView;
}) {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await restaurantTables.archive(session, table.areaId ?? '', table.id);
      onArchived();
    } catch (err) {
      setError(translateError(err));
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Archive ${table.label ?? table.code}?`}
      description="This table will no longer be available for new guests."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} isLoading={saving}>
            Archive table
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Historical orders and reports will remain available.
        </p>
      )}
    </Dialog>
  );
}

// ── Open tables (D49) ─────────────────────────────────────────────────────

function OpenTableCard({
  table,
  session,
  readyCount,
  onViewOrder,
  canOpen,
  onOpenClick,
  canDissolve,
  onDissolve,
}: {
  table: OpenTableView;
  session: OpenSessionView | null;
  /** D105 — see TableCard: unanswered bumped tickets on this party. */
  readyCount: number;
  onViewOrder: () => void;
  canOpen: boolean;
  onOpenClick: () => void;
  canDissolve: boolean;
  onDissolve: () => void;
}) {
  const isAvailable = table.status === 'AVAILABLE';
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold" title={table.label ?? table.code}>
            {table.label ?? table.code}
          </p>
          <p className="text-xs text-muted-foreground">{table.code}</p>
        </div>
        <StatusBadge
          label={TABLE_STATUS_LABELS[table.status]}
          tone={TABLE_STATUS_TONES[table.status]}
        />
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{table.capacity != null ? `Seats ${table.capacity}` : 'Seats as arranged'}</span>
        {session ? <span className="ml-auto">Open {formatElapsed(session.openedAt)}</span> : null}
      </div>
      {/* The joined physical tables — the operator's answer to "where do I
          actually put these people". */}
      <p className="text-xs text-muted-foreground">
        Joins {table.members.map((m) => m.label ?? m.code).join(' + ') || '—'}
      </p>
      {/* D105 — same bell as TableCard; a joined party's food rings too. */}
      {readyCount > 0 ? (
        <p className="flex items-center gap-1 text-xs font-semibold text-success">
          <ConciergeBell className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Food ready</span>
        </p>
      ) : null}
      {/* Stacked, not side by side: these cards are one narrow grid cell wide,
          and a second button on the same row overflows into its neighbour. */}
      <div className="mt-auto flex flex-col gap-2 pt-1">
        {session ? (
          <Button asChild size="md" fullWidth variant="secondary">
            <Link href={`/tables/session/${session.id}`} onClick={onViewOrder}>
              View order
            </Link>
          </Button>
        ) : isAvailable && canOpen ? (
          <Button size="md" fullWidth leftIcon={<DoorOpen className="h-4 w-4" />} onClick={onOpenClick}>
            Open table
          </Button>
        ) : (
          <div className="h-11" aria-hidden="true" />
        )}
        {!session && canDissolve ? (
          <Button size="md" fullWidth variant="outline" onClick={onDissolve}>
            Dissolve
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CreateOpenTableDialog({
  onClose,
  onCreated,
  session,
  branchId,
  areas,
  tablesByArea,
}: {
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  session: Session;
  branchId: string;
  areas: DiningAreaView[];
  tablesByArea: Map<string, RestaurantTableView[]>;
}) {
  const [name, setName] = React.useState('');
  const [seats, setSeats] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // D50: AVAILABLE **or** already-RESERVED physical tables can be joined —
  // several parties may share one table, each with its own tab. Same rule the
  // server enforces; filtering here just keeps the picker honest.
  const joinable = areas
    .map((area) => ({
      area,
      tables: (tablesByArea.get(area.id) ?? []).filter(
        (t) =>
          (t.status === 'AVAILABLE' || t.status === 'RESERVED') &&
          t.isActive &&
          t.kind === 'PHYSICAL',
      ),
    }))
    .filter((g) => g.tables.length > 0);

  const seatsNum = seats.trim() === '' ? undefined : Number(seats);
  const valid =
    name.trim().length > 0 &&
    selected.size >= 1 &&
    (seatsNum === undefined || (Number.isInteger(seatsNum) && seatsNum >= 1));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await openTables.create(session, branchId, {
        name: name.trim(),
        seats: seatsNum,
        memberTableIds: [...selected],
      });
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the open table');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New open table"
      description="Join physical tables for a party that outgrows the floor plan. Tables already serving another party can be shared — each party keeps its own tab."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={saving} disabled={!valid}>
            Create open table
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="open-table-name">
              Name
            </label>
            <Input
              id="open-table-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Party of six"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="open-table-seats">
              Seats (optional)
            </label>
            <Input
              id="open-table-seats"
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
              placeholder="No registered capacity"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Tables to reserve</p>
          {joinable.length === 0 ? (
            <p className="rounded-xl border border-border p-3 text-sm text-muted-foreground">
              No available tables to reserve right now.
            </p>
          ) : (
            <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-border p-3">
              {joinable.map(({ area, tables }) => (
                <div key={area.id}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {area.name}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {tables.map((t) => (
                      <label
                        key={t.id}
                        className={
                          'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ' +
                          (selected.has(t.id) ? 'border-primary bg-primary/10' : 'border-border')
                        }
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={selected.has(t.id)}
                          onChange={() => toggle(t.id)}
                        />
                        <span>
                          {t.label ?? t.code}
                          <span className="ml-1 text-xs text-muted-foreground">({t.capacity})</span>
                          {/* D50 — already backing another party's tab. */}
                          {t.status === 'RESERVED' ? (
                            <span className="ml-1 text-xs text-info">shared</span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Selected tables go Reserved and cannot be seated separately. They are
            freed when the last tab using them closes, or earlier via Unreserve.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

function DissolveOpenTableDialog({
  onClose,
  onDissolved,
  session,
  branchId,
  table,
}: {
  onClose: () => void;
  onDissolved: () => Promise<void> | void;
  session: Session;
  branchId: string;
  table: OpenTableView;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await openTables.dissolve(session, branchId, table.id);
      await onDissolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not dissolve the open table');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Dissolve ${table.label ?? table.code}?`}
      description={`${table.members.map((m) => m.label ?? m.code).join(', ')} will return to Available.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void submit()} isLoading={busy}>
            Dissolve
          </Button>
        </>
      }
    >
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </Dialog>
  );
}

/**
 * D50 — manual early release of one shared table. Confirmed rather than
 * instant because there is no "add member" endpoint: putting the table back
 * means dissolving and re-creating the arrangement.
 */
function ReleaseMemberDialog({
  onClose,
  onReleased,
  session,
  branchId,
  table,
  heldBy,
}: {
  onClose: () => void;
  onReleased: () => Promise<void> | void;
  session: Session;
  branchId: string;
  table: RestaurantTableView;
  heldBy: OpenTableView[];
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const stillSeated = heldBy.filter((o) => o.status !== 'AVAILABLE');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await openTables.releaseMember(session, branchId, table.id);
      await onReleased();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not unreserve the table');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Unreserve ${table.label ?? table.code}?`}
      description={`It will leave ${heldBy.map((o) => o.label ?? o.code).join(', ')} and return to Available.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={busy}>
            Unreserve
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        {error ? <p className="text-danger">{error}</p> : null}
        {stillSeated.length > 0 ? (
          <p className="text-muted-foreground">
            {stillSeated.map((o) => o.label ?? o.code).join(', ')} still has a live
            tab. Only do this once that party no longer needs this table.
          </p>
        ) : null}
        <p className="text-muted-foreground">
          The table cannot be added back to the same open table afterwards.
        </p>
      </div>
    </Dialog>
  );
}
