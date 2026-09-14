import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Everything the agent knows about hardware: send bytes, and find devices.
 *
 * Mirrors `apps/api/src/modules/printing/printer-drivers.ts` on purpose —
 * the two transports must behave identically, and the agent cannot import
 * from the API (it is a standalone binary with no workspace dependencies).
 */

export interface PrintTarget {
  kind: string;
  address: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Never throws: a failure is a value the caller reports back to the API. */
export async function sendToPrinter(
  target: PrintTarget,
  payload: Buffer,
  timeoutMs = 5_000,
): Promise<SendResult> {
  if (target.kind === 'ESC_POS_USB') return writeUsb(target.address, payload);
  // D181 — an OFFICE printer: the server rendered plain text for it, and the
  // Windows spooler renders that through whatever driver the printer has
  // (Canon, HP, "Generic / Text Only" — all of them print a text document).
  if (target.kind === 'A4_NETWORK') return writeWindowsPrinter(target.address, payload, 'TEXT');
  // MOCK ignores the address, exactly as the server's driver does: the row's
  // address is whatever the form had to put there, not a path on this machine.
  if (target.kind === 'MOCK') return writeDevice('./agent-spool.bin', payload);
  if (target.kind === 'A4_NETWORK') {
    return { ok: false, error: 'A4_NETWORK printers are not supported by the agent yet' };
  }
  const { host, port } = parseAddress(target.address);
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (result: SendResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(result);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done({ ok: false, error: `Timed out talking to ${host}:${port}` }));
    socket.on('error', (err: Error) => done({ ok: false, error: `${host}:${port} — ${err.message}` }));
    socket.on('connect', () => {
      socket.write(payload, (err) => {
        if (err) {
          done({ ok: false, error: `${host}:${port} — ${err.message}` });
          return;
        }
        socket.end(() => done({ ok: true }));
      });
    });
  });
}

/**
 * D181 — a USB printer, which is a different animal per platform.
 *
 * On Windows the spooler owns the device and there is no path a process can
 * open, so the address is the printer's WINDOWS NAME ("POS-80") and the bytes
 * go through winspool.drv as a RAW document (see scripts/windows-raw-printer.ps1
 * — the same approach a Windows POS vendor's own utility takes). On Linux the
 * kernel exposes the printer as a character device and the address is its
 * path (/dev/usb/lp0), written directly.
 */
async function writeUsb(address: string, payload: Buffer): Promise<SendResult> {
  if (process.platform !== 'win32') return writeDevice(address, payload);
  return writeWindowsPrinter(address, payload, 'RAW');
}

/**
 * Hand a document to the Windows spooler by printer name. RAW passes the
 * bytes through untouched (ESC/POS to a thermal printer); TEXT has the helper
 * render plain text as a page through the printer's own driver (a KOT on an
 * office printer's A4 page) — via GDI, not winspool's TEXT datatype, which the
 * class drivers Windows auto-installs for network printers reject.
 */
async function writeWindowsPrinter(
  address: string,
  payload: Buffer,
  dataType: 'RAW' | 'TEXT',
): Promise<SendResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Windows printer names are only reachable from a Windows agent' };
  }
  // Resolved against THIS file, not the working directory: a service manager
  // starts the agent from wherever it likes, and a helper looked up from cwd
  // is the first thing that breaks after "it worked when I ran it by hand".
  const script = resolve(__dirname, '..', 'scripts', 'windows-raw-printer.ps1');
  if (!existsSync(script)) {
    return { ok: false, error: `Windows print helper missing: ${script}` };
  }
  const tmp = join(tmpdir(), `axlo-print-${randomUUID()}.bin`);
  try {
    writeFileSync(tmp, payload);
    return await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-PrinterName',
      address,
      '-FilePath',
      tmp,
      '-DataType',
      dataType,
    ]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone, or never written — nothing to clean */
    }
  }
}

function run(command: string, args: string[]): Promise<SendResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once('error', (err: Error) => resolvePromise({ ok: false, error: err.message }));
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ ok: true });
      else resolvePromise({ ok: false, error: `${command} exited ${code}: ${stderr.trim() || 'no output'}` });
    });
  });
}

function writeDevice(path: string, payload: Buffer): Promise<SendResult> {
  return new Promise((resolvePromise) => {
    const stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', (err: Error) => resolvePromise({ ok: false, error: `${path} — ${err.message}` }));
    stream.end(payload, () => resolvePromise({ ok: true }));
  });
}

export function parseAddress(address: string): { host: string; port: number } {
  const trimmed = (address ?? '').trim();
  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0) return { host: trimmed, port: 9100 };
  const port = Number(trimmed.slice(idx + 1));
  return Number.isInteger(port) && port > 0 && port < 65536
    ? { host: trimmed.slice(0, idx), port }
    : { host: trimmed, port: 9100 };
}

export interface Discovered {
  host: string;
  port: number;
  latencyMs: number;
  /**
   * D183 — whether the device answered a DLE EOT status query like a receipt
   * printer. An office printer listens on 9100 too (a Canon G3010 was the
   * first found), and offering it as a receipt printer means ESC/POS bytes
   * on an inkjet; undefined when the check could not run.
   */
  escpos?: boolean;
}

/**
 * Scan the LAN this machine is on for devices answering on the printer
 * port. THIS is why the agent exists for discovery too: the shop's network
 * is only visible from inside the shop.
 */
export async function scanLan(port: number): Promise<Discovered[]> {
  const subnets = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const [a, b] = address.address.split('.').map(Number);
      const isPrivate =
        a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (!isPrivate) continue;
      const parts = address.address.split('.');
      subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
    }
  }

  const found: Discovered[] = [];
  for (const prefix of subnets) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    for (let i = 0; i < hosts.length; i += 64) {
      const batch = hosts.slice(i, i + 64);
      const results = await Promise.all(batch.map((host) => probe(host, port)));
      for (const result of results) if (result) found.push(result);
    }
  }
  // Only the few that answered get the second, slower question.
  await Promise.all(
    found.map(async (d) => {
      const verdict = await probeEscPos(d.host, d.port);
      if (verdict !== 'UNREACHABLE') d.escpos = verdict === 'ESC_POS';
    }),
  );
  return found;
}

/**
 * Mirrors the server's `probeEscPos`: DLE EOT 1 asks for printer status, and
 * a real ESC/POS printer answers with one byte. Anything else on port 9100
 * (an office printer's raw port, a print server) stays silent.
 */
export function probeEscPos(
  host: string,
  port: number,
  timeoutMs = 1_500,
): Promise<'ESC_POS' | 'SILENT' | 'UNREACHABLE'> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (verdict: 'ESC_POS' | 'SILENT' | 'UNREACHABLE') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(verdict);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('error', () => done('UNREACHABLE'));
    socket.on('timeout', () => done(socket.connecting ? 'UNREACHABLE' : 'SILENT'));
    socket.on('connect', () => socket.write(Buffer.from([0x10, 0x04, 0x01])));
    socket.on('data', () => done('ESC_POS'));
    socket.on('close', () => done('SILENT'));
  });
}

/**
 * A printer the Windows spooler knows on THIS machine — what a USB or
 * office printer's "address" actually is on Windows. Reported with each
 * heartbeat so the settings screen can offer the names instead of asking
 * the owner to copy one from "Printers & scanners" without a typo.
 */
export interface LocalPrinter {
  name: string;
  driver: string | null;
  port: string | null;
}

/**
 * Parse `Get-Printer | Select-Object Name,DriverName,PortName | ConvertTo-Json`.
 * PowerShell emits a bare object for a single printer and an array for
 * several; anything else (empty output, garbage, a stray warning line)
 * means "no printers reported", never a crash — the heartbeat must go out.
 */
export function parseLocalPrinterList(json: string): LocalPrinter[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim() || 'null');
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const printers: LocalPrinter[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { Name?: unknown; DriverName?: unknown; PortName?: unknown };
    if (typeof r.Name !== 'string' || r.Name.trim() === '') continue;
    printers.push({
      name: r.Name,
      driver: typeof r.DriverName === 'string' && r.DriverName !== '' ? r.DriverName : null,
      port: typeof r.PortName === 'string' && r.PortName !== '' ? r.PortName : null,
    });
  }
  return printers;
}

/** Installed printers on this machine; `[]` off Windows (Linux USB is a device path, not a name). */
export function listLocalPrinters(): Promise<LocalPrinter[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolvePromise) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Printer | Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress',
      ],
      // stdin closed on purpose: with an open pipe, powershell -Command waits
      // on it and only the 10 s guard below ends the call — with nothing.
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    // Get-Printer walks every port, and a WSD printer that has gone quiet can
    // hold it for a long time (15–20 s seen on a busy laptop); the cap is
    // generous because the caller never waits on this — see index.ts.
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolvePromise([]);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise(parseLocalPrinterList(stdout));
    });
  });
}

export function probe(host: string, port: number, timeoutMs = 400): Promise<Discovered | null> {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (value: Discovered | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(null));
    socket.on('error', () => done(null));
    socket.on('connect', () => done({ host, port, latencyMs: Date.now() - startedAt }));
  });
}
