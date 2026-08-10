'use client';

import { UtensilsCrossed } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { OrderEntry } from '@/components/restaurant/orders/order-entry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type Session } from '@/lib/auth';
import { diningAreas, restaurantTables, tableSessions } from '@/lib/restaurant/api';
import { formatElapsed } from '@/lib/restaurant/labels';
import type {
  DiningAreaView,
  RestaurantTableView,
  TableSessionView,
} from '@/lib/restaurant/types';

import { PosShell } from './pos-shell';

interface Props {
  session: Session;
  branchId: string;
  sessionId: string | null;
}

/**
 * POS Dine-In mode.
 *
 * Two branches:
 *   1. `sessionId` in the URL → mount the existing `OrderEntry` component
 *      inside the POS shell. Same order-entry that ships from
 *      `/tables/session/[id]`; no fork.
 *   2. No sessionId → render a picker that lists open sessions and every
 *      AVAILABLE table so the operator can pick without hopping over to
 *      `/tables` and back.
 *
 * The `/tables` floor plan is still the canonical layout view — this is
 * the POS-mode shortcut for staff who live inside the POS all shift.
 */
export function PosDineInWorkspace({ session, branchId, sessionId }: Props) {
  if (sessionId) {
    return <OrderEntry session={session} sessionId={sessionId} />;
  }
  return <DineInPicker session={session} branchId={branchId} />;
}

function DineInPicker({ session, branchId }: { session: Session; branchId: string }) {
  const router = useRouter();
  const [openSessions, setOpenSessions] = React.useState<
    (TableSessionView & { activeOrderId: string | null })[]
  >([]);
  const [areas, setAreas] = React.useState<DiningAreaView[]>([]);
  const [tablesByArea, setTablesByArea] = React.useState<
    Map<string, RestaurantTableView[]>
  >(new Map());
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [os, ars] = await Promise.all([
          tableSessions.listOpen(session, branchId).catch(() => []),
          diningAreas.list(session, branchId, false),
        ]);
        const areaSorted = ars.slice().sort((a, b) => a.position - b.position);
        const lists = await Promise.all(
          areaSorted.map((a) =>
            restaurantTables.list(session, a.id, false).catch(() => []),
          ),
        );
        const map = new Map<string, RestaurantTableView[]>();
        areaSorted.forEach((a, i) => {
          map.set(a.id, (lists[i] ?? []).filter((t) => t.status === 'AVAILABLE'));
        });
        if (cancelled) return;
        setOpenSessions(os);
        setAreas(areaSorted);
        setTablesByArea(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  const workspace = (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Continue an open session</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Jump straight into a running session's order entry.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Loading sessions…
            </p>
          ) : openSessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No sessions open right now.
            </p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {openSessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/pos?mode=dine-in&sessionId=${encodeURIComponent(s.id)}`)
                    }
                    className="flex w-full items-center justify-between rounded-lg border border-border bg-card p-3 text-left hover:border-primary"
                  >
                    <div>
                      <p className="text-sm font-semibold">Session {s.sessionNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        Open {formatElapsed(s.openedAt)}
                        {s.guestCount ? ` · ${s.guestCount} guest${s.guestCount === 1 ? '' : 's'}` : ''}
                      </p>
                    </div>
                    <span className="text-xs text-primary">Open →</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Or seat a new table</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Open a session first from the floor plan — that&apos;s where guest count is
              set.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => router.push('/tables')}>
            Open floor plan
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? null : areas.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No dining areas configured yet.
            </p>
          ) : (
            <div className="space-y-3">
              {areas.map((a) => {
                const t = tablesByArea.get(a.id) ?? [];
                return (
                  <div key={a.id}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {a.name}
                    </p>
                    {t.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No available tables in this area.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {t.map((row) => (
                          <button
                            key={row.id}
                            type="button"
                            onClick={() => router.push(`/tables?openTable=${row.id}`)}
                            className="inline-flex h-9 items-center rounded-md border border-border bg-card px-3 text-sm hover:border-primary"
                            title={`Open ${row.label ?? row.code} from the floor plan`}
                          >
                            {row.label ?? row.code}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  const rail = (
    <Card>
      <CardHeader className="flex-row items-start gap-2">
        <div className="mt-1 rounded-md bg-brand-100 p-1.5 text-primary">
          <UtensilsCrossed className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base">Dine In</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick a session on the left to open its cart.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Dine-in orders live on the table&apos;s session. Round submission,
          voids and Close &amp; Bill all work exactly the same way they do
          from `/tables/session/[id]` — this is the same screen mounted
          inside POS.
        </p>
      </CardContent>
    </Card>
  );

  return (
    <PosShell
      mode="DINE_IN"
      onModeChange={(next) =>
        router.push(`/pos?mode=${next.toLowerCase().replace('_', '-')}`)
      }
      branchName="Main Dining"
      registerName="Counter 1"
      workspace={workspace}
      rail={rail}
    />
  );
}
