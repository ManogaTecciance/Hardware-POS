'use client';

import { AlertTriangle, Printer, RefreshCw } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { kitchen, kitchenPrinters, kitchenStations } from '@/lib/restaurant/api';
import {
  KITCHEN_TICKET_STATUS_LABELS,
  KITCHEN_TICKET_STATUS_TONES,
  PRINT_ATTEMPT_STATUS_LABELS,
  formatElapsed,
  formatTime,
} from '@/lib/restaurant/labels';
import type {
  KitchenPrinterView,
  KitchenStationView,
  KitchenTicketStatus,
  KitchenTicketView,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

const FILTERS: { key: KitchenTicketStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'QUEUED', label: 'Queued' },
  { key: 'PRINTED', label: 'Printed' },
  { key: 'REPRINTED', label: 'Reprinted' },
  { key: 'FAILED', label: 'Failed' },
];

/**
 * KDS + KOT board.
 *
 * The kitchen sees a live grid of tickets per station: what to make next,
 * what came in when, what the printer did or did not do. Filtering by status
 * keeps a busy station's board readable; the default view is everything so
 * a chef never misses a ticket that landed in an unexpected state.
 *
 * Polls every 5 s. That is a compromise: shorter cadences read as jitter,
 * longer ones leave a printer failure hidden while food goes to a table
 * that no one has been billed for.
 */
export function KitchenBoard({ session, branchId }: Props) {
  const { hasPermission } = useAuth();
  const canPrint = hasPermission(Permission.KOT_PRINT);

  const [tickets, setTickets] = React.useState<KitchenTicketView[]>([]);
  const [printers, setPrinters] = React.useState<KitchenPrinterView[]>([]);
  const [stations, setStations] = React.useState<KitchenStationView[]>([]);
  const [filter, setFilter] = React.useState<KitchenTicketStatus | 'ALL'>('ALL');
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [action, setAction] = React.useState<
    | { kind: 'mark-printed' | 'mark-failed'; ticket: KitchenTicketView }
    | null
  >(null);
  const [reprintPending, setReprintPending] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    try {
      const [tk, pr, st] = await Promise.all([
        kitchen.listTickets(session, branchId, filter),
        kitchenPrinters.list(session, branchId).catch(() => [] as KitchenPrinterView[]),
        kitchenStations.list(session, branchId).catch(() => [] as KitchenStationView[]),
      ]);
      setTickets(
        tk
          .slice()
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
      );
      setPrinters(pr);
      setStations(st);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load kitchen tickets');
      setStatus('error');
    }
  }, [session, branchId, filter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const printerById = React.useMemo(() => {
    const m = new Map<string, KitchenPrinterView>();
    for (const p of printers) m.set(p.id, p);
    return m;
  }, [printers]);

  const stationById = React.useMemo(() => {
    const m = new Map<string, KitchenStationView>();
    for (const s of stations) m.set(s.id, s);
    return m;
  }, [stations]);

  const reprint = async (ticket: KitchenTicketView) => {
    setReprintPending((cur) => {
      const next = new Set(cur);
      next.add(ticket.id);
      return next;
    });
    try {
      await kitchen.reprint(session, branchId, ticket.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reprint failed');
    } finally {
      setReprintPending((cur) => {
        const next = new Set(cur);
        next.delete(ticket.id);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter chips wrap in <ChipRow> so a narrow tablet keeps them on one
          scrollable line. `h-11 px-4` lifts each chip onto the 44px touch
          line. The "Refreshes every 5 s." hint stays outside the scrollable
          region so it never gets clipped by the overflow fades. */}
      <div className="flex items-center gap-3">
        <ChipRow
          ariaLabel="Filter kitchen tickets by status"
          activeKey={String(filter)}
          className="min-w-0 flex-1"
        >
          {FILTERS.map((f) => {
            const count =
              f.key === 'ALL' ? tickets.length : tickets.filter((t) => t.status === f.key).length;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                data-active={filter === f.key}
                className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${
                  filter === f.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground hover:bg-border'
                }`}
              >
                {f.label}
                <span
                  className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs ${
                    filter === f.key ? 'bg-primary-foreground/20' : 'bg-surface'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </ChipRow>
        <span className="shrink-0 text-xs text-muted-foreground">Refreshes every 5 s.</span>
      </div>

      {status === 'loading' ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading tickets…
          </CardContent>
        </Card>
      ) : status === 'error' ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">
            {error ?? 'Could not load kitchen tickets.'}
          </CardContent>
        </Card>
      ) : tickets.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No tickets in this view.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {tickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              station={stationById.get(t.stationId)}
              printer={t.primaryPrinterId ? printerById.get(t.primaryPrinterId) : undefined}
              canPrint={canPrint}
              reprintPending={reprintPending.has(t.id)}
              onReprint={() => reprint(t)}
              onMarkPrinted={() => setAction({ kind: 'mark-printed', ticket: t })}
              onMarkFailed={() => setAction({ kind: 'mark-failed', ticket: t })}
            />
          ))}
        </div>
      )}

      {action ? (
        <TicketActionDialog
          session={session}
          branchId={branchId}
          printers={printers}
          initialPrinterId={action.ticket.primaryPrinterId ?? printers[0]?.id ?? ''}
          action={action}
          onClose={() => setAction(null)}
          onDone={async () => {
            setAction(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function TicketCard({
  ticket,
  station,
  printer,
  canPrint,
  reprintPending,
  onReprint,
  onMarkPrinted,
  onMarkFailed,
}: {
  ticket: KitchenTicketView;
  station: KitchenStationView | undefined;
  printer: KitchenPrinterView | undefined;
  canPrint: boolean;
  reprintPending: boolean;
  onReprint: () => void;
  onMarkPrinted: () => void;
  onMarkFailed: () => void;
}) {
  const lastAttempt = ticket.attempts[ticket.attempts.length - 1];
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="text-base">
            #{ticket.ticketNumber}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {station?.code ?? '—'} · {station?.name ?? 'Unknown station'}
            </span>
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sent {formatElapsed(ticket.createdAt)} ago · {formatTime(ticket.createdAt)}
          </p>
        </div>
        <StatusBadge
          label={KITCHEN_TICKET_STATUS_LABELS[ticket.status]}
          tone={KITCHEN_TICKET_STATUS_TONES[ticket.status]}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1">
          {ticket.items.map((it) => (
            <li key={it.id} className="text-sm">
              <span className="font-medium">
                {Number(it.quantity)} × {it.menuItemName}
              </span>
              {it.modifierNames.length > 0 ? (
                <ul className="ml-4 text-xs text-muted-foreground">
                  {it.modifierNames.map((n, i) => (
                    <li key={`${it.id}-mod-${i}`}>+ {n}</li>
                  ))}
                </ul>
              ) : null}
              {it.specialInstructions ? (
                <p className="ml-4 text-xs italic text-muted-foreground">
                  &ldquo;{it.specialInstructions}&rdquo;
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {lastAttempt ? (
          <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
            <p className="font-medium">
              {PRINT_ATTEMPT_STATUS_LABELS[lastAttempt.status]} — {printer?.name ?? 'Unknown printer'}
            </p>
            <p className="text-muted-foreground">
              Attempted {formatTime(lastAttempt.attemptedAt)}
              {lastAttempt.completedAt ? ` · Completed ${formatTime(lastAttempt.completedAt)}` : ''}
            </p>
            {lastAttempt.error ? (
              <p className="mt-1 flex items-start gap-1 text-danger">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{lastAttempt.error}</span>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No print attempts yet.</p>
        )}
        {canPrint ? (
          // size="md" (44px) so a rushed chef with wet hands hits the tap
          // targets first time. `flex-wrap` may push the third button to a
          // second line on narrow ticket cards — that's an acceptable trade
          // vs. keeping 32px targets on a kitchen tablet.
          <div className="flex flex-wrap gap-2">
            <Button
              size="md"
              variant="outline"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={onReprint}
              isLoading={reprintPending}
            >
              Reprint
            </Button>
            <Button
              size="md"
              variant="ghost"
              leftIcon={<Printer className="h-4 w-4" />}
              onClick={onMarkPrinted}
            >
              Mark printed
            </Button>
            <Button
              size="md"
              variant="ghost"
              onClick={onMarkFailed}
              leftIcon={<AlertTriangle className="h-4 w-4" />}
            >
              Mark failed
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TicketActionDialog({
  session,
  branchId,
  printers,
  action,
  initialPrinterId,
  onClose,
  onDone,
}: {
  session: Session;
  branchId: string;
  printers: KitchenPrinterView[];
  action: { kind: 'mark-printed' | 'mark-failed'; ticket: KitchenTicketView };
  initialPrinterId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [printerId, setPrinterId] = React.useState(initialPrinterId);
  const [errorMsg, setErrorMsg] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);

  const canSubmit =
    !!printerId &&
    (action.kind === 'mark-printed' || (action.kind === 'mark-failed' && errorMsg.trim().length > 0));

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setDialogError(null);
    try {
      if (action.kind === 'mark-printed') {
        await kitchen.markPrinted(session, branchId, action.ticket.id, { printerId });
      } else {
        await kitchen.markFailed(session, branchId, action.ticket.id, {
          printerId,
          error: errorMsg.trim(),
        });
      }
      await onDone();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Action failed');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={action.kind === 'mark-printed' ? 'Mark ticket printed' : 'Mark ticket failed'}
      description={
        action.kind === 'mark-printed'
          ? 'Records a successful print attempt for the audit trail.'
          : 'Records a failed print attempt so the kitchen can act on it.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!canSubmit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="text-sm font-medium" htmlFor="printer-select">
          Printer
        </label>
        <select
          id="printer-select"
          value={printerId}
          onChange={(e) => setPrinterId(e.target.value)}
          className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
        >
          <option value="">— Select a printer —</option>
          {printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.kind})
            </option>
          ))}
        </select>
        {action.kind === 'mark-failed' ? (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="error-msg">
              What went wrong?
            </label>
            <Input
              id="error-msg"
              value={errorMsg}
              onChange={(e) => setErrorMsg(e.target.value)}
              placeholder="e.g. Paper jam"
            />
          </div>
        ) : null}
        {dialogError ? <p className="text-sm text-danger">{dialogError}</p> : null}
      </div>
    </Dialog>
  );
}
