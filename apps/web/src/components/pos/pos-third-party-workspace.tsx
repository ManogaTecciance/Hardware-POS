'use client';

import { AlertTriangle, CheckCircle2, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type Session } from '@/lib/auth';
import { deliveryHub } from '@/lib/restaurant/api';
import { formatMoney, formatTime } from '@/lib/restaurant/labels';
import type { ExternalOrderView } from '@/lib/restaurant/types';

import { PosShell } from './pos-shell';

interface Props {
  session: Session;
  branchId: string;
  externalOrderId: string | null;
}

/**
 * POS 3rd Party mode.
 *
 * Two branches:
 *   1. `externalOrderId` in the URL → fetch the row and render an
 *      Accept / Reject inspector.
 *   2. No id → list this branch's inbound external orders so the
 *      operator can pick one to act on.
 *
 * Honesty note preserved from Pilot Change 2 design:
 *   Only the MOCK delivery-hub adapter ships today. Live Uber Eats /
 *   PickMe Food adapters are deferred; a real webhook is what would
 *   populate this list in production.
 */
export function PosThirdPartyWorkspace({ session, branchId, externalOrderId }: Props) {
  if (externalOrderId) {
    return (
      <ExternalOrderInspector
        session={session}
        branchId={branchId}
        externalOrderId={externalOrderId}
      />
    );
  }
  return <ExternalOrderList session={session} branchId={branchId} />;
}

function useShell(session: Session, rail: React.ReactNode, workspace: React.ReactNode) {
  const router = useRouter();
  return (
    <PosShell
      mode="THIRD_PARTY"
      onModeChange={(next) =>
        router.push(`/pos?mode=${next.toLowerCase().replace('_', '-')}`)
      }
      branchName={session.branchName}
      registerName={session.registerName}
      workspace={workspace}
      rail={rail}
      context={
        <span className="rounded-full border border-warning/40 bg-warning-soft px-2.5 py-1 text-warning">
          Only the MOCK delivery adapter is wired — live Uber Eats / PickMe Food
          integrations are deferred.
        </span>
      }
    />
  );
}

function ExternalOrderList({ session, branchId }: { session: Session; branchId: string }) {
  const router = useRouter();
  const [rows, setRows] = React.useState<ExternalOrderView[]>([]);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    deliveryHub
      .listExternalOrders(session, branchId)
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, branchId]);

  const workspace = (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Inbound 3rd party orders</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No 3rd-party orders yet. Live webhooks (Uber Eats, PickMe Food) are not shipping —
            the MOCK adapter can be used to simulate inbound orders.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/pos?mode=third-party&externalOrderId=${encodeURIComponent(r.id)}`,
                    )
                  }
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-card p-3 text-left hover:border-primary"
                >
                  <div>
                    <p className="text-sm font-semibold">
                      {r.platformKind} · {r.externalOrderRef}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Received {formatTime(r.receivedAt)}
                      {r.externalTotal ? ` · ${formatMoney(r.externalTotal)}` : ''}
                    </p>
                  </div>
                  <StatusBadge label={r.status} tone={toneFor(r.status)} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  const rail = (
    <Card>
      <CardHeader className="flex-row items-start gap-2">
        <div className="mt-1 rounded-md bg-warning-soft p-1.5 text-warning">
          <Truck className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base">3rd Party</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick an inbound order on the left to accept it.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Accepting a platform order forks a matching RestaurantOrder into your
          kitchen queue and the row appears in `/orders` with its platform badge.
        </p>
      </CardContent>
    </Card>
  );

  return useShell(session, rail, workspace);
}

function ExternalOrderInspector({
  session,
  externalOrderId,
}: {
  session: Session;
  branchId: string;
  externalOrderId: string;
}) {
  const router = useRouter();
  const [row, setRow] = React.useState<ExternalOrderView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [acting, setActing] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    deliveryHub
      .getExternalOrder(session, externalOrderId)
      .then((r) => setRow(r))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load order'),
      )
      .finally(() => setLoading(false));
  }, [session, externalOrderId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const accept = async () => {
    setActing(true);
    setError(null);
    try {
      await deliveryHub.acceptExternal(session, externalOrderId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept');
    } finally {
      setActing(false);
    }
  };

  const workspace = (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">External order</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : !row ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Order not found in this workspace.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Platform</p>
                <p className="font-medium">{row.platformKind}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">External reference</p>
                <p className="font-mono text-xs">{row.externalOrderRef}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Received</p>
                <p>{formatTime(row.receivedAt)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">External total</p>
                <p>{row.externalTotal ? formatMoney(row.externalTotal) : '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <StatusBadge label={row.status} tone={toneFor(row.status)} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Forked RestaurantOrder</p>
                <p className="text-xs">
                  {row.restaurantOrderId ? (
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => router.push('/orders')}
                    >
                      Open in Orders
                    </button>
                  ) : (
                    '—'
                  )}
                </p>
              </div>
            </div>
            {error ? (
              <p className="flex items-center gap-2 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" />
                {error}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );

  const canAccept = row && row.status === 'PENDING';
  const rail = (
    <Card>
      <CardHeader className="flex-row items-start gap-2">
        <div className="mt-1 rounded-md bg-warning-soft p-1.5 text-warning">
          <Truck className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base">3rd Party actions</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Accept forks a RestaurantOrder into the kitchen queue.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button
          fullWidth
          size="lg"
          leftIcon={<CheckCircle2 className="h-4 w-4" />}
          onClick={accept}
          isLoading={acting}
          disabled={!canAccept}
        >
          Accept &amp; Send
        </Button>
        {!canAccept && row ? (
          <p className="text-xs text-muted-foreground">
            Only PENDING external orders can be accepted. Current status:{' '}
            <strong>{row.status}</strong>.
          </p>
        ) : null}
        <Button
          fullWidth
          size="sm"
          variant="ghost"
          onClick={() => router.push('/pos?mode=third-party')}
        >
          Back to list
        </Button>
      </CardContent>
    </Card>
  );

  return useShell(session, rail, workspace);
}

function toneFor(
  status: ExternalOrderView['status'],
): 'positive' | 'warning' | 'danger' | 'info' | 'muted' {
  switch (status) {
    case 'PENDING':
      return 'warning';
    case 'ACCEPTED':
    case 'IN_KITCHEN':
      return 'info';
    case 'READY':
    case 'DELIVERED':
      return 'positive';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}
