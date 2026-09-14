'use client';

import { Check, Copy, Loader2, Printer, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth, type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { api } from '@/lib/api';
import { kitchenPrinters, kitchenStations, printing } from '@/lib/restaurant/api';
import type {
  KitchenPrinterKind,
  KitchenPrinterView,
  KitchenStationView,
  LocalPrinterView,
  PrintAgentView,
  PrintQueueStatus,
  PrinterDiscoveryView,
  PrinterRole,
} from '@/lib/restaurant/types';

/**
 * D181 — unattended printing, where the owner sets it up.
 *
 * Three things on one tab, in the order an installer meets them: the printers
 * (add, link to stations, test), the agent that reaches them from the cloud
 * (pair once, watch it come online), and the queue — what is waiting and what
 * gave up.
 *
 * Restored from D67's `/settings/printing` page and reshaped as a Settings
 * tab, because that is where every other per-branch setting has lived since
 * D84. D67's per-user printer choice is gone with `UserPrinterPreference`:
 * D152 made the STATION decide the device, so there is nothing personal left
 * to pick.
 *
 * D183 took the "What prints by itself" card away again: every switch on it
 * had an answer the printers themselves already give. Tickets and bills print
 * by default; the bill goes to the cashier printer and an unlinked station to
 * the first kitchen printer (`resolveBillPrinter` / `resolveStationPrinterIds`
 * in the API), so an owner who adds two printers and presses Test print is
 * done. The branch-config fields remain on the API for the rare shop that
 * needs to turn auto-printing off or pin a default.
 */
/** How often the tab re-reads agent liveness on its own (the API marks an agent offline after 120 s). */
export const AGENT_POLL_MS = 5_000;

export function PrintingTab({ session, branchId }: { session: Session; branchId: string }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.KITCHEN_STATION_MANAGE);

  const [printers, setPrinters] = React.useState<KitchenPrinterView[]>([]);
  const [stations, setStations] = React.useState<KitchenStationView[]>([]);
  const [agents, setAgents] = React.useState<PrintAgentView[]>([]);
  const [queue, setQueue] = React.useState<PrintQueueStatus | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [p, s, a, q] = await Promise.all([
      kitchenPrinters.list(session, branchId),
      kitchenStations.list(session, branchId),
      printing.agents(session, branchId),
      printing.queue(session, branchId),
    ]);
    setPrinters(p);
    setStations(s);
    setAgents(a);
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

  /*
   * D183 — the agent's Online badge and the queue counts change on their own
   * (an installer just ran on the counter PC; a ticket just printed), and the
   * person watching this tab is exactly the one who needs to see it without
   * pressing anything. Two cheap reads on a timer; paused while the tab is
   * hidden so a forgotten browser does not poll all night.
   */
  React.useEffect(() => {
    if (status !== 'ready') return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      ticks += 1;
      printing.agents(session, branchId).then(setAgents).catch(() => {});
      if (ticks % 3 === 0) printing.queue(session, branchId).then(setQueue).catch(() => {});
    }, AGENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, session, branchId]);

  if (status === 'loading') {
    return (
      <Card className="max-w-3xl">
        <CardContent className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading printing…
        </CardContent>
      </Card>
    );
  }
  if (status === 'error') {
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
      <QueueCard session={session} queue={queue} canRetry={canManage} onChange={reload} />
    </div>
  );
}

// ── Printers ────────────────────────────────────────────────────────────────

/**
 * D183 — each connection kind carries the three steps that decide whether it
 * will ever print, in the words of the install where each one bit. They sit
 * in the form because the owner adding a printer is the one person who will
 * read them, and a doc on a wiki is not.
 */
const KINDS: {
  value: KitchenPrinterKind;
  label: string;
  addressLabel: string;
  /** True when the address is a Windows printer name on the agent's PC. */
  spooler: boolean;
  steps: string[];
}[] = [
  {
    value: 'ESC_POS_NETWORK',
    label: 'Network — receipt printer with an IP address (cable or Wi-Fi)',
    addressLabel: 'IP address',
    spooler: false,
    steps: [
      'Plug its LAN cable into the router or switch — not into a PC.',
      'Hold FEED while switching it on: the self-test page prints its IP address.',
      'Pick it from the list below, or type the IP. Give it a fixed IP on the router so it never changes.',
    ],
  },
  {
    value: 'ESC_POS_USB',
    label: 'USB — plugged into the PC',
    addressLabel: 'Windows printer name',
    spooler: true,
    steps: [
      'Install the printer’s driver on the PC that runs the print agent, so it shows in Printers & scanners.',
      'A dual-mode Xprinter (XP-365B) must be in receipt mode: rear DIP switch pin 1 OFF, then power it off and on.',
      'Pick its Windows name from the list below — it must match exactly.',
    ],
  },
  // A "Wi-Fi printer" to an owner is an office inkjet or laser on the shop's
  // Wi-Fi (a Canon G3010 was the first). It is reached the way Windows
  // reaches it — by its name on the agent PC — and prints the ticket as a
  // plain-text page. A Wi-Fi RECEIPT printer with an IP address is the LAN
  // kind above; the steps say so.
  {
    value: 'A4_NETWORK',
    label: 'Wi-Fi / office printer — installed on the PC',
    addressLabel: 'Printer on the agent PC',
    spooler: true,
    steps: [
      'Connect the printer to the shop Wi-Fi and add it on the PC that runs the print agent (Settings → Printers & scanners → Add device), so it prints from Windows.',
      'Pick it from the list below — the agent reports every printer that PC has.',
      'Tickets come out as a plain-text page on its normal paper. A Wi-Fi receipt printer that has its own IP address goes under Network cable (LAN) instead.',
    ],
  },
  {
    value: 'MOCK',
    label: 'Test (no hardware)',
    addressLabel: 'Address',
    spooler: false,
    steps: ['Nothing to connect: the ticket is written to a file on the machine that prints.'],
  },
];

const ROLES: { value: PrinterRole; label: string }[] = [
  { value: 'KITCHEN', label: 'Kitchen — prints order tickets' },
  { value: 'CASHIER', label: 'Cashier — prints bills' },
];

/** The server's rule for a printer code, checked here so its message never has to be. */
const CODE_RULE = /^[A-Z][A-Z0-9-]*$/;

/**
 * Windows lists its own print-to-file devices beside the real ones. They are
 * offered last, labelled, rather than hidden: a shop may genuinely want
 * tickets in a PDF while a printer is on order.
 */
const VIRTUAL_PRINTER = /print to pdf|onenote|xps|fax|anydesk/i;

/**
 * How Windows reaches an installed printer, read off its port name. A USB
 * printer sits on `USB001`-style ports; a Wi-Fi or LAN office printer on a
 * WSD or TCP/IP port; the rest are Windows' own print-to-file devices. The
 * USB and Wi-Fi pickers show only their own kind, so the cashier's USB
 * printer is never offered as the office printer or the other way round.
 */
type Attachment = 'usb' | 'network' | 'virtual' | 'unknown';
function attachmentOf(p: LocalPrinterView): Attachment {
  if (VIRTUAL_PRINTER.test(p.name)) return 'virtual';
  const port = (p.port ?? '').toUpperCase();
  if (/^(USB|LPT|COM|DOT4)/.test(port)) return 'usb';
  if (/^(WSD|IP_|TCP|TS_|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.test(port) || /^\\\\/.test(port)) return 'network';
  if (/^(NUL|PORTPROMPT|FILE|AD_|SHRFAX|XPS)/.test(port)) return 'virtual';
  return 'unknown';
}

/** Suggest the next free code for a role: KITCHEN-1, KITCHEN-2, CASHIER-1… */
function suggestCode(role: PrinterRole, existing: readonly string[]): string {
  const prefix = role === 'CASHIER' ? 'CASHIER' : 'KITCHEN';
  const taken = new Set(existing.map((c) => c.toUpperCase()));
  for (let n = 1; n < 100; n += 1) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now() % 1000}`;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(iso).toLocaleString();
}

type DiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error';

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

  /*
   * D183 — what the agent found, shared by the add form and every row's edit
   * form. Fetched only when a form opens: the list is a live view of the
   * shop's network and there is nothing to do with it until someone is
   * choosing an address.
   */
  const [discovery, setDiscovery] = React.useState<PrinterDiscoveryView | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = React.useState<DiscoveryStatus>('idle');
  const loadDiscovery = React.useCallback(async () => {
    setDiscoveryStatus('loading');
    try {
      setDiscovery(await printing.discover(session, branchId));
      setDiscoveryStatus('ready');
    } catch {
      setDiscoveryStatus('error');
    }
  }, [session, branchId]);

  const codes = printers.map((p) => p.code);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Printer className="h-4 w-4" aria-hidden /> Printers
          </CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A kitchen printer prints the tickets for the stations it serves; a station with no
            printer goes to the first kitchen printer. The cashier printer prints the bill.
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
            existingCodes={codes}
            agentOnline={agentOnline}
            discovery={discovery}
            discoveryStatus={discoveryStatus}
            onRefreshDiscovery={loadDiscovery}
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
            existingCodes={codes}
            agentOnline={agentOnline}
            discovery={discovery}
            discoveryStatus={discoveryStatus}
            onRefreshDiscovery={loadDiscovery}
            canManage={canManage}
            onChange={onChange}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Add a printer, or edit one (`initial` set). One form for both because the
 * fields are the same; only the code is fixed once created, since it is the
 * name the queue and the tickets already carry.
 */
function PrinterForm({
  session,
  branchId,
  stations,
  existingCodes,
  agentOnline,
  discovery,
  discoveryStatus,
  onRefreshDiscovery,
  initial,
  onDone,
  onCancel,
}: {
  session: Session;
  branchId: string;
  stations: KitchenStationView[];
  existingCodes: readonly string[];
  agentOnline: boolean;
  discovery: PrinterDiscoveryView | null;
  discoveryStatus: DiscoveryStatus;
  onRefreshDiscovery: () => Promise<void>;
  initial?: KitchenPrinterView;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [role, setRole] = React.useState<PrinterRole>(initial?.role ?? 'KITCHEN');
  const [code, setCode] = React.useState(initial?.code ?? suggestCode('KITCHEN', existingCodes));
  const [codeTouched, setCodeTouched] = React.useState(editing);
  const [name, setName] = React.useState(initial?.name ?? '');
  const [kind, setKind] = React.useState<KitchenPrinterKind>(initial?.kind ?? 'ESC_POS_NETWORK');
  const [address, setAddress] = React.useState(initial?.address ?? '');
  const [manualName, setManualName] = React.useState(false);
  const [showAllLocal, setShowAllLocal] = React.useState(false);
  const [columns, setColumns] = React.useState<'48' | '32'>(initial?.columns === 32 ? '32' : '48');
  const [stationIds, setStationIds] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const kindInfo: (typeof KINDS)[number] = KINDS.find((k) => k.value === kind) ?? KINDS[0]!;

  // The form is the moment the list is wanted — fetch once when it opens.
  React.useEffect(() => {
    if (discoveryStatus === 'idle') void onRefreshDiscovery();
  }, [discoveryStatus, onRefreshDiscovery]);

  // The suggested code follows the role until the owner types their own.
  const chooseRole = (next: PrinterRole) => {
    setRole(next);
    if (!codeTouched) setCode(suggestCode(next, existingCodes));
  };

  const trimmedCode = code.trim().toUpperCase();
  const codeProblem =
    !editing && trimmedCode.length > 0 && !(CODE_RULE.test(trimmedCode) && trimmedCode.length >= 2 && trimmedCode.length <= 32)
      ? 'A code starts with a letter and uses only upper-case letters, digits and hyphens (2–32 characters).'
      : null;

  // Receipt printers first; a device on 9100 that stayed silent to the status
  // query is offered last and says so — it is almost always an office printer.
  const hosts = React.useMemo(
    () =>
      [...(discovery?.printers ?? [])].sort(
        (a, b) => Number(b.escpos ?? 0.5) - Number(a.escpos ?? 0.5),
      ),
    [discovery],
  );
  const allLocalPrinters = React.useMemo(() => discovery?.localPrinters ?? [], [discovery]);
  // The kind decides which of the PC's printers are its own: USB ports for
  // USB, network ports for Wi-Fi / office. "Show all" is the escape for a
  // port name this guess does not know; the ordering keeps real printers
  // ahead of Windows' print-to-file devices either way.
  const wanted: Attachment = kind === 'ESC_POS_USB' ? 'usb' : 'network';
  const localPrinters = React.useMemo(() => {
    const rank = (p: LocalPrinterView) => {
      const a = attachmentOf(p);
      return a === wanted ? 0 : a === 'unknown' ? 1 : a === 'virtual' ? 3 : 2;
    };
    const list = showAllLocal
      ? [...allLocalPrinters]
      : allLocalPrinters.filter((p) => {
          const a = attachmentOf(p);
          return a === wanted || a === 'unknown';
        });
    return list.sort((a, b) => rank(a) - rank(b));
  }, [allLocalPrinters, wanted, showAllLocal]);
  const hiddenLocalCount = allLocalPrinters.length - localPrinters.length;
  const addressInList = localPrinters.some((p) => p.name === address);
  // A saved name the agent no longer reports still has to be shown as-is.
  const showNamePicker =
    kindInfo.spooler && localPrinters.length > 0 && !manualName && (address === '' || addressInList);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // MOCK needs no address; the driver picks a spool file.
      const finalAddress = kind === 'MOCK' ? address.trim() || 'mock' : address.trim();
      if (initial) {
        // Only what changed: the server's PATCH is partial, and a field sent
        // back unchanged is a field that could be clobbered by mistake.
        const patch: Parameters<typeof kitchenPrinters.update>[3] = {};
        if (name.trim() !== initial.name) patch.name = name.trim();
        if (kind !== initial.kind) patch.kind = kind;
        if (finalAddress !== initial.address) patch.address = finalAddress;
        if (role !== initial.role) patch.role = role;
        if (Number(columns) !== initial.columns) patch.columns = Number(columns);
        if (Object.keys(patch).length > 0) {
          await kitchenPrinters.update(session, branchId, initial.id, patch);
        }
      } else {
        const created = await kitchenPrinters.create(session, branchId, {
          code: trimmedCode,
          name: name.trim(),
          kind,
          address: finalAddress,
          role,
          columns: Number(columns),
        });
        if (role === 'KITCHEN' && stationIds.length > 0) {
          await kitchenPrinters.setStations(session, branchId, created.id, stationIds);
        }
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : editing ? 'Could not save printer' : 'Could not add printer');
    } finally {
      setSaving(false);
    }
  };

  const discoveryLine =
    discoveryStatus === 'loading' ? (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Looking for printers…
      </span>
    ) : discoveryStatus === 'error' ? (
      'Could not look for printers.'
    ) : discovery?.source === 'AGENT' ? (
      <>
        Found by <span className="font-medium">{discovery.agentName}</span>
        {discovery.at ? ` · ${relativeTime(discovery.at)}` : ''}
      </>
    ) : discovery ? (
      'Scanned from the server — no print agent has reported yet.'
    ) : null;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Used for</span>
          <Select
            value={role}
            onChange={(e) => chooseRole(e.target.value as PrinterRole)}
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
          <span className="mb-1 block text-sm font-medium">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={role === 'CASHIER' ? 'Counter' : 'Kitchen'}
            aria-label="Printer name"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            What the queue and the tickets call it.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Connection</span>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as KitchenPrinterKind);
              setAddress('');
              setManualName(false);
            }}
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
          <span className="mb-1 block text-sm font-medium">Code</span>
          <Input
            value={code}
            onChange={(e) => {
              setCodeTouched(true);
              setCode(e.target.value);
            }}
            placeholder="KITCHEN-1"
            aria-label="Printer code"
            disabled={editing}
            aria-invalid={codeProblem ? true : undefined}
          />
          <span className={`mt-1 block text-xs ${codeProblem ? 'text-danger' : 'text-muted-foreground'}`}>
            {codeProblem ??
              (editing ? 'Fixed once created.' : 'Suggested for you. Short and unique on this branch.')}
          </span>
        </label>
      </div>

      <div className="rounded-lg border border-border bg-card p-3" data-testid="how-to-connect">
        <p className="text-sm font-medium">How to connect — {kindInfo.label}</p>
        <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          {kindInfo.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      {kind !== 'MOCK' ? (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{kindInfo.addressLabel}</span>
            <span className="text-xs text-muted-foreground">
              {discoveryLine}
              {discoveryStatus !== 'loading' ? (
                <button
                  type="button"
                  className="ml-2 inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  onClick={() => void onRefreshDiscovery()}
                >
                  <RefreshCw className="h-3 w-3" aria-hidden /> Refresh
                </button>
              ) : null}
            </span>
          </div>

          {showNamePicker ? (
            <>
              <Select
                value={address}
                onChange={(e) => {
                  if (e.target.value === '__manual__') {
                    setManualName(true);
                    setAddress('');
                  } else setAddress(e.target.value);
                }}
                aria-label="Windows printer"
              >
                <option value="">Choose a printer on {discovery?.agentName ?? 'the agent PC'}…</option>
                {localPrinters.map((p) => {
                  const a = attachmentOf(p);
                  const tag =
                    a === 'virtual'
                      ? ' (virtual)'
                      : a !== wanted && a !== 'unknown'
                        ? a === 'usb'
                          ? ' (on USB)'
                          : ' (on the network)'
                        : '';
                  return (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.driver ? ` — ${p.driver}` : ''}
                      {tag}
                    </option>
                  );
                })}
                <option value="__manual__">Type the name myself…</option>
              </Select>
              <span className="mt-1 block text-xs text-muted-foreground">
                {wanted === 'usb'
                  ? 'Printers on a USB port of the PC running the print agent.'
                  : 'Printers the agent PC reaches over the network (Wi-Fi or cable).'}
                {hiddenLocalCount > 0 ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => setShowAllLocal(true)}
                    >
                      Show all {allLocalPrinters.length} printers on that PC
                    </button>
                  </>
                ) : showAllLocal && allLocalPrinters.length > 0 ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => setShowAllLocal(false)}
                    >
                      Show only {wanted === 'usb' ? 'USB' : 'network'} printers
                    </button>
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <>
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
              />
              {kindInfo.spooler ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {localPrinters.length > 0 ? (
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => {
                        setManualName(false);
                        setAddress('');
                      }}
                    >
                      Choose from the agent PC’s printers instead
                    </button>
                  ) : allLocalPrinters.length > 0 ? (
                    <>
                      None of the {allLocalPrinters.length} printers on that PC is on{' '}
                      {wanted === 'usb' ? 'a USB port' : 'the network'}.{' '}
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        onClick={() => {
                          setShowAllLocal(true);
                          setManualName(false);
                          setAddress('');
                        }}
                      >
                        Show all of them
                      </button>
                      , or type the name exactly as Printers &amp; scanners shows it.
                    </>
                  ) : discoveryStatus === 'ready' ? (
                    'The print agent on that PC has not reported its printers yet — pair and start it (version 0.2.0 or newer), then Refresh. Until then, type the name exactly as Printers & scanners shows it.'
                  ) : (
                    'Type the name exactly as Printers & scanners shows it on the agent PC.'
                  )}
                </span>
              ) : null}
            </>
          )}

          {kind === 'ESC_POS_NETWORK' && discoveryStatus === 'ready' ? (
            hosts.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Printers found on the network">
                {hosts.map((h) => {
                  const value = `${h.host}:${h.port}`;
                  const on = address.trim() === value || address.trim() === h.host;
                  const silent = h.escpos === false;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAddress(value)}
                      aria-pressed={on}
                      title={
                        silent
                          ? 'Answers on port 9100 but did not reply like a receipt printer — probably an office printer. Add that under Wi-Fi / office printer instead.'
                          : h.escpos
                            ? 'Replied like a receipt printer'
                            : undefined
                      }
                      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors ${
                        on
                          ? 'border-primary bg-primary text-primary-foreground'
                          : silent
                            ? 'border-dashed border-border bg-card text-muted-foreground hover:border-primary'
                            : 'border-border bg-card hover:border-primary'
                      }`}
                    >
                      {silent ? (
                        <WifiOff className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Wifi className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {h.host}
                      <span className={on ? 'opacity-80' : 'text-muted-foreground'}>
                        ·{' '}
                        {h.escpos
                          ? 'receipt printer'
                          : silent
                            ? 'not a receipt printer'
                            : `${h.latencyMs} ms`}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No printer answered on port {discovery?.port ?? 9100}. Is it plugged into the router
                and switched on? Its self-test page shows the IP — type it above.
              </p>
            )
          ) : null}
        </div>
      ) : null}

      <label className="block sm:w-1/2 sm:pr-2">
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

      {role === 'KITCHEN' && !editing ? (
        <StationPicker stations={stations} selected={stationIds} onChange={setStationIds} />
      ) : null}

      {kindInfo.spooler && !agentOnline ? (
        <p className="rounded-lg border border-warning-rule bg-warning-soft px-3 py-2 text-xs" role="status">
          This printer needs the print agent online on that PC, and no agent is online now. It
          can be {editing ? 'saved' : 'added'}, but nothing will print until the agent is running.
        </p>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button
          isLoading={saving}
          disabled={
            !trimmedCode ||
            Boolean(codeProblem) ||
            !name.trim() ||
            (kind !== 'MOCK' && !address.trim())
          }
          onClick={() => void save()}
        >
          {editing ? 'Save printer' : 'Add printer'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Which stations a KITCHEN printer serves. Empty is allowed: a station nobody
 * serves goes to the branch's first kitchen printer, so a one-printer shop
 * never has to tick anything.
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
        Nothing ticked: a station no printer serves goes to the first kitchen printer added.
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
  existingCodes,
  agentOnline,
  discovery,
  discoveryStatus,
  onRefreshDiscovery,
  canManage,
  onChange,
}: {
  session: Session;
  branchId: string;
  printer: KitchenPrinterView;
  stations: KitchenStationView[];
  existingCodes: readonly string[];
  agentOnline: boolean;
  discovery: PrinterDiscoveryView | null;
  discoveryStatus: DiscoveryStatus;
  onRefreshDiscovery: () => Promise<void>;
  canManage: boolean;
  onChange: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [test, setTest] = React.useState<TestState>({ kind: 'idle' });
  const [editingStations, setEditingStations] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [stationIds, setStationIds] = React.useState<string[]>(printer.stationIds);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

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

  // D183 — gone for good, with the consequences said up front: the queue
  // and the defaults are cleaned server-side, and the dialog names the
  // stations that lose their printer so nobody discovers it at dinner.
  const remove = async () => {
    const served = printer.stationIds
      .map((id) => stations.find((s) => s.id === id)?.name)
      .filter((n): n is string => Boolean(n));
    const ok = await confirm({
      title: `Remove ${printer.name}?`,
      message:
        (served.length > 0
          ? `${served.join(', ')} will have no printer until you link another. `
          : '') +
        'Anything still queued for it is marked failed. Tickets already printed keep their record. This cannot be undone.',
      confirmLabel: 'Remove printer',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await kitchenPrinters.remove(session, branchId, printer.id);
      await onChange();
    } catch (err) {
      setTest({ kind: 'failed', error: err instanceof Error ? err.message : 'Could not remove printer' });
    } finally {
      setBusy(false);
    }
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(printer.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard denied — the address is still on screen */
    }
  };

  const stationNames = printer.stationIds
    .map((id) => stations.find((s) => s.id === id)?.name)
    .filter((n): n is string => Boolean(n));

  const kindInfo = KINDS.find((k) => k.value === printer.kind);
  // D183 — the most common USB/office failure is a name the agent PC does
  // not have; when the agent has told us its names, say so plainly.
  const nameUnknownToAgent =
    Boolean(kindInfo?.spooler) &&
    discovery?.source === 'AGENT' &&
    (discovery.localPrinters?.length ?? 0) > 0 &&
    !discovery.localPrinters.some((p) => p.name === printer.address);

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
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            <span>
              {printer.code} · {kindInfo?.label ?? printer.kind}
            </span>
            {printer.kind !== 'MOCK' ? (
              <>
                <span>· {printer.address}</span>
                <button
                  type="button"
                  onClick={() => void copyAddress()}
                  className="inline-flex items-center rounded p-0.5 hover:text-foreground"
                  aria-label={`Copy address of ${printer.name}`}
                  title="Copy address"
                >
                  {copied ? (
                    <Check className="h-3 w-3" aria-hidden />
                  ) : (
                    <Copy className="h-3 w-3" aria-hidden />
                  )}
                </button>
              </>
            ) : null}
            <span>· {printer.columns === 32 ? '58 mm' : '80 mm'}</span>
          </p>
          {printer.role === 'KITCHEN' && !editingStations ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {stationNames.length > 0
                ? `Prints tickets for ${stationNames.join(', ')}`
                : 'No stations ticked — catches only stations no printer serves'}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditingStations(false);
                setEditing((v) => !v);
              }}
              aria-label={`Edit ${printer.name}`}
            >
              Edit
            </Button>
          ) : null}
          {canManage && printer.role === 'KITCHEN' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
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
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-danger hover:text-danger"
              onClick={() => void remove()}
              aria-label={`Remove ${printer.name}`}
            >
              Remove
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
          {nameUnknownToAgent
            ? ` — the agent PC has no printer called “${printer.address}”; pick it from the list under Edit.`
            : ''}
        </p>
      ) : null}

      {editing ? (
        <div className="mt-3 border-t border-border pt-3">
          <PrinterForm
            session={session}
            branchId={branchId}
            stations={stations}
            existingCodes={existingCodes}
            agentOnline={agentOnline}
            discovery={discovery}
            discoveryStatus={discoveryStatus}
            onRefreshDiscovery={onRefreshDiscovery}
            initial={printer}
            onDone={async () => {
              setEditing(false);
              await onChange();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
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

/**
 * D183 — the API address the agent must be told. It is this app's own API
 * base without the version prefix, because that is the one thing a person
 * at the counter PC cannot know and the installer must ask for: a token is
 * only valid on the API it was paired on (the first customer install pointed
 * at the cloud address while the token lived on a LAN dev API).
 */
export function agentApiUrl(): string {
  return api.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the text is on screen; the operator can select it */
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={label}>
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

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
  const [error, setError] = React.useState<string | null>(null);
  const apiUrl = agentApiUrl();

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

  // D183 — a revoked agent used to sit in this list forever.
  const remove = async (agent: PrintAgentView) => {
    const ok = await confirm({
      title: `Remove ${agent.name}?`,
      message: agent.isActive
        ? 'It disappears from this list and stops printing at its next check-in. Nothing queued is lost. This cannot be undone.'
        : 'It disappears from this list. This cannot be undone.',
      confirmLabel: 'Remove agent',
      tone: 'danger',
    });
    if (!ok) return;
    await printing.removeAgent(session, agent.id);
    await onChange();
  };

  const installCommand = token
    ? `install.cmd -ApiUrl "${apiUrl}" -Token "${token.token}" -Name "${token.name}"`
    : '';
  const agentJson = token
    ? JSON.stringify({ apiUrl, token: token.token, name: token.name }, null, 2)
    : '';

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
            <div className="min-w-0">
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
                {a.lastSeenAt ? `Last seen ${relativeTime(a.lastSeenAt)}` : 'Never checked in'}
                {a.version ? ` · v${a.version}` : ''}
              </p>
              {a.isActive && !a.lastSeenAt ? (
                <p className="mt-0.5 text-xs text-warning">
                  Not installed yet, or installed with a different API address than{' '}
                  <code className="font-mono">{apiUrl}</code>.
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {canManage && a.isActive ? (
                <Button variant="ghost" size="sm" onClick={() => void revoke(a)}>
                  Revoke
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:text-danger"
                  onClick={() => void remove(a)}
                  aria-label={`Remove agent ${a.name}`}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        ))}

        {token ? (
          <div
            className="space-y-3 rounded-lg border border-warning-rule bg-warning-soft p-3 text-sm"
            data-testid="pairing-box"
          >
            <p className="font-medium">“{token.name}” is paired — the token is shown once</p>

            <div>
              <p className="text-xs font-medium">1. API address — the installer asks for this</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-card px-2 py-1 font-mono text-xs">{apiUrl}</code>
                <CopyButton text={apiUrl} label="Copy API address" />
              </div>
            </div>

            <div>
              <p className="text-xs font-medium">2. Token — then this</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-card px-2 py-1 font-mono text-xs">{token.token}</code>
                <CopyButton text={token.token} label="Copy token" />
              </div>
            </div>

            <div>
              <p className="text-xs font-medium">Or one command, in the unzipped agent folder on that PC</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-card px-2 py-1 font-mono text-xs">{installCommand}</code>
                <CopyButton text={installCommand} label="Copy install command" />
              </div>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">agent.json, for a manual install</summary>
              <div className="mt-1 flex items-start gap-2">
                <pre className="flex-1 overflow-x-auto rounded bg-card px-2 py-1 font-mono text-xs">{agentJson}</pre>
                <CopyButton text={agentJson} label="Copy agent.json" />
              </div>
            </details>

            <p className="text-xs text-muted-foreground">
              The token is not stored here and cannot be shown again — pair a new agent if it is
              lost. This card updates by itself when the agent checks in.
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
