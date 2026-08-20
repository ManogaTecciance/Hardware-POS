import { createWriteStream } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

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
  if (target.kind === 'ESC_POS_USB') return writeDevice(target.address, payload);
  if (target.kind === 'MOCK') return writeDevice(target.address || './agent-spool.bin', payload);
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
  return found;
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
