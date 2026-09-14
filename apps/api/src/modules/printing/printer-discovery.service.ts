import { Injectable, Logger } from '@nestjs/common';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';

/**
 * D67 — find printers on the shop's network (PO request, 2026-08-18).
 *
 * ## Why the SERVER scans, not the tablet
 *
 * The waiter's tablet is on the shop LAN but wired to nothing, and a browser
 * cannot open a raw TCP socket to 9100 at all — so neither discovering nor
 * printing can happen in the tablet. This API process holds the sockets, so
 * it is also the thing that can see the network: it enumerates its own
 * private IPv4 interfaces and probes each host on the printer port.
 *
 * That makes one deployment fact load-bearing, and it is stated here so
 * nobody is surprised later: **the API must run on the shop's LAN** for
 * discovery (and printing) to work. A cloud-hosted API can reach neither,
 * which is exactly the constraint `docs/auto-printing-plan.md` §5 answers
 * with an on-site agent.
 *
 * ## Why a port probe and not mDNS/SNMP
 *
 * Thermal receipt printers answer raw TCP on 9100 ("JetDirect") virtually
 * universally; many do not advertise over mDNS and few speak SNMP without
 * configuration. A connect-probe finds every device that can actually be
 * printed to — which is the only question the settings screen is asking.
 * Consequence, stated plainly: the probe reports "something accepts
 * connections on 9100 here", not "this is a printer"; the operator confirms
 * with the Test print button, which is why that button sits next to every
 * discovered address.
 */

export interface DiscoveredPrinter {
  host: string;
  port: number;
  /** Round-trip of the TCP handshake — useful for spotting a slow link. */
  latencyMs: number;
}

export interface DiscoveryResult {
  /** The subnets actually scanned, e.g. ["192.168.8.0/24"]. */
  subnets: string[];
  hostsScanned: number;
  port: number;
  printers: DiscoveredPrinter[];
  /** Set when the server has no private IPv4 interface to scan. */
  note?: string;
}

/** Ports worth probing. 9100 is the near-universal raw ESC/POS port. */
export const DEFAULT_PRINTER_PORT = 9100;
/** Hosts probed at once. High enough for a /24 in ~2 s, low enough to be polite. */
const CONCURRENCY = 64;
/** A LAN printer answers in milliseconds; anything slower is not on this switch. */
const PROBE_TIMEOUT_MS = 400;

@Injectable()
export class PrinterDiscoveryService {
  private readonly logger = new Logger(PrinterDiscoveryService.name);
  /** One scan at a time per process: a second concurrent /24 sweep is noise. */
  private scanning = false;

  /**
   * Scan every private IPv4 /24 this machine sits on for open printer ports.
   *
   * Deliberately limited to RFC1918 addresses and to /24-sized sweeps: a
   * server on a /16 must not fire 65k connect attempts because someone
   * opened a settings page, and scanning a public range from a customer's
   * network is never something this product should do.
   */
  async scan(port = DEFAULT_PRINTER_PORT): Promise<DiscoveryResult> {
    if (this.scanning) {
      return { subnets: [], hostsScanned: 0, port, printers: [], note: 'A scan is already running' };
    }
    this.scanning = true;
    try {
      const subnets = this.localSubnets();
      if (subnets.length === 0) {
        return {
          subnets: [],
          hostsScanned: 0,
          port,
          printers: [],
          note:
            'This server has no private IPv4 network interface, so it cannot see LAN printers. ' +
            'Run the API on the shop network, or add the printer by IP address manually.',
        };
      }

      const hosts = subnets.flatMap((s) => hostsOf(s));
      const found: DiscoveredPrinter[] = [];
      for (let i = 0; i < hosts.length; i += CONCURRENCY) {
        const batch = hosts.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((host) => this.probe(host, port)));
        for (const result of results) if (result) found.push(result);
      }
      this.logger.log(
        `Printer scan: ${found.length} device(s) answering on :${port} across ${subnets.join(', ')}`,
      );
      return { subnets, hostsScanned: hosts.length, port, printers: found };
    } finally {
      this.scanning = false;
    }
  }

  /** Probe one address — the "check this IP" button next to manual entry. */
  async probe(host: string, port = DEFAULT_PRINTER_PORT): Promise<DiscoveredPrinter | null> {
    const startedAt = Date.now();
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value: DiscoveredPrinter | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolvePromise(value);
      };
      const socket = connect({ host, port });
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.on('timeout', () => finish(null));
      socket.on('error', () => finish(null));
      socket.on('connect', () => finish({ host, port, latencyMs: Date.now() - startedAt }));
    });
  }

  /** The private IPv4 /24s this machine is on, de-duplicated. */
  private localSubnets(): string[] {
    const subnets = new Set<string>();
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== 'IPv4' || address.internal) continue;
        if (!isPrivateV4(address.address)) continue;
        const parts = address.address.split('.');
        subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
      }
    }
    return [...subnets];
  }
}

/** 10/8, 172.16/12, 192.168/16 — the ranges a shop LAN actually uses. */
export function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** .1 … .254 of a /24 — network and broadcast addresses are never printers. */
export function hostsOf(subnet: string): string[] {
  const base = subnet.split('/')[0] ?? '';
  const parts = base.split('.');
  if (parts.length !== 4) return [];
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i += 1) hosts.push(`${prefix}.${i}`);
  return hosts;
}
