'use client';

/**
 * Zebra Browser Print transport.
 *
 * The POS is SaaS, but the label printer hangs off the cashier's own machine —
 * so the API can never reach it. Zebra's Browser Print agent bridges the gap:
 * it runs on the workstation and exposes a small HTTP service on loopback that
 * a web page may call cross-origin.
 *
 * Port choice matters. A page served over HTTPS cannot call `http://localhost`
 * (mixed content), so the agent also listens on HTTPS/9101 with a locally
 * trusted certificate. We therefore try the scheme matching the page first and
 * fall back to the other, which keeps `http://localhost:3000` working in dev.
 *
 * Agent availability is a normal, expected state — not an error. Callers should
 * surface "install/start Browser Print" rather than a stack trace.
 */

const HTTPS_BASE = 'https://localhost:9101';
const HTTP_BASE = 'http://localhost:9100';

/** A printer as Browser Print describes it; passed back verbatim on write. */
export interface ZebraDevice {
  name: string;
  uid: string;
  connection: string;
  deviceType: string;
  provider: string;
  manufacturer?: string;
  version?: number;
}

export class BrowserPrintUnavailableError extends Error {
  constructor() {
    super(
      'Zebra Browser Print was not detected on this computer. Install it from Zebra’s ' +
        'support site (or start the service if it is already installed), then try again.',
    );
    this.name = 'BrowserPrintUnavailableError';
  }
}

/** Loopback bases in preference order for the current page scheme. */
function candidateBases(): string[] {
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  return secure ? [HTTPS_BASE, HTTP_BASE] : [HTTP_BASE, HTTPS_BASE];
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/** Resolve the agent's base URL, or null when it isn't running. */
export async function detectBrowserPrint(): Promise<string | null> {
  for (const base of candidateBases()) {
    try {
      const res = await fetchWithTimeout(`${base}/available`);
      if (res.ok) return base;
    } catch {
      // Wrong scheme, agent down, or cert not trusted — try the next base.
    }
  }
  return null;
}

interface AvailableResponse {
  printer?: ZebraDevice[];
  device?: ZebraDevice[];
}

export async function listPrinters(base: string): Promise<ZebraDevice[]> {
  const res = await fetchWithTimeout(`${base}/available`);
  if (!res.ok) throw new BrowserPrintUnavailableError();
  const body = (await res.json()) as AvailableResponse;
  return body.printer ?? body.device ?? [];
}

export async function getDefaultPrinter(base: string): Promise<ZebraDevice | null> {
  try {
    const res = await fetchWithTimeout(`${base}/default?type=printer`);
    if (!res.ok) return null;
    const body = (await res.json()) as ZebraDevice | '';
    return body && typeof body === 'object' && body.uid ? body : null;
  } catch {
    return null;
  }
}

/** Send raw ZPL to a device. Resolves once the agent accepts the job. */
export async function sendZpl(base: string, device: ZebraDevice, zpl: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${base}/write`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, data: zpl }),
    },
    // Long batches can take a moment to hand over.
    15_000,
  );
  if (!res.ok) {
    throw new Error(`The printer agent rejected the job (HTTP ${res.status}).`);
  }
}

/** Convenience: detect agent, pick the default (or first) printer, send. */
export async function printZpl(zpl: string, preferred?: ZebraDevice | null): Promise<ZebraDevice> {
  const base = await detectBrowserPrint();
  if (!base) throw new BrowserPrintUnavailableError();

  const device = preferred ?? (await getDefaultPrinter(base)) ?? (await listPrinters(base))[0];
  if (!device) {
    throw new Error('Browser Print is running but no printer is configured on this computer.');
  }
  await sendZpl(base, device, zpl);
  return device;
}
