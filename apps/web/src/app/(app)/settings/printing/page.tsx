'use client';

import * as React from 'react';
import { Loader2, Plus, Printer, RefreshCw, Search, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Toast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  kitchenPrinters,
  printing,
  restaurantConfig,
} from '@/lib/restaurant/api';
import type {
  DiscoveredPrinter,
  DiscoveryResult,
  MyPrinters,
  PrintAgentView,
} from '@/lib/restaurant/api';
import type { KitchenPrinterView } from '@/lib/restaurant/types';

/**
 * D67 — Settings → Printing.
 *
 * Two audiences on one page, deliberately separated:
 *
 *  • **The owner** adds the shop's printers once (assisted by a network
 *    scan), marks each KITCHEN or CASHIER, sets the branch defaults, and
 *    pairs the on-site print agent when the API is in the cloud.
 *  • **Every user** — waiter, cashier, owner — picks THEIR default kitchen
 *    and cashier printer from that list. That block is visible to everyone;
 *    the owner blocks are gated on `kitchen:station:manage`, which a WAITER
 *    does not hold.
 */
export default function PrintingSettingsPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.KITCHEN_STATION_MANAGE);
  const branchId = session?.branchId ?? null;

  const [printers, setPrinters] = React.useState<KitchenPrinterView[]>([]);
  const [mine, setMine] = React.useState<MyPrinters | null>(null);
  const [agents, setAgents] = React.useState<PrintAgentView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [toast, setToast] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!session || !branchId) return;
    setLoading(true);
    try {
      const [list, my, agentList] = await Promise.all([
        kitchenPrinters.list(session, branchId).catch(() => [] as KitchenPrinterView[]),
        printing.myPrinters(session, branchId).catch(() => null),
        canManage
          ? printing.agents.list(session, branchId).catch(() => [] as PrintAgentView[])
          : Promise.resolve([] as PrintAgentView[]),
      ]);
      setPrinters(list);
      setMine(my);
      setAgents(agentList);
    } finally {
      setLoading(false);
    }
  }, [session, branchId, canManage]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!session) return null;
  if (!branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Printing" description="Printers, defaults and the print queue." />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator for branch access.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Printing"
        description={`${session.branchName} — kitchen tickets print when an order is sent; the bill prints when it is closed.`}
      />

      {error ? (
        <p className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <MyPrintersCard
        printers={printers}
        mine={mine}
        loading={loading}
        onSave={async (body) => {
          await printing.setMyPrinters(session, body);
          setToast('Your printers were saved.');
          await load();
        }}
      />

      {canManage ? (
        <>
          <WorkspacePrintersCard
            branchId={branchId}
            printers={printers}
            loading={loading}
            onChanged={load}
            onToast={setToast}
            onError={setError}
          />
          <BranchDefaultsCard branchId={branchId} printers={printers} onToast={setToast} />
          <AgentsCard branchId={branchId} agents={agents} onChanged={load} onToast={setToast} />
        </>
      ) : null}

      {toast ? <Toast message={toast} tone="success" /> : null}
    </div>
  );
}

// ── Every user: my default printers ──────────────────────────────────────────

function MyPrintersCard({
  printers,
  mine,
  loading,
  onSave,
}: {
  printers: KitchenPrinterView[];
  mine: MyPrinters | null;
  loading: boolean;
  onSave: (body: { kitchenPrinterId: string | null; cashierPrinterId: string | null }) => Promise<void>;
}) {
  const [kitchenId, setKitchenId] = React.useState('');
  const [cashierId, setCashierId] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setKitchenId(mine?.kitchenPrinterId ?? '');
    setCashierId(mine?.cashierPrinterId ?? '');
  }, [mine]);

  const kitchenOptions = printers.filter((p) => p.role === 'KITCHEN' && p.isActive);
  const cashierOptions = printers.filter((p) => p.role === 'CASHIER' && p.isActive);
  const nameOf = (id: string | null) => printers.find((p) => p.id === id)?.name ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My printers</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your own defaults. Orders you send print here; leave a field on “Use branch default”
          to follow the workspace setting.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="my-kitchen">Kitchen printer</Label>
                <Select
                  id="my-kitchen"
                  value={kitchenId}
                  onChange={(e) => setKitchenId(e.target.value)}
                >
                  <option value="">
                    Use branch default
                    {nameOf(mine?.branchDefaultKitchenPrinterId ?? null)
                      ? ` (${nameOf(mine?.branchDefaultKitchenPrinterId ?? null)})`
                      : ''}
                  </option>
                  {kitchenOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.address}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="my-cashier">Cashier printer</Label>
                <Select
                  id="my-cashier"
                  value={cashierId}
                  onChange={(e) => setCashierId(e.target.value)}
                >
                  <option value="">
                    Use branch default
                    {nameOf(mine?.branchDefaultCashierPrinterId ?? null)
                      ? ` (${nameOf(mine?.branchDefaultCashierPrinterId ?? null)})`
                      : ''}
                  </option>
                  {cashierOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.address}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            {printers.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
                No printers have been added to this workspace yet. An owner adds them below.
              </p>
            ) : null}
            <Button
              isLoading={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave({
                    kitchenPrinterId: kitchenId || null,
                    cashierPrinterId: cashierId || null,
                  });
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save my printers
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Owner: the workspace's printers ──────────────────────────────────────────

function WorkspacePrintersCard({
  branchId,
  printers,
  loading,
  onChanged,
  onToast,
  onError,
}: {
  branchId: string;
  printers: KitchenPrinterView[];
  loading: boolean;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { session } = useAuth();
  const [scan, setScan] = React.useState<DiscoveryResult | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const runScan = async () => {
    if (!session) return;
    setScanning(true);
    onError(null);
    try {
      setScan(await printing.discover(session, branchId));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const addFrom = async (found: DiscoveredPrinter, role: 'KITCHEN' | 'CASHIER') => {
    if (!session) return;
    const address = `${found.host}:${found.port}`;
    setBusyId(address);
    onError(null);
    try {
      // A stable code from the address: re-adding the same device twice is a
      // 409 the operator can read, not a duplicate row that prints twice.
      const code = `P-${found.host.replace(/\./g, '-')}`.toUpperCase().slice(0, 32);
      await kitchenPrinters.create(session, branchId, {
        code,
        name: `${role === 'KITCHEN' ? 'Kitchen' : 'Cashier'} ${found.host}`,
        kind: 'ESC_POS_NETWORK',
        address,
        role,
      } as never);
      onToast(`Added ${address} as a ${role.toLowerCase()} printer.`);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add printer');
    } finally {
      setBusyId(null);
    }
  };

  const test = async (printer: KitchenPrinterView) => {
    if (!session) return;
    setBusyId(printer.id);
    onError(null);
    try {
      const result = await kitchenPrinters.testPrint(session, branchId, printer.id);
      if (result.ok) onToast(`Test page sent to ${printer.name}.`);
      else onError(`${printer.name}: ${result.error ?? 'no answer'}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Test print failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Workspace printers</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Printers on the shop network. Add each one once; everybody then picks their defaults
            from this list.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Search className="h-3.5 w-3.5" />}
          isLoading={scanning}
          onClick={() => void runScan()}
        >
          Scan network
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : printers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-sm text-muted-foreground">
            No printers yet. Scan the network below, or add one by IP address.
          </p>
        ) : (
          <ul className="space-y-2">
            {printers.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <Printer className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                    {p.name}
                    <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {p.role}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.address} · {p.kind} · {p.columns} cols
                    {p.isActive ? '' : ' · inactive'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Select
                    aria-label={`Role for ${p.name}`}
                    className="w-36"
                    value={p.role}
                    onChange={async (e) => {
                      if (!session) return;
                      await kitchenPrinters.update(session, branchId, p.id, {
                        role: e.target.value as 'KITCHEN' | 'CASHIER',
                      });
                      await onChanged();
                    }}
                  >
                    <option value="KITCHEN">Kitchen</option>
                    <option value="CASHIER">Cashier</option>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    isLoading={busyId === p.id}
                    onClick={() => void test(p)}
                  >
                    Test print
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {scan ? (
          <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">
              {scan.source === 'AGENT'
                ? `Reported by the on-site agent${scan.agentName ? ` “${scan.agentName}”` : ''}.`
                : `Scanned by the server${scan.subnets.length ? ` on ${scan.subnets.join(', ')}` : ''}.`}
              {scan.note ? ` ${scan.note}` : ''}
            </p>
            {scan.printers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing answered on port {scan.port}. Check the printer is powered on and on this
                network, or add it by IP below.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {scan.printers.map((found) => {
                  const address = `${found.host}:${found.port}`;
                  const already = printers.some((p) => p.address === address);
                  return (
                    <li
                      key={address}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2"
                    >
                      <span className="text-sm">
                        {address}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {found.latencyMs}ms
                        </span>
                      </span>
                      {already ? (
                        <span className="text-xs text-muted-foreground">already added</span>
                      ) : (
                        <span className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            isLoading={busyId === address}
                            onClick={() => void addFrom(found, 'KITCHEN')}
                          >
                            Add as kitchen
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            isLoading={busyId === address}
                            onClick={() => void addFrom(found, 'CASHIER')}
                          >
                            Add as cashier
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        <ManualAddRow branchId={branchId} onChanged={onChanged} onToast={onToast} onError={onError} />
      </CardContent>
    </Card>
  );
}

/** Manual entry — the fallback for a printer that ignores connect probes. */
function ManualAddRow({
  branchId,
  onChanged,
  onToast,
  onError,
}: {
  branchId: string;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { session } = useAuth();
  const [name, setName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [role, setRole] = React.useState<'KITCHEN' | 'CASHIER'>('KITCHEN');
  // A USB printer has no address to scan for, so it can only ever be added
  // here — the reason this row is not just a fallback for a shy network box.
  const [kind, setKind] = React.useState<'ESC_POS_NETWORK' | 'ESC_POS_USB'>('ESC_POS_NETWORK');
  const [busy, setBusy] = React.useState(false);

  const add = async () => {
    if (!session || !name.trim() || !address.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await kitchenPrinters.create(session, branchId, {
        code: `P-${Date.now().toString(36).toUpperCase()}`,
        name: name.trim(),
        kind,
        address: address.trim(),
        role,
      } as never);
      onToast(`Added ${name.trim()}.`);
      setName('');
      setAddress('');
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add printer');
    } finally {
      setBusy(false);
    }
  };

  const usb = kind === 'ESC_POS_USB';
  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto_auto]">
        <Input placeholder="Name (e.g. Kitchen printer)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          placeholder={usb ? '\\\\localhost\\KITCHEN or /dev/usb/lp0' : '192.168.1.50:9100'}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Select
          aria-label="Connection"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'ESC_POS_NETWORK' | 'ESC_POS_USB')}
        >
          <option value="ESC_POS_NETWORK">Network</option>
          <option value="ESC_POS_USB">USB / shared</option>
        </Select>
        <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as 'KITCHEN' | 'CASHIER')}>
          <option value="KITCHEN">Kitchen</option>
          <option value="CASHIER">Cashier</option>
        </Select>
        <Button leftIcon={<Plus className="h-4 w-4" />} isLoading={busy} onClick={() => void add()}>
          Add
        </Button>
      </div>
      {usb ? (
        <p className="text-xs text-muted-foreground">
          A USB printer must be attached to the machine running the server. On Windows, share it
          (Printer properties → Sharing) and use <code>{'\\\\localhost\\SHARENAME'}</code>; install it with
          the “Generic / Text Only” driver so the raw bytes pass through. On Linux, use the device
          path, e.g. <code>/dev/usb/lp0</code>.
        </p>
      ) : null}
    </div>
  );
}

// ── Owner: branch defaults + switches ────────────────────────────────────────

function BranchDefaultsCard({
  branchId,
  printers,
  onToast,
}: {
  branchId: string;
  printers: KitchenPrinterView[];
  onToast: (message: string) => void;
}) {
  const { session } = useAuth();
  const [kitchenId, setKitchenId] = React.useState('');
  const [cashierId, setCashierId] = React.useState('');
  const [autoKot, setAutoKot] = React.useState(true);
  const [autoBill, setAutoBill] = React.useState(true);
  const [copies, setCopies] = React.useState('1');
  const [version, setVersion] = React.useState<number>(0);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!session) return;
    void restaurantConfig
      .get(session, branchId)
      .then((cfg) => {
        const c = cfg as unknown as {
          defaultKitchenPrinterId?: string | null;
          defaultReceiptPrinterId?: string | null;
          autoPrintKot?: boolean;
          autoPrintBill?: boolean;
          billCopies?: number;
          version: number;
        };
        setKitchenId(c.defaultKitchenPrinterId ?? '');
        setCashierId(c.defaultReceiptPrinterId ?? '');
        setAutoKot(c.autoPrintKot ?? true);
        setAutoBill(c.autoPrintBill ?? true);
        setCopies(String(c.billCopies ?? 1));
        setVersion(c.version);
      })
      .catch(() => undefined);
  }, [session, branchId]);

  const save = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await restaurantConfig.update(session, branchId, {
        defaultKitchenPrinterId: kitchenId || null,
        defaultReceiptPrinterId: cashierId || null,
        autoPrintKot: autoKot,
        autoPrintBill: autoBill,
        billCopies: Number(copies) || 1,
        expectedVersion: version,
      } as never);
      onToast('Branch printing settings saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Branch defaults</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Used by anyone who has not chosen their own. Turning a switch off keeps the tickets
          queued for manual printing instead of sending them automatically.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="branch-kitchen">Default kitchen printer</Label>
            <Select id="branch-kitchen" value={kitchenId} onChange={(e) => setKitchenId(e.target.value)}>
              <option value="">None</option>
              {printers.filter((p) => p.role === 'KITCHEN').map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch-cashier">Default cashier printer</Label>
            <Select id="branch-cashier" value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
              <option value="">None</option>
              {printers.filter((p) => p.role === 'CASHIER').map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoKot} onChange={(e) => setAutoKot(e.target.checked)} />
            Auto-print kitchen tickets
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoBill} onChange={(e) => setAutoBill(e.target.checked)} />
            Auto-print the bill on close
          </label>
          <label className="flex items-center gap-2 text-sm">
            Bill copies
            <Input
              className="w-16"
              inputMode="numeric"
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
            />
          </label>
        </div>
        <Button isLoading={busy} onClick={() => void save()}>
          Save branch settings
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Owner: the on-site agent ─────────────────────────────────────────────────

function AgentsCard({
  branchId,
  agents,
  onChanged,
  onToast,
}: {
  branchId: string;
  agents: PrintAgentView[];
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const { session } = useAuth();
  const [name, setName] = React.useState('');
  const [token, setToken] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">On-site print agent</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Needed when the server cannot reach the printers itself — which is the case for the
          hosted app, because the printers live on your shop network. Install the agent on one
          always-on machine in the shop; every tablet keeps using the browser as normal.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {agents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface p-3 text-xs text-muted-foreground">
            No agent paired. If the server is on the same network as the printers (a
            single-machine install), you do not need one.
          </p>
        ) : (
          <ul className="space-y-2">
            {agents.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {a.name}
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-[10px] uppercase ${
                        a.online
                          ? 'bg-success-soft text-success'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {a.online ? 'online' : a.isActive ? 'offline' : 'revoked'}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.version ? `v${a.version} · ` : ''}
                    {a.lastSeenAt ? `last seen ${new Date(a.lastSeenAt).toLocaleString()}` : 'never connected'}
                  </p>
                </div>
                {a.isActive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={async () => {
                      if (!session) return;
                      await printing.agents.revoke(session, a.id);
                      onToast(`${a.name} revoked.`);
                      await onChanged();
                    }}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input
            placeholder="Agent name (e.g. Front counter PC)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            isLoading={busy}
            leftIcon={<RefreshCw className="h-4 w-4" />}
            onClick={async () => {
              if (!session || !name.trim()) return;
              setBusy(true);
              try {
                const paired = await printing.agents.pair(session, branchId, name.trim());
                // Shown once, never stored in plaintext — the same discipline
                // the console applies to passwords.
                setToken(paired.token);
                setName('');
                await onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Pair agent
          </Button>
        </div>

        {token ? (
          <div className="space-y-1 rounded-xl border border-warning/40 bg-warning-soft p-3">
            <p className="text-sm font-medium text-warning">
              Copy this token now — it is shown once.
            </p>
            <code className="block break-all rounded bg-surface p-2 text-xs">{token}</code>
            <p className="text-xs text-muted-foreground">
              Put it in the agent&rsquo;s <code>agent.json</code> next to your API URL, then start
              the agent. It appears above as “online” within a few seconds.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
