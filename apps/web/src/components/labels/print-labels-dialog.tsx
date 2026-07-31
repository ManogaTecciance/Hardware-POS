'use client';

import { AlertTriangle, Loader2, Minus, Plus, Printer } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { Session } from '@/lib/auth';
import {
  BrowserPrintUnavailableError,
  detectBrowserPrint,
  getDefaultPrinter,
  listPrinters,
  sendZpl,
  type ZebraDevice,
} from '@/lib/browser-print';
import {
  buildLabelZpl,
  fetchRollProfiles,
  type RollKey,
  type RollProfile,
} from '@/lib/labels-api';
import { cn } from '@/lib/utils';

import { LabelPreview } from './label-preview';

export interface LabelTarget {
  id: string;
  name: string;
  sku: string | null;
  price?: number | null;
}

type AgentState =
  | { status: 'checking' }
  | { status: 'ready'; base: string; printers: ZebraDevice[]; selected: ZebraDevice }
  | { status: 'missing' };

/**
 * Barcode label printing for one or many products.
 *
 * Server builds the ZPL (single source of truth for layout); this dialog picks
 * the roll and quantities, previews it, and relays the payload to the Zebra
 * Browser Print agent on the cashier's machine.
 */
export function PrintLabelsDialog({
  session,
  open,
  onClose,
  targets,
}: {
  session: Session;
  open: boolean;
  onClose: () => void;
  targets: LabelTarget[];
}) {
  const [profiles, setProfiles] = React.useState<RollProfile[]>([]);
  const [roll, setRoll] = React.useState<RollKey>('double');
  const [copies, setCopies] = React.useState<Record<string, number>>({});
  const [startOffset, setStartOffset] = React.useState(0);
  const [agent, setAgent] = React.useState<AgentState>({ status: 'checking' });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const profile = profiles.find((p) => p.key === roll);
  const printable = targets.filter((t) => (t.sku ?? '').trim());
  const missingSku = targets.filter((t) => !(t.sku ?? '').trim());

  // Reset per-open so a previous run's state never leaks into the next.
  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setDone(null);
    setStartOffset(0);
    setCopies(Object.fromEntries(targets.map((t) => [t.id, 1])));
  }, [open, targets]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchRollProfiles(session)
      .then((list) => !cancelled && setProfiles(list))
      .catch(() => !cancelled && setError('Could not load label roll settings.'));
    return () => {
      cancelled = true;
    };
  }, [open, session]);

  // Probe for the local print agent; "missing" is a normal state, not a failure.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAgent({ status: 'checking' });
    (async () => {
      const base = await detectBrowserPrint();
      if (cancelled) return;
      if (!base) {
        setAgent({ status: 'missing' });
        return;
      }
      const printers = await listPrinters(base).catch(() => []);
      const selected = (await getDefaultPrinter(base)) ?? printers[0];
      if (cancelled) return;
      setAgent(selected ? { status: 'ready', base, printers, selected } : { status: 'missing' });
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const totalStickers = printable.reduce((sum, t) => sum + (copies[t.id] ?? 1), 0);

  const setCopiesFor = (id: string, value: number) =>
    setCopies((prev) => ({ ...prev, [id]: Math.max(1, Math.min(1000, value)) }));

  const previewStickers = printable.flatMap((t) =>
    Array.from({ length: Math.min(copies[t.id] ?? 1, 12) }, () => ({
      name: t.name,
      sku: t.sku,
      price: t.price,
    })),
  );

  const handlePrint = async () => {
    if (agent.status !== 'ready' || printable.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await buildLabelZpl(session, {
        roll,
        startOffset,
        lines: printable.map((t) => ({ productId: t.id, copies: copies[t.id] ?? 1 })),
      });
      await sendZpl(agent.base, agent.selected, result.zpl);
      setDone(
        `Sent ${result.stickerCount} label${result.stickerCount === 1 ? '' : 's'} ` +
          `(${result.rowCount} row${result.rowCount === 1 ? '' : 's'}) to ${agent.selected.name}.`,
      );
    } catch (err) {
      setError(
        err instanceof BrowserPrintUnavailableError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Printing failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      className="sm:max-w-3xl"
      title={targets.length === 1 ? 'Print barcode label' : `Print barcode labels`}
      description={
        targets.length === 1 && targets[0]
          ? targets[0].name
          : `${targets.length} products selected · ${totalStickers} sticker${totalStickers === 1 ? '' : 's'}`
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          <Button
            onClick={handlePrint}
            disabled={busy || agent.status !== 'ready' || printable.length === 0}
            isLoading={busy}
          >
            <Printer className="h-4 w-4" />
            Print {totalStickers} label{totalStickers === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {/* ── settings ── */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="roll">Sticker roll</Label>
            <Select id="roll" value={roll} onChange={(e) => setRoll(e.target.value as RollKey)}>
              {profiles.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>

          {profile && profile.columns > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="offset">Skip used stickers</Label>
              <Select
                id="offset"
                value={String(startOffset)}
                onChange={(e) => setStartOffset(Number(e.target.value))}
              >
                {Array.from({ length: profile.columns }, (_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? 'Start of a fresh row' : `Skip ${i}`}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Resume on a part-used row instead of wasting the remaining stickers.
              </p>
            </div>
          ) : null}

          {/* per-product quantities */}
          <div className="space-y-2">
            <Label>Quantity</Label>
            <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
              {printable.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded-lg border border-border p-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.sku}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Fewer labels for ${t.name}`}
                      onClick={() => setCopiesFor(t.id, (copies[t.id] ?? 1) - 1)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      value={String(copies[t.id] ?? 1)}
                      onChange={(e) => setCopiesFor(t.id, Number(e.target.value.replace(/\D/g, '')) || 1)}
                      inputMode="numeric"
                      aria-label={`Labels for ${t.name}`}
                      className="h-8 w-14 text-center"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`More labels for ${t.name}`}
                      onClick={() => setCopiesFor(t.id, (copies[t.id] ?? 1) + 1)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── preview + status ── */}
        <div className="space-y-3">
          {profile ? (
            <LabelPreview
              profile={profile}
              stickers={previewStickers}
              startOffset={startOffset}
            />
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading preview…</div>
          )}

          <PrinterStatus agent={agent} onSelect={(device) =>
            setAgent((prev) => (prev.status === 'ready' ? { ...prev, selected: device } : prev))
          } />
        </div>
      </div>

      {missingSku.length > 0 ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {missingSku.length} selected product{missingSku.length === 1 ? '' : 's'} ha
            {missingSku.length === 1 ? 's' : 've'} no SKU, so there is nothing to encode as a
            barcode. Add a SKU to include {missingSku.length === 1 ? 'it' : 'them'}.
          </span>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      {done ? <p className="mt-3 text-sm text-success">{done}</p> : null}
    </Dialog>
  );
}

function PrinterStatus({
  agent,
  onSelect,
}: {
  agent: AgentState;
  onSelect: (device: ZebraDevice) => void;
}) {
  if (agent.status === 'checking') {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking for the label printer…
      </p>
    );
  }

  if (agent.status === 'missing') {
    return (
      <div className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
        <div className="font-semibold">Label printer not detected</div>
        <p className="mt-0.5">
          Install <span className="font-medium">Zebra Browser Print</span> on this computer (or
          start it if already installed), then reopen this dialog.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="success">Printer ready</Badge>
      </div>
      {agent.printers.length > 1 ? (
        <Select
          aria-label="Printer"
          value={agent.selected.uid}
          onChange={(e) => {
            const next = agent.printers.find((p) => p.uid === e.target.value);
            if (next) onSelect(next);
          }}
          className={cn('h-8 text-xs')}
        >
          {agent.printers.map((p) => (
            <option key={p.uid} value={p.uid}>
              {p.name}
            </option>
          ))}
        </Select>
      ) : (
        <p className="truncate text-xs text-muted-foreground">{agent.selected.name}</p>
      )}
    </div>
  );
}
