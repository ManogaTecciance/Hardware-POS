'use client';

import { Check, Copy, Loader2, Printer, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { kitchenPrinters, kitchenStations, printing, restaurantConfig } from '@/lib/restaurant/api';
import type {
  KitchenPrinterKind,
  KitchenPrinterView,
  KitchenStationView,
  PrintAgentView,
  PrintQueueStatus,
  PrinterRole,
  RestaurantBranchConfigView,
} from '@/lib/restaurant/types';

/**
 * D174 — unattended printing, where the owner sets it up.
 *
 * Four things on one tab, in the order an installer meets them: the printers
 * (add, link to stations, test), the agent that reaches them from the cloud
 * (pair once, watch it come online), the switches that decide what prints by
 * itself, and the queue — what is waiting and what gave up.
 *
 * Restored from D67's `/settings/printing` page and reshaped as a Settings
 * tab, because that is where every other per-branch setting has lived since
 * D84. D67's per-user printer choice is gone with `UserPrinterPreference`:
 * D152 made the STATION decide the device, so there is nothing personal left
 * to pick.
 *
 * Self-saving (like Charges and Hours): the switches write the restaurant
 * branch config row, which is versioned, and must not share a Save button
 * with the document profile the sticky bar below writes.
 */
export function PrintingTab({ session, branchId }: { session: Session; branchId: string }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.KITCHEN_STATION_MANAGE);
  const canConfig = hasPermission(Permission.RESTAURANT_CONFIG_MANAGE);

  const [printers, setPrinters] = React.useState<KitchenPrinterView[]>([]);
  const [stations, setStations] = React.useState<KitchenStationView[]>([]);
  const [agents, setAgents] = React.useState<PrintAgentView[]>([]);
  const [config, setConfig] = React.useState<RestaurantBranchConfigView | null>(null);
  const [queue, setQueue] = React.useState<PrintQueueStatus | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [p, s, a, c, q] = await Promise.all([
      kitchenPrinters.list(session, branchId),
      kitchenStations.list(session, branchId),
      printing.agents(session, branchId),
      restaurantConfig.get(session, branchId),
      printing.queue(session, branchId),
    ]);
    setPrinters(p);
    setStations(s);
    setAgents(a);
    setConfig(c);
    setQueue(q);
  }, [session, branchId]);

  React.useEffect(() => {
    let cancelled = false;
    reload()
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load printing settings');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  if (status === 'loading') {
    return (
      <Card className="max-w-3xl">
        <CardContent className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading printing…
        </CardContent>
      </Card>
    );
  }
  if (status === 'error' || !config) {
    return (
      <Card className="max-w-3xl">
        <CardContent className="py-16 text-center text-sm text-danger">
          {error ?? 'Could not load printing settings.'}
        </CardContent>
      </Card>
    );
  }

  const online = agents.some((a) => a.online);

  return (
    <div className="max-w-3xl space-y-4">
      <PrintersCard
        session={session}
        branchId={branchId}
        printers={printers}
        stations={stations}
        agentOnline={online}
        canManage={canManage}
        onChange={reload}
      />
      <AgentsCard
        session={session}
        branchId={branchId}
        agents={agents}
        canManage={canManage}
        onChange={reload}
      />
      <AutoPrintCard
        session={session}
        branchId={branchId}
        config={config}
        printers={printers}
        canConfig={canConfig}
        onSaved={setConfig}
      />
      <QueueCard session={session} queue={queue} canRetry={canManage} onChange={reload} />
    </div>
  );
}

// ── Printers ────────────────────────────────────────────────────────────────

const KINDS: { value: KitchenPrinterKind; label: string; hint: string }[] = [
  { value: 'ESC_POS_NETWORK', label: 'Network (LAN)', hint: 'IP address, port 9100 — the kitchen printer' },
  { value: 'ESC_POS_USB', label: 'USB', hint: 'The printer’s Windows name, e.g. POS-80' },
  {
    value: 'A4_NETWORK',
    label: 'Office printer (plain text)',
    hint: 'Its Windows name on the agent PC, e.g. Canon G3010 series — prints the ticket as a text page. For testing; needs the agent running on that PC.',
  },
  { value: 'MOCK', label: 'Test (no hardware)', hint: 'Writes to a file on the machine that prints' },
];

const ROLES: { value: PrinterRole; label: string }[] = [
  { value: 'KITCHEN', label: 'Kitchen — prints order tickets' },
  { value: 'CASHIER', label: 'Cashier — prints bills' },
];

function PrintersCard({
  session,
  branchId,
  printers,
  stations,
  agentOnline,
  canManage,
  onChange,
}: {
  session: Session;
  branchId: string;
  printers: KitchenPrinterView[];
  stations: KitchenStationView[];
  agentOnline: boolean;
  canManage: boolean;
  onChange: () => Promise<void>;
}) {
  const [adding, setAdding] = React.useState(false);
  const activeStations = stations.filter((s) => s.isActive);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Printer className="h-4 w-4" aria-hidden /> Printers
          </CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A kitchen printer prints the tickets for the stations it serves. The cashier printer
            prints the bill.
          </p>
        </div>
        {canManage && !adding ? (
          <Button variant="outline" onClick={() => setAdding(true)}>
            Add printer
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <PrinterForm
            session={session}
            branchId={branchId}
            stations={activeStations}
            onDone={async () => {
              setAdding(false);
              await onChange();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {printers.length === 0 && !adding ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No printers yet. Tickets still reach the kitchen board; add a printer to get paper
            as well.
          </p>
        ) : null}
        {printers.map((p) => (
          <PrinterRow
            key={p.id}
            session={session}
            branchId={branchId}
            printer={p}
            stations={activeStations}
            agentOnline={agentOnline}
            canManage={canManage}
            onChange={onChange}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function PrinterForm({
  session,
  branchId,
  stations,
  onDone,
  onCancel,
}: {
  session: Session;
  branchId: string;
  stations: KitchenStationView[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<KitchenPrinterKind>('ESC_POS_NETWORK');
  const [address, setAddress] = React.useState('');
  const [role, setRole] = React.useState<PrinterRole>('KITCHEN');
  const [columns, setColumns] = React.useState<'48' | '32'>('48');
  const [stationIds, setStationIds] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const kindHint = KINDS.find((k) => k.value === kind)?.hint ?? '';

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await kitchenPrinters.create(session, branchId, {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        kind,
        // MOCK needs no address; the driver picks a spool file.
        address: kind === 'MOCK' ? address.trim() || 'mock' : address.trim(),
        role,
        columns: Number(columns),
      });
      if (role === 'KITCHEN' && stationIds.length > 0) {
        await kitchenPrinters.setStations(session, branchId, created.id, stationIds);
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add printer');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Code</span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="KITCHEN-1"
            aria-label="Printer code"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Short and unique on this branch. Upper-case letters, digits, hyphens.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kitchen printer"
            aria-label="Printer name"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Connection</span>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as KitchenPrinterKind)}
            aria-label="Printer connection"
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Address</span>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={
              kind === 'ESC_POS_USB'
                ? 'POS-80'
                : kind === 'A4_NETWORK'
                  ? 'Canon G3010 series'
                  : '192.168.1.60:9100'
            }
            aria-label="Printer address"
            disabled={kind === 'MOCK'}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{kindHint}</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Used for</span>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as PrinterRole)}
            aria-label="Printer role"
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Paper</span>
          <Select
            value={columns}
            onChange={(e) => setColumns(e.target.value as '48' | '32')}
            aria-label="Paper width"
          >
            <option value="48">80 mm (48 characters)</option>
            <option value="32">58 mm (32 characters)</option>
          </Select>
        </label>
      </div>

      {role === 'KITCHEN' ? (
        <StationPicker stations={stations} selected={stationIds} onChange={setStationIds} />
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button
          isLoading={saving}
          disabled={!code.trim() || !name.trim() || (kind !== 'MOCK' && !address.trim())}
          onClick={() => void save()}
        >
          Add printer
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Which stations a KITCHEN printer serves. Empty is allowed and means "the
 * branch default, if I am it": a one-printer shop never has to tick anything.
 */
function StationPicker({
  stations,
  selected,
  onChange,
  disabled,
}: {
  stations: KitchenStationView[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Prints tickets for</p>
      {stations.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No stations on this branch yet. The first order creates Main; link it here after.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {stations.map((s) => {
            const on = selected.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => toggle(s.id)}
                aria-pressed={on}
                className={`inline-flex h-10 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:opacity-50 ${
                  on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card hover:border-primary'
                }`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        Nothing ticked means this printer only prints when it is the branch’s default kitchen
        printer below.
      </p>
    </div>
  );
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'queued'; jobId: string }
  | { kind: 'ok'; via: 'server' | 'agent'; warning?: string }
  | { kind: 'failed'; error: string };

function PrinterRow({
  session,
  branchId,
  printer,
  stations,
  agentOnline,
  canManage,
  onChange,
}: {
  session: Session;
  branchId: string;
  printer: KitchenPrinterView;
  stations: KitchenStationView[];
  agentOnline: boolean;
  canManage: boolean;
  onChange: () => Promise<void>;
}) {
  const [test, setTest] = React.useState<TestState>({ kind: 'idle' });
  const [editingStations, setEditingStations] = React.useState(false);
  const [stationIds, setStationIds] = React.useState<string[]>(printer.stationIds);
  const [busy, setBusy] = React.useState(false);

  /*
   * A queued test page is the agent's to print; poll the job until the agent
   * acks it. Bounded — an agent that never answers leaves the row saying so,
   * not spinning forever.
   */
  React.useEffect(() => {
    if (test.kind !== 'queued') return;
    let cancelled = false;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      printing
        .job(session, test.jobId)
        .then((job) => {
          if (cancelled) return;
          if (job.status === 'PRINTED') setTest({ kind: 'ok', via: 'agent' });
          else if (job.status === 'FAILED')
            setTest({ kind: 'failed', error: job.error ?? 'The agent could not print it' });
          else if (ticks >= 20)
            setTest({ kind: 'failed', error: 'No answer from the print agent after 30 s' });
        })
        .catch(() => {
          if (!cancelled) setTest({ kind: 'failed', error: 'Could not read the job’s outcome' });
        });
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [test, session]);

  const runTest = async () => {
    setTest({ kind: 'running' });
    try {
      const result = await kitchenPrinters.testPrint(session, branchId, printer.id);
      if (result.queued && result.jobId) setTest({ kind: 'queued', jobId: result.jobId });
      else if (result.ok) setTest({ kind: 'ok', via: 'server', warning: result.warning });
      else setTest({ kind: 'failed', error: result.error ?? 'Unknown printer error' });
    } catch (err) {
      setTest({ kind: 'failed', error: err instanceof Error ? err.message : 'Test failed' });
    }
  };

  const saveStations = async () => {
    setBusy(true);
    try {
      await kitchenPrinters.setStations(session, branchId, printer.id, stationIds);
      setEditingStations(false);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    setBusy(true);
    try {
      await kitchenPrinters.update(session, branchId, printer.id, { isActive: !printer.isActive });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const stationNames = printer.stationIds
    .map((id) => stations.find((s) => s.id === id)?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{printer.name}</span>
            <Badge variant={printer.role === 'CASHIER' ? 'info' : 'primary'}>
              {printer.role === 'CASHIER' ? 'Cashier' : 'Kitchen'}
            </Badge>
            {!printer.isActive ? <Badge variant="neutral">Off</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {printer.code} · {KINDS.find((k) => k.value === printer.kind)?.label ?? printer.kind}
            {printer.kind !== 'MOCK' ? ` · ${printer.address}` : ''} ·{' '}
            {printer.columns === 32 ? '58 mm' : '80 mm'}
          </p>
          {printer.role === 'KITCHEN' && !editingStations ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {stationNames.length > 0
                ? `Prints tickets for ${stationNames.join(', ')}`
                : 'Prints only as the branch default kitchen printer'}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && printer.role === 'KITCHEN' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setStationIds(printer.stationIds);
                setEditingStations((v) => !v);
              }}
            >
              Stations
            </Button>
          ) : null}
          {canManage ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleActive()}>
              {printer.isActive ? 'Turn off' : 'Turn on'}
            </Button>
          ) : null}
          {canManage ? (
            <Button
              variant="outline"
              size="sm"
              isLoading={test.kind === 'running' || test.kind === 'queued'}
              disabled={!printer.isActive}
              onClick={() => void runTest()}
              aria-label={`Test print ${printer.name}`}
            >
              Test print
            </Button>
          ) : null}
        </div>
      </div>

      {test.kind === 'queued' ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Sent to the print agent — waiting for it to print…
        </p>
      ) : test.kind === 'ok' && test.warning ? (
        <p className="mt-2 text-xs text-warning">
          Data delivered, but: {test.warning}
        </p>
      ) : test.kind === 'ok' ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-success">
          <Check className="h-3.5 w-3.5" aria-hidden /> Test page printed
          {test.via === 'agent' ? ' through the agent' : ''}.
        </p>
      ) : test.kind === 'failed' ? (
        <p className="mt-2 text-xs text-danger">
          Test failed: {test.error}
          {!agentOnline && printer.kind === 'ESC_POS_NETWORK'
            ? ' — with no print agent online, the server tried to reach the printer itself.'
            : ''}
        </p>
      ) : null}

      {editingStations ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <StationPicker stations={stations} selected={stationIds} onChange={setStationIds} />
          <div className="flex gap-2">
            <Button size="sm" isLoading={busy} onClick={() => void saveStations()}>
              Save stations
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditingStations(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Agents ──────────────────────────────────────────────────────────────────

function AgentsCard({
  session,
  branchId,
  agents,
  canManage,
  onChange,
}: {
  session: Session;
  branchId: string;
  agents: PrintAgentView[];
  canManage: boolean;
  onChange: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [name, setName] = React.useState('');
  const [pairing, setPairing] = React.useState(false);
  const [token, setToken] = React.useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const pair = async () => {
    if (pairing || !name.trim()) return;
    setPairing(true);
    setError(null);
    try {
      const result = await printing.pairAgent(session, branchId, name.trim());
      setToken({ name: result.name, token: result.token });
      setName('');
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not pair the agent');
    } finally {
      setPairing(false);
    }
  };

  const revoke = async (agent: PrintAgentView) => {
    const ok = await confirm({
      title: `Revoke ${agent.name}?`,
      message:
        'The agent stops printing the moment it next checks in. Tickets still reach the kitchen board; nothing queued is lost.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    await printing.revokeAgent(session, agent.id);
    await onChange();
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the token is on screen; the operator can select it */
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Print agent</CardTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          A small program on a PC in the restaurant that reaches the printers on the local
          network. Pair it once; it prints whatever the queue holds.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {agents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
            No agent paired. Without one, the server tries to reach printers itself — which only
            works when the server runs inside the restaurant.
          </p>
        ) : null}
        {agents.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{a.name}</span>
                {!a.isActive ? (
                  <Badge variant="neutral">Revoked</Badge>
                ) : a.online ? (
                  <Badge variant="success">
                    <Wifi className="mr-1 h-3 w-3" aria-hidden /> Online
                  </Badge>
                ) : (
                  <Badge variant="warning">
                    <WifiOff className="mr-1 h-3 w-3" aria-hidden /> Offline
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {a.lastSeenAt
                  ? `Last seen ${new Date(a.lastSeenAt).toLocaleString()}`
                  : 'Never checked in'}
                {a.version ? ` · v${a.version}` : ''}
              </p>
            </div>
            {canManage && a.isActive ? (
              <Button variant="ghost" size="sm" onClick={() => void revoke(a)}>
                Revoke
              </Button>
            ) : null}
          </div>
        ))}

        {token ? (
          <div className="space-y-2 rounded-lg border border-warning-rule bg-warning-soft p-3 text-sm">
            <p className="font-medium">Token for “{token.name}” — shown once</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-card px-2 py-1 font-mono text-xs">
                {token.token}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste it into the agent’s <code>agent.json</code> on the restaurant PC. It is not
              stored here and cannot be shown again — pair a new agent if it is lost.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setToken(null)}>
              Done
            </Button>
          </div>
        ) : null}

        {canManage ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <label className="block flex-1">
              <span className="mb-1 block text-sm font-medium">Pair a new agent</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Front counter PC"
                aria-label="Agent name"
              />
            </label>
            <Button isLoading={pairing} disabled={!name.trim()} onClick={() => void pair()}>
              Pair agent
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

// ── Auto-print switches ─────────────────────────────────────────────────────

function AutoPrintCard({
  session,
  branchId,
  config,
  printers,
  canConfig,
  onSaved,
}: {
  session: Session;
  branchId: string;
  config: RestaurantBranchConfigView;
  printers: KitchenPrinterView[];
  canConfig: boolean;
  onSaved: (next: RestaurantBranchConfigView) => void;
}) {
  const [autoKot, setAutoKot] = React.useState(config.autoPrintKot);
  const [autoBill, setAutoBill] = React.useState(config.autoPrintBill);
  const [copies, setCopies] = React.useState(String(config.billCopies));
  const [kitchenId, setKitchenId] = React.useState(config.defaultKitchenPrinterId ?? '');
  const [cashierId, setCashierId] = React.useState(config.defaultReceiptPrinterId ?? '');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setAutoKot(config.autoPrintKot);
    setAutoBill(config.autoPrintBill);
    setCopies(String(config.billCopies));
    setKitchenId(config.defaultKitchenPrinterId ?? '');
    setCashierId(config.defaultReceiptPrinterId ?? '');
  }, [config]);

  const kitchenPrintersList = printers.filter((p) => p.role === 'KITCHEN' && p.isActive);
  const cashierPrintersList = printers.filter((p) => p.role === 'CASHIER' && p.isActive);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await restaurantConfig.update(session, branchId, {
        autoPrintKot: autoKot,
        autoPrintBill: autoBill,
        billCopies: Math.min(Math.max(Number(copies) || 1, 1), 3),
        defaultKitchenPrinterId: kitchenId || null,
        defaultReceiptPrinterId: cashierId || null,
        expectedVersion: config.version,
      });
      onSaved(next);
      setMessage('Saved. The next order uses these settings.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>What prints by itself</CardTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          The kitchen board always shows every order. These decide what comes out on paper as
          well, without anyone pressing anything.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span id="auto-kot-label" className="text-sm">
              <span className="block font-medium">Print kitchen tickets when an order is sent</span>
              <span className="block text-xs text-muted-foreground">
                One ticket per station, on that station’s printer.
              </span>
            </span>
            <Switch
              checked={autoKot}
              onCheckedChange={setAutoKot}
              disabled={!canConfig}
              aria-labelledby="auto-kot-label"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span id="auto-bill-label" className="text-sm">
              <span className="block font-medium">Print the bill when an order closes</span>
              <span className="block text-xs text-muted-foreground">
                On the cashier printer. Needs one chosen below; otherwise the Print bill button is
                the only way, as before.
              </span>
            </span>
            <Switch
              checked={autoBill}
              onCheckedChange={setAutoBill}
              disabled={!canConfig}
              aria-labelledby="auto-bill-label"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Default kitchen printer</span>
            <Select
              value={kitchenId}
              disabled={!canConfig}
              onChange={(e) => setKitchenId(e.target.value)}
              aria-label="Default kitchen printer"
            >
              <option value="">None</option>
              {kitchenPrintersList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <span className="mt-1 block text-xs text-muted-foreground">
              Used by any station with no printer of its own.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Cashier (bill) printer</span>
            <Select
              value={cashierId}
              disabled={!canConfig}
              onChange={(e) => setCashierId(e.target.value)}
              aria-label="Cashier printer"
            >
              <option value="">None — print from the browser</option>
              {cashierPrintersList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Bill copies</span>
            <Select
              value={copies}
              disabled={!canConfig}
              onChange={(e) => setCopies(e.target.value)}
              aria-label="Bill copies"
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </Select>
          </label>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? <p className="text-sm text-success">{message}</p> : null}

        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button isLoading={saving} disabled={!canConfig} onClick={() => void save()}>
            Save printing
          </Button>
          {!canConfig ? (
            <span className="text-xs text-muted-foreground">
              Your role can view these but not change them.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

function QueueCard({
  session,
  queue,
  canRetry,
  onChange,
}: {
  session: Session;
  queue: PrintQueueStatus | null;
  canRetry: boolean;
  onChange: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onChange();
    } finally {
      setRefreshing(false);
    }
  };
  const retry = async (jobId: string) => {
    await printing.retryJob(session, jobId);
    await onChange();
  };
  if (!queue) return null;
  const quiet =
    queue.pendingKitchenAttempts === 0 &&
    queue.pendingBillJobs === 0 &&
    queue.failedBillJobs.length === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Print queue</CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            What is waiting for a printer, and what gave up.
          </p>
        </div>
        <Button variant="ghost" size="sm" isLoading={refreshing} onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {quiet ? (
          <p className="text-muted-foreground">Nothing waiting. Everything has printed.</p>
        ) : (
          <div className="flex flex-wrap gap-4">
            <span>
              <span className="font-medium">{queue.pendingKitchenAttempts}</span> kitchen
              {queue.pendingKitchenAttempts === 1 ? ' ticket' : ' tickets'} waiting
            </span>
            <span>
              <span className="font-medium">{queue.pendingBillJobs}</span>{' '}
              {queue.pendingBillJobs === 1 ? 'bill' : 'bills'} waiting
            </span>
          </div>
        )}
        {queue.failedBillJobs.length > 0 ? (
          <ul className="space-y-2">
            {queue.failedBillJobs.map((j) => (
              <li
                key={j.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger-soft/40 p-2"
              >
                <span>
                  <span className="font-medium">Bill failed</span>
                  <span className="block text-xs text-muted-foreground">
                    {j.error ?? 'Unknown error'} · {j.attempts}{' '}
                    {j.attempts === 1 ? 'attempt' : 'attempts'} ·{' '}
                    {new Date(j.at).toLocaleString()}
                  </span>
                </span>
                {canRetry ? (
                  <Button size="sm" variant="outline" onClick={() => void retry(j.id)}>
                    Retry
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
