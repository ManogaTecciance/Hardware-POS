/**
 * D172 — turn a stored image into a `data:` URI so a document carries its own
 * pictures.
 *
 * ## Why a document cannot use a URL
 *
 * Branding assets are stored as `/uploads/<key>` — a path with no origin,
 * deliberately, so switching storage backends does not invalidate existing
 * rows. That path is fine in the app's own pages, where the browser is already
 * talking to the API.
 *
 * It is wrong in a DOCUMENT. The A4 HTML is built by the API and then written
 * into a popup by the web app:
 *
 *     win.document.write(html)     // origin: the WEB app, :3000
 *
 * so `<img src="/uploads/…">` asks **the web app** for the file, and the web app
 * has never heard of it. The image 404s and the letterhead prints with a broken
 * icon where the logo should be. The same HTML written into the receipt iframe
 * has the same problem for the same reason.
 *
 * Absolutising the URL against the API's origin would fix the popup and nothing
 * else. A quotation is **shared** — printed to PDF, attached to an email, sent
 * over WhatsApp — and a recipient's browser resolving `http://localhost:4000`
 * finds their own machine. A document that depends on the issuing server still
 * being reachable is not a document; it is a screen.
 *
 * So the bytes travel with it. Inlined, the file prints, saves, forwards and
 * opens on a machine that has never heard of this installation.
 *
 * ## Why this never throws
 *
 * A missing or unreadable logo must not turn a quotation into a 500. Every
 * failure path returns `null`, which the templates already render as "no image"
 * — the behaviour before any logo was uploaded. A branding asset is decoration;
 * the document is the point.
 */
import { readFile } from 'node:fs/promises';

import { Logger } from '@nestjs/common';

import type { StorageService } from './storage.service';

const logger = new Logger('InlineImage');

/**
 * Refuse to inline anything larger than this.
 *
 * `StorageService.saveImage` downscales every upload to `IMAGE_MAX_EDGE` and
 * re-encodes it as WebP, so a real logo lands far under this. The cap is for
 * rows written before that pipeline existed: base64 costs a third on top, and
 * a 5 MB image inlined into every receipt would make the printer the slowest
 * part of the sale.
 */
const MAX_INLINE_BYTES = 512 * 1024;

/** Cache TTL. A logo changes when someone uploads one, which is close to never. */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Extension → mime. Everything stored today is WebP; older rows are not. */
const MIME_BY_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function mimeFor(storedPath: string): string {
  const match = /\.[a-z0-9]+$/i.exec(storedPath.split('?')[0] ?? '');
  return (match && MIME_BY_EXT[match[0].toLowerCase()]) || 'image/webp';
}

/**
 * `null` in, `null` out; a `data:` URI passes through; anything else is read
 * through the storage provider and returned as `data:<mime>;base64,…`.
 *
 * An absolute `http(s)` URL is returned untouched. It is already resolvable
 * from anywhere, which is the property this function exists to create.
 */
export async function inlineImage(
  storage: Pick<StorageService, 'resolve'>,
  storedPath: string | null | undefined,
): Promise<string | null> {
  if (!storedPath) return null;
  if (storedPath.startsWith('data:')) return storedPath;
  if (/^https?:\/\//i.test(storedPath)) return storedPath;

  const hit = cache.get(storedPath);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await read(storage, storedPath);
  cache.set(storedPath, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function read(
  storage: Pick<StorageService, 'resolve'>,
  storedPath: string,
): Promise<string | null> {
  try {
    const resolved = await storage.resolve(storedPath);
    if (!resolved) return null;

    /*
     * Both provider shapes are handled here rather than reaching past
     * `resolve`. `local` hands back a path on this machine's disk; `s3` hands
     * back a short-lived signed URL, which this process fetches exactly as a
     * browser would. Neither branch needs to know which provider is configured,
     * which is the whole point of the abstraction.
     */
    const buffer =
      resolved.kind === 'file'
        ? await readFile(resolved.path)
        : Buffer.from(await (await fetch(resolved.url)).arrayBuffer());

    if (buffer.byteLength === 0) return null;
    if (buffer.byteLength > MAX_INLINE_BYTES) {
      logger.warn(
        `Not inlining ${storedPath}: ${buffer.byteLength} bytes exceeds the ${MAX_INLINE_BYTES}-byte cap`,
      );
      return null;
    }
    return `data:${mimeFor(storedPath)};base64,${buffer.toString('base64')}`;
  } catch (error) {
    // Decoration, not content. A document renders without it.
    logger.warn(`Could not inline ${storedPath}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** Drop cached bytes. Called when a branding asset is replaced or removed. */
export function forgetInlinedImage(storedPath: string | null | undefined): void {
  if (storedPath) cache.delete(storedPath);
}

/** Test seam: empty the cache between cases. */
export function clearInlineImageCache(): void {
  cache.clear();
}
