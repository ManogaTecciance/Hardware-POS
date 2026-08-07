'use client';

import { Package, Plus, User } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { takeaway as takeawayApi } from '@/lib/restaurant/api';
import {
  TAKEAWAY_STATUS_LABELS,
  TAKEAWAY_STATUS_TONES,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type { TakeawayOrderStatus, TakeawayView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

const STATUS_FLOW: TakeawayOrderStatus[] = [
  'PLACED',
  'IN_KITCHEN',
  'READY',
  'HANDED_OVER',
];

/** Next-status action for a takeaway order, or `null` if terminal. */
function nextStatus(current: TakeawayOrderStatus): TakeawayOrderStatus | null {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx === -1 || idx === STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[idx + 1] ?? null;
}

/**
 * Board of takeaway orders — active on top, handed-over below the fold.
 *
 * Each row advances through Placed → In kitchen → Ready → Handed over with
 * one tap. Rejects and cancels are separate: cancellation writes an
 * auditable status change, whereas walking the flow is the routine path.
 */
export function TakeawayList({ session, branchId }: Props) {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission(Permission.TAKEAWAY_CREATE);
  const canManage = hasPermission(Permission.KITCHEN_STATUS_UPDATE);

  const [rows, setRows] = React.useState<TakeawayView[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [advancing, setAdvancing] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    try {
      const list = await takeawayApi.list(session, branchId);
      setRows(list.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load takeaway orders');
      setStatus('error');
    }
  }, [session, branchId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  const advance = async (row: TakeawayView, next: TakeawayOrderStatus) => {
    setAdvancing((cur) => {
      const s = new Set(cur);
      s.add(row.id);
      return s;
    });
    try {
      await takeawayApi.updateStatus(session, row.id, { status: next });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setAdvancing((cur) => {
        const s = new Set(cur);
        s.delete(row.id);
        return s;
      });
    }
  };

  const cancel = async (row: TakeawayView) => {
    if (!window.confirm(`Cancel takeaway ${row.orderNumber}?`)) return;
    await advance(row, 'CANCELLED');
  };

  const active = rows.filter((r) => r.status !== 'HANDED_OVER' && r.status !== 'CANCELLED');
  const closed = rows.filter((r) => r.status === 'HANDED_OVER' || r.status === 'CANCELLED');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {active.length} active · {closed.length} closed today
        </span>
        {canCreate ? (
          <Button asChild size="sm" className="ml-auto" leftIcon={<Plus className="h-4 w-4" />}>
            <Link href="/takeaway/new">New takeaway</Link>
          </Button>
        ) : null}
      </div>

      {status === 'loading' ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading takeaway orders…
          </CardContent>
        </Card>
      ) : status === 'error' ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">
            {error ?? 'Could not load takeaway orders.'}
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-16 text-center">
            <Package className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No takeaway orders yet today.</p>
            {canCreate ? (
              <Button asChild variant="outline" leftIcon={<Plus className="h-4 w-4" />}>
                <Link href="/takeaway/new">New takeaway</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <>
          <TakeawaySection
            title="Active"
            rows={active}
            canManage={canManage}
            advancing={advancing}
            onAdvance={advance}
            onCancel={cancel}
          />
          {closed.length > 0 ? (
            <TakeawaySection
              title="Closed"
              rows={closed}
              canManage={false}
              advancing={advancing}
              onAdvance={advance}
              onCancel={cancel}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function TakeawaySection({
  title,
  rows,
  canManage,
  advancing,
  onAdvance,
  onCancel,
}: {
  title: string;
  rows: TakeawayView[];
  canManage: boolean;
  advancing: Set<string>;
  onAdvance: (row: TakeawayView, next: TakeawayOrderStatus) => void;
  onCancel: (row: TakeawayView) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-2">
        {rows.map((row) => {
          const next = nextStatus(row.status);
          return (
            <Card key={row.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{row.orderNumber}</span>
                    <StatusBadge
                      label={TAKEAWAY_STATUS_LABELS[row.status]}
                      tone={TAKEAWAY_STATUS_TONES[row.status]}
                    />
                    <span className="text-xs text-muted-foreground">
                      Placed {formatElapsed(row.createdAt)} ago
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    <User className="mr-1 inline-block h-3.5 w-3.5" aria-hidden="true" />
                    {row.customerName ?? 'Walk-in'}
                    {row.customerPhone ? ` · ${row.customerPhone}` : ''}
                    {row.pickupAt ? ` · Pickup ${formatTime(row.pickupAt)}` : ''}
                  </p>
                  {row.notes ? (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
                      &ldquo;{row.notes}&rdquo;
                    </p>
                  ) : null}
                </div>
                {canManage && next ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => onAdvance(row, next)}
                      isLoading={advancing.has(row.id)}
                    >
                      Advance to {TAKEAWAY_STATUS_LABELS[next]}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancel(row)}
                      disabled={advancing.has(row.id)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
