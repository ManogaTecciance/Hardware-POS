/**
 * D172 — `inlineImage`, the piece both the A4 letterhead and the thermal bill
 * depend on.
 *
 * ## What makes these non-vacuous (D30)
 *
 * Every case asserts the RETURNED VALUE's shape, not that the storage provider
 * was called. An implementation that resolved the path and then dropped the
 * bytes would satisfy "resolve was called" and produce exactly the broken image
 * this function exists to prevent.
 *
 * Both provider shapes are covered, positively. `local` hands back a file path
 * and `s3` a signed URL, and this installation runs `s3` — so a function tested
 * only against `file` would be tested against the branch nobody uses.
 *
 * The failure cases are asserted to return `null` rather than to throw, and
 * that is the point of them: a branding asset is decoration, and a quotation
 * that 500s because a logo moved is a worse outcome than one that prints
 * without it.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearInlineImageCache, inlineImage } from './inline-image';
import type { StorageService } from './storage.service';

/** A 1x1 transparent GIF. Small, real, and decodable. */
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

type Resolver = StorageService['resolve'];

function storageReturning(resolved: Awaited<ReturnType<Resolver>>): Pick<StorageService, 'resolve'> {
  return { resolve: jest.fn(async () => resolved) as unknown as Resolver };
}

let dir: string;

beforeEach(() => {
  clearInlineImageCache();
  dir = mkdtempSync(join(tmpdir(), 'inline-image-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('inlineImage', () => {
  it('returns null for nothing', async () => {
    const storage = storageReturning(null);
    expect(await inlineImage(storage, null)).toBeNull();
    expect(await inlineImage(storage, undefined)).toBeNull();
    expect(await inlineImage(storage, '')).toBeNull();
    // Nothing was asked of storage: an absent path is not a lookup.
    expect(storage.resolve).not.toHaveBeenCalled();
  });

  it('inlines a file from the local provider', async () => {
    const path = join(dir, 'logo.png');
    writeFileSync(path, PIXEL);

    const result = await inlineImage(storageReturning({ kind: 'file', path }), '/uploads/logo.png');

    // The mime follows the STORED path's extension, not the bytes: that is what
    // the browser is told, and every stored asset is re-encoded on upload.
    expect(result).toBe(`data:image/png;base64,${PIXEL.toString('base64')}`);
  });

  it('inlines a signed URL from the s3 provider — the branch this install uses', async () => {
    globalThis.fetch = jest.fn(async () => new Response(PIXEL)) as unknown as typeof fetch;

    const result = await inlineImage(
      storageReturning({ kind: 'redirect', url: 'https://s3.test/x', maxAgeSeconds: 60 }),
      '/uploads/logo.webp',
    );

    expect(result).toBe(`data:image/webp;base64,${PIXEL.toString('base64')}`);
  });

  it('passes an absolute URL through untouched', async () => {
    const storage = storageReturning(null);
    const url = 'https://cdn.example.test/logo.png';

    expect(await inlineImage(storage, url)).toBe(url);
    // Already resolvable from anywhere, which is the property being created.
    expect(storage.resolve).not.toHaveBeenCalled();
  });

  it('passes a data URI through untouched', async () => {
    const storage = storageReturning(null);
    const uri = 'data:image/png;base64,AAAA';

    expect(await inlineImage(storage, uri)).toBe(uri);
    expect(storage.resolve).not.toHaveBeenCalled();
  });

  it('returns null when the path is not ours', async () => {
    expect(await inlineImage(storageReturning(null), '/elsewhere/logo.png')).toBeNull();
  });

  it('returns null rather than throwing when the file is gone', async () => {
    const result = await inlineImage(
      storageReturning({ kind: 'file', path: join(dir, 'missing.png') }),
      '/uploads/missing.png',
    );
    expect(result).toBeNull();
  });

  it('returns null rather than throwing when storage is unreachable', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await inlineImage(
      storageReturning({ kind: 'redirect', url: 'https://s3.test/x', maxAgeSeconds: 60 }),
      '/uploads/logo.webp',
    );
    expect(result).toBeNull();
  });

  it('refuses to inline something too large to put on every receipt', async () => {
    const huge = join(dir, 'huge.png');
    writeFileSync(huge, Buffer.alloc(600 * 1024, 1));

    expect(await inlineImage(storageReturning({ kind: 'file', path: huge }), '/uploads/huge.png'))
      .toBeNull();
  });

  it('returns null for an empty file', async () => {
    const empty = join(dir, 'empty.png');
    writeFileSync(empty, Buffer.alloc(0));

    expect(await inlineImage(storageReturning({ kind: 'file', path: empty }), '/uploads/empty.png'))
      .toBeNull();
  });

  it('reads the bytes once and serves the rest from cache', async () => {
    const path = join(dir, 'logo.webp');
    writeFileSync(path, PIXEL);
    const storage = storageReturning({ kind: 'file', path });

    const first = await inlineImage(storage, '/uploads/logo.webp');
    const second = await inlineImage(storage, '/uploads/logo.webp');

    expect(second).toBe(first);
    // A till prints all day. Re-reading the logo per receipt is the difference
    // between a cached string and a round trip to S3 at the counter.
    expect(storage.resolve).toHaveBeenCalledTimes(1);
  });

  it('caches per path, so one asset cannot serve another', async () => {
    // The negative half of the cache test. Keying on anything coarser — or
    // caching a single "last image" — would hand the stamp's bytes to the logo.
    const logo = join(dir, 'logo.webp');
    const stamp = join(dir, 'stamp.webp');
    writeFileSync(logo, PIXEL);
    writeFileSync(stamp, Buffer.concat([PIXEL, Buffer.from([0])]));

    const storage = {
      resolve: jest.fn(async (p: string) => ({
        kind: 'file' as const,
        path: p.includes('stamp') ? stamp : logo,
      })) as unknown as Resolver,
    };

    const a = await inlineImage(storage, '/uploads/logo.webp');
    const b = await inlineImage(storage, '/uploads/stamp.webp');

    expect(a).not.toBe(b);
    expect(storage.resolve).toHaveBeenCalledTimes(2);
  });
});
