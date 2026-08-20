#!/usr/bin/env node
import { loadConfig, type AgentConfig } from './config';
import { probe, scanLan, sendToPrinter, type Discovered } from './printer';

/**
 * AxloPOS on-site print agent (D67).
 *
 * ## Why this program exists
 *
 * The web app runs on Amplify and the API on EC2. The printers are on the
 * SHOP's LAN behind NAT: no cloud process can open a socket to them, and a
 * browser cannot speak raw ESC/POS at all. This daemon runs on any
 * always-on machine inside the shop, dials OUT over HTTPS (so no inbound
 * ports, no port forwarding, no static IP), and does three things forever:
 *
 *   1. heartbeat  — "I am alive", which is what makes the server stop trying
 *                   to print directly and hand this branch's work to us;
 *   2. lease      — claim ready-to-print documents (already rendered to
 *                   ESC/POS bytes server-side; this program owns no
 *                   templates and never needs updating when one changes);
 *   3. ack        — report the outcome, so a failure shows up in the app
 *                   next to the order rather than dying in a log here.
 *
 * It also scans the LAN periodically and reports what answers on the
 * printer port, which is how "detected printers" reaches a settings screen
 * that is being rendered a continent away.
 *
 * ## Failure behaviour
 *
 * Everything retries and nothing is fatal except a missing configuration.
 * Network loss just means the next poll fails and the queue drains when the
 * link returns. A document leased but not acked (this process is killed
 * mid-print) is released by the server's lease TTL and printed again: at
 * least once, because a duplicate ticket is recoverable and a missing one
 * is not.
 */

const VERSION = '0.1.0';

interface LeasedJob {
  leaseId: string;
  source: 'KITCHEN' | 'CASHIER';
  jobId: string;
  printer: { id: string; name: string; kind: string; address: string; columns: number };
  copies: number;
  payloadBase64: string;
  description: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  log(`starting v${VERSION} → ${config.apiUrl} (poll ${config.pollSeconds}s)`);

  let lastDiscovery = 0;
  let discovered: Discovered[] = [];
  let backoffMs = 0;

  // One-shot self test: `axlo-print-agent --test 192.168.1.50:9100`
  const testTarget = argValue('--test');
  if (testTarget) {
    const [host, port] = splitAddress(testTarget, config.printerPort);
    const hit = await probe(host, port);
    log(hit ? `OK ${host}:${port} answered in ${hit.latencyMs}ms` : `NO ANSWER from ${host}:${port}`);
    process.exit(hit ? 0 : 1);
  }

  for (;;) {
    try {
      // Re-scan on a slow cadence: the network rarely changes, and a /24
      // sweep every few seconds would be rude to the shop's switch.
      if (Date.now() - lastDiscovery > config.discoverySeconds * 1000) {
        discovered = await scanLan(config.printerPort);
        lastDiscovery = Date.now();
        log(`discovery: ${discovered.length} device(s) answering on :${config.printerPort}`);
      }

      await post(config, '/print-agent/heartbeat', {
        version: VERSION,
        discovered: discovered.map((d) => ({ host: d.host, port: d.port, latencyMs: d.latencyMs })),
      });

      const jobs = (await post(config, '/print-agent/lease', { maxJobs: 8 })) as LeasedJob[];
      backoffMs = 0;

      if (jobs.length === 0) {
        await sleep(config.pollSeconds * 1000);
        continue;
      }

      for (const job of jobs) {
        const payload = Buffer.from(job.payloadBase64, 'base64');
        let result = await sendToPrinter(job.printer, payload);
        // Extra copies are separate documents; a mid-run failure is still
        // reported once, for the job as a whole.
        for (let copy = 1; result.ok && copy < job.copies; copy += 1) {
          result = await sendToPrinter(job.printer, payload);
        }
        log(
          result.ok
            ? `printed ${job.description} on ${job.printer.name}`
            : `FAILED ${job.description} on ${job.printer.name}: ${result.error ?? 'unknown'}`,
        );
        await post(config, '/print-agent/ack', {
          leaseId: job.leaseId,
          ok: result.ok,
          error: result.error,
        });
      }
    } catch (err) {
      // Exponential backoff to 60s: a shop's uplink drops, and hammering it
      // helps nobody. The queue is server-side, so nothing is lost meanwhile.
      backoffMs = Math.min(backoffMs === 0 ? 1_000 : backoffMs * 2, 60_000);
      log(`error: ${err instanceof Error ? err.message : String(err)} — retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

async function post(config: AgentConfig, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${config.apiUrl}/v1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${path} → HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const parsed = (await response.json().catch(() => null)) as { data?: unknown } | null;
  // The API wraps successful payloads in `{ data }`.
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
}

function splitAddress(address: string, fallbackPort: number): [string, number] {
  const idx = address.lastIndexOf(':');
  if (idx <= 0) return [address, fallbackPort];
  const port = Number(address.slice(idx + 1));
  return Number.isFinite(port) ? [address.slice(0, idx), port] : [address, fallbackPort];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] axlo-print-agent: ${message}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
