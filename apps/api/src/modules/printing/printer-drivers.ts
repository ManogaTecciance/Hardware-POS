import { createWriteStream, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import { KitchenPrinterKind } from '@hardware-pos/database';

/**
 * D67 — how bytes physically reach a printer.
 *
 * The API drives printers DIRECTLY (raw TCP 9100 / a spool file). That is
 * correct for the deployment this ships into — the API runs on the shop's
 * own machine, on the same LAN as the printer. It is deliberately NOT
 * correct for a cloud-hosted API, which cannot open a socket into a
 * customer's LAN; `docs/auto-printing-plan.md` §5 specifies the on-site
 * print agent for that topology, and it consumes the SAME queue rows this
 * dispatcher drains. Nothing here has to change when the agent lands: the
 * agent becomes a second consumer, not a rewrite.
 */

export interface PrinterTarget {
  id: string;
  name: string;
  kind: KitchenPrinterKind;
  /** `host:port` for network printers; a device/spool path otherwise. */
  address: string;
  columns: number;
}

export interface PrintOutcome {
  ok: boolean;
  error?: string;
}

/** Where MOCK printers write. Overridable so tests get their own directory. */
export const MOCK_SPOOL_DIR =
  process.env.PRINT_MOCK_SPOOL_DIR ?? resolve(process.cwd(), '.print-spool');

/**
 * Send one document. NEVER throws — every failure comes back as
 * `{ ok: false, error }` so the dispatcher can record it against the job
 * and retry, rather than a socket error escaping into an unrelated stack.
 */
export async function sendToPrinter(
  target: PrinterTarget,
  payload: Buffer,
  timeoutMs = 5_000,
): Promise<PrintOutcome> {
  switch (target.kind) {
    case KitchenPrinterKind.ESC_POS_NETWORK:
      return sendOverTcp(target.address, payload, timeoutMs);
    case KitchenPrinterKind.MOCK:
      return writeSpoolFile(target, payload);
    case KitchenPrinterKind.ESC_POS_USB:
      // A USB printer is reachable as a device node / share on the machine
      // running this API: writing raw bytes to the path IS the driver.
      return writeDevice(target.address, payload);
    case KitchenPrinterKind.A4_NETWORK:
      return {
        ok: false,
        error:
          'A4_NETWORK printers need the PDF/IPP path, which auto-printing does not implement yet (see docs/auto-printing-plan.md §16). Use ESC_POS_NETWORK for thermal printers.',
      };
    default:
      return { ok: false, error: `Unsupported printer kind ${String(target.kind)}` };
  }
}

/**
 * Raw TCP to a network thermal printer (the near-universal port 9100
 * "JetDirect" protocol: open, write, close — the printer prints what it
 * receives).
 *
 * A completed write is treated as success: 9100 has no application-level
 * acknowledgement, so "the bytes left the machine" is the strongest claim
 * available. Paper-out detection needs DLE EOT status polling, which is
 * deferred; the operator-visible consequence is that a printer with no
 * paper reports a successful print, which the KDS reprint button exists to
 * remedy.
 */
function sendOverTcp(address: string, payload: Buffer, timeoutMs: number): Promise<PrintOutcome> {
  const { host, port } = parseAddress(address);
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (outcome: PrintOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(outcome);
    };

    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      done({ ok: false, error: `Timed out after ${timeoutMs}ms connecting/writing to ${host}:${port}` }),
    );
    socket.on('error', (err: Error) => done({ ok: false, error: `${host}:${port} — ${err.message}` }));
    socket.on('connect', () => {
      socket.write(payload, (err) => {
        if (err) {
          done({ ok: false, error: `${host}:${port} — write failed: ${err.message}` });
          return;
        }
        // `end()` flushes then FINs; the printer starts printing on receipt.
        socket.end(() => done({ ok: true }));
      });
    });
  });
}

/**
 * Write raw bytes to a device path — the USB/serial passthrough.
 *
 * Two shapes, because the operating systems disagree about what a printer is:
 *
 * - **Unix**: a character device, `/dev/usb/lp0`. Opened for APPEND, because
 *   truncating a device node is meaningless and some drivers reject O_TRUNC.
 * - **Windows**: there is no writable device node for a USB printer. The
 *   supported route is a SHARED printer — share it (`\\localhost\KITCHEN`)
 *   and write to the UNC path, which the spooler turns into one raw job. That
 *   open must NOT be O_APPEND: each open starts a new job, and appending to a
 *   job that does not exist yet fails. Install the printer with the "Generic /
 *   Text Only" driver so the spooler passes ESC/POS through unaltered rather
 *   than re-rendering it as a bitmap.
 */
function writeDevice(path: string, payload: Buffer): Promise<PrintOutcome> {
  const isWindowsShare = path.startsWith('\\\\');
  return new Promise((resolvePromise) => {
    try {
      const stream = createWriteStream(path, { flags: isWindowsShare ? 'w' : 'a' });
      stream.on('error', (err: Error) =>
        resolvePromise({ ok: false, error: `${path} — ${err.message}` }),
      );
      stream.write(payload, (err) => {
        if (err) {
          resolvePromise({ ok: false, error: `${path} — ${err.message}` });
          return;
        }
        stream.end(() => resolvePromise({ ok: true }));
      });
    } catch (err) {
      resolvePromise({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * MOCK printers spool to a file. This is what dev machines, CI and the
 * integration suite print to — a real byte stream on disk that can be
 * asserted and eyeballed, so "did it print?" is answerable without hardware.
 */
function writeSpoolFile(target: PrinterTarget, payload: Buffer): Promise<PrintOutcome> {
  return new Promise((resolvePromise) => {
    try {
      mkdirSync(MOCK_SPOOL_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = resolve(MOCK_SPOOL_DIR, `${stamp}_${target.id}.bin`);
      const stream = createWriteStream(file);
      stream.on('error', (err: Error) => resolvePromise({ ok: false, error: err.message }));
      stream.end(payload, () => resolvePromise({ ok: true }));
    } catch (err) {
      resolvePromise({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** `192.168.1.50:9100` → `{host, port}`; a bare host defaults to 9100. */
export function parseAddress(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0) return { host: trimmed, port: 9100 };
  const port = Number(trimmed.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { host: trimmed, port: 9100 };
  }
  return { host: trimmed.slice(0, idx), port };
}
