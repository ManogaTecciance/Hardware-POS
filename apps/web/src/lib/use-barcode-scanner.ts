'use client';

import * as React from 'react';

/**
 * Page-level barcode scanner capture.
 *
 * USB/Bluetooth scanners in HID mode act as keyboards: they "type" the code far
 * faster than a human and usually finish with a terminator. Rather than relying
 * on a focused input, this hook listens at the document level and reconstructs
 * the code from the keystroke burst, so a scan registers wherever the cashier
 * happens to be on the page.
 *
 * Deliberately terminator-agnostic — scanners differ by model and config:
 *  - Enter / Tab suffix (the common cases) commit immediately.
 *  - No suffix, or an exotic one (ESC, STX/ETX framing), still commits via the
 *    idle timeout once the burst stops.
 *
 * Typing is never hijacked: keystrokes inside an input / textarea / select /
 * contenteditable are ignored, so the search box, quantity fields, and dialog
 * forms behave normally. Bursts shorter than `minLength`, or typed at human
 * speed, are discarded.
 */
export interface BarcodeScannerOptions {
  /** Called with the decoded code once a burst completes. */
  onScan: (code: string) => void;
  /** Set false to suspend capture (e.g. while a modal is open). Default true. */
  enabled?: boolean;
  /**
   * Maximum gap between keystrokes for them to count as one scan (ms).
   * Scanners emit at 5–30ms; humans rarely sustain under ~100ms.
   */
  maxKeyGapMs?: number;
  /** Commit an unterminated burst this long after the last keystroke (ms). */
  idleCommitMs?: number;
  /** Shortest accepted code — guards against stray keypresses. */
  minLength?: number;
  /** Longest accepted payload — QR codes can be long, but not unbounded. */
  maxLength?: number;
}

/**
 * Candidate identifiers hidden inside a scanned payload.
 *
 * A 1D barcode *is* the code. QR codes usually wrap it — a product URL, a JSON
 * blob, or several lines — so unwrap the common shapes and let the caller try
 * each against the catalogue, most specific first.
 */
export function scanCandidates(raw: string): string[] {
  const found: string[] = [];
  const push = (value?: string | null) => {
    const trimmed = (value ?? '').trim();
    if (trimmed && !found.includes(trimmed)) found.push(trimmed);
  };

  const text = raw.trim();
  push(text);
  // Multi-line QR: the identifier is normally the first line.
  push(text.split(/[\r\n]/)[0]);

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      for (const key of ['sku', 'code', 'barcode', 'item', 'id', 'p']) {
        push(url.searchParams.get(key));
      }
      const segments = url.pathname.split('/').filter(Boolean);
      push(segments[segments.length - 1]);
    } catch {
      /* not a parseable URL — the raw text candidate still applies */
    }
  }

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        for (const key of ['sku', 'code', 'barcode', 'id']) {
          const value = record[key];
          if (typeof value === 'string' || typeof value === 'number') push(String(value));
        }
      }
    } catch {
      /* not JSON */
    }
  }

  return found;
}

/**
 * Printable ASCII **including space** — 1D barcodes are space-free, but QR
 * payloads routinely carry URLs and text that contain spaces.
 */
const SCAN_CHAR = /^[\x20-\x7E]$/;

/** Keys a scanner may emit mid-code that must not break the burst. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

export function useBarcodeScanner({
  onScan,
  enabled = true,
  maxKeyGapMs = 100,
  idleCommitMs = 140,
  minLength = 3,
  maxLength = 512,
}: BarcodeScannerOptions): void {
  // Keep the latest callback without re-binding the listener on every render.
  const onScanRef = React.useRef(onScan);
  React.useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  React.useEffect(() => {
    if (!enabled) return;

    let buffer = '';
    let lastKeyAt = 0;
    let idleTimer: number | undefined;

    const clearIdle = () => {
      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const reset = () => {
      buffer = '';
      clearIdle();
    };

    const commit = () => {
      const code = buffer;
      reset();
      if (code.length >= minLength) onScanRef.current(code);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Never interfere with real typing or with modifier shortcuts.
      if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) {
        reset();
        return;
      }

      const now = Date.now();
      const gap = now - lastKeyAt;
      lastKeyAt = now;

      // Enter / Tab terminate a scan. Only swallow the event when we actually
      // have a plausible code, so keyboard navigation keeps working.
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (buffer.length >= minLength && gap <= maxKeyGapMs) {
          event.preventDefault();
          commit();
        } else {
          reset();
        }
        return;
      }

      if (event.key.length === 1 && SCAN_CHAR.test(event.key)) {
        // A slow keystroke starts a fresh burst rather than extending one.
        const startsBurst = gap > maxKeyGapMs;

        if (event.key === ' ') {
          // Space only counts inside an in-flight scan (QR payloads contain
          // them). A lone space must still activate a focused button.
          if (startsBurst || buffer.length === 0) {
            reset();
            return;
          }
          event.preventDefault();
        }

        buffer = startsBurst ? event.key : buffer + event.key;
        // Runaway guard — a real payload never approaches this.
        if (buffer.length > maxLength) {
          reset();
          return;
        }
        clearIdle();
        // Fallback for scanners that send no (or an unrecognised) terminator.
        idleTimer = window.setTimeout(commit, idleCommitMs);
        return;
      }

      // Modifier-only keys are part of a scan (Shift for uppercase) — neither
      // buffer nor break.
      if (MODIFIER_KEYS.has(event.key)) return;

      // Any other key (Escape, arrows, function keys…) ends the burst. If what
      // we have already looks like a code, treat the key as the terminator —
      // that is what an ESC-suffix scanner effectively sends.
      if (buffer.length >= minLength && gap <= maxKeyGapMs) commit();
      else reset();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearIdle();
    };
  }, [enabled, maxKeyGapMs, idleCommitMs, minLength, maxLength]);
}
