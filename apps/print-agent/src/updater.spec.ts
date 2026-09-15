import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyUpdate,
  isShippedPath,
  markHealthy,
  MAX_BOOT_ATTEMPTS,
  reconcileAtBoot,
  sha256,
  type ReleaseManifest,
} from './updater';

/**
 * D183 — the self-updater, on a real temp folder laid out like an install.
 *
 * Every "it swapped" is paired with an "it did NOT touch dist" for the
 * refusals (bad checksum, wrong version, a path outside dist/scripts): the
 * failure that matters is a half-applied update, and only a real folder can
 * show one. The exit is injected and recorded, never taken.
 */

const OLD_INDEX = 'console.log("old");';
const NEW_INDEX = 'console.log("new");';
const NEW_HELPER = '# new helper';

function install(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-update-'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'dist', 'index.js'), OLD_INDEX);
  writeFileSync(join(root, 'scripts', 'windows-raw-printer.ps1'), '# old helper');
  writeFileSync(join(root, 'package.json'), '{"version":"0.2.0"}');
  return root;
}

function release(files: Record<string, string>, version = '0.3.0'): { manifest: ReleaseManifest; bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>();
  const manifest: ReleaseManifest = { version, files: [] };
  for (const [path, text] of Object.entries(files)) {
    const buf = Buffer.from(text);
    bytes.set(path, buf);
    manifest.files.push({ path, size: buf.length, sha256: sha256(buf) });
  }
  return { manifest, bytes };
}

function run(root: string, rel: ReturnType<typeof release>, latest = rel.manifest.version) {
  const lines: string[] = [];
  const exits: number[] = [];
  const result = applyUpdate(latest, {
    root,
    currentVersion: '0.2.0',
    log: (l) => lines.push(l),
    exit: ((code: number) => {
      exits.push(code);
    }) as unknown as (code: number) => never,
    fetchManifest: async () => rel.manifest,
    fetchFile: async (path) => {
      const b = rel.bytes.get(path);
      if (!b) throw new Error(`no such file ${path}`);
      return b;
    },
  });
  return { result, lines, exits };
}

describe('isShippedPath', () => {
  it('accepts only dist/*.js and scripts/*.ps1', () => {
    assert.equal(isShippedPath('dist/index.js'), true);
    assert.equal(isShippedPath('scripts/windows-raw-printer.ps1'), true);
    assert.equal(isShippedPath('package.json'), true);
    for (const bad of ['package.json.next', 'dist/package.json', 'dist/../agent.json', '../dist/index.js', 'tools/node.exe', 'dist/index.ps1', 'scripts/x.js', 'C:/x.js', 'dist/', 'agent.json', 'dist/a/b.js']) {
      assert.equal(isShippedPath(bad), false, bad);
    }
  });
});

describe('applyUpdate', () => {
  let root: string;
  beforeEach(() => {
    root = install();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a good release is written to *.next, verified, swapped in, and the process asked to restart', async () => {
    const rel = release({ 'dist/index.js': NEW_INDEX, 'scripts/windows-raw-printer.ps1': NEW_HELPER, 'package.json': '{"version":"0.3.0"}' });
    const { result, exits, lines } = run(root, rel);
    assert.equal(await result, 'restarting');
    // The version the next boot reports is the new one — without this the
    // agent would update itself forever.
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{"version":"0.3.0"}');
    assert.equal(readFileSync(join(root, 'package.json.prev'), 'utf8'), '{"version":"0.2.0"}');
    assert.deepEqual(exits, [0]);
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), NEW_INDEX);
    assert.equal(readFileSync(join(root, 'dist.prev', 'index.js'), 'utf8'), OLD_INDEX);
    assert.equal(readFileSync(join(root, 'scripts', 'windows-raw-printer.ps1'), 'utf8'), NEW_HELPER);
    assert.equal(existsSync(join(root, 'dist.next')), false);
    const state = JSON.parse(readFileSync(join(root, 'update.json'), 'utf8'));
    assert.equal(state.from, '0.2.0');
    assert.equal(state.to, '0.3.0');
    assert.equal(state.attempts, 0);
    assert.ok(lines.some((l) => l.includes('updated 0.2.0 → 0.3.0')));
  });

  it('a checksum mismatch leaves dist untouched and nothing behind', async () => {
    const rel = release({ 'dist/index.js': NEW_INDEX });
    rel.manifest.files[0]!.sha256 = 'deadbeef';
    const { result, exits, lines } = run(root, rel);
    assert.equal(await result, 'failed');
    assert.deepEqual(exits, []);
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), OLD_INDEX);
    assert.equal(existsSync(join(root, 'dist.next')), false);
    assert.equal(existsSync(join(root, 'dist.prev')), false);
    assert.equal(existsSync(join(root, 'update.json')), false);
    assert.ok(lines.some((l) => l.includes('did not match its checksum')));
  });

  it('a manifest naming a path outside dist/scripts is refused before anything is fetched', async () => {
    const rel = release({ 'dist/index.js': NEW_INDEX, 'tools/node.exe': 'x' });
    let fetched = 0;
    const result = await applyUpdate('0.3.0', {
      root,
      currentVersion: '0.2.0',
      log: () => {},
      exit: (() => {}) as unknown as (code: number) => never,
      fetchManifest: async () => rel.manifest,
      fetchFile: async (p) => {
        fetched += 1;
        return rel.bytes.get(p)!;
      },
    });
    assert.equal(result, 'failed');
    assert.equal(fetched, 0);
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), OLD_INDEX);
  });

  it('a manifest whose version disagrees with the heartbeat is not applied', async () => {
    const rel = release({ 'dist/index.js': NEW_INDEX }, '0.3.1');
    const { result } = run(root, rel, '0.3.0');
    assert.equal(await result, 'failed');
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), OLD_INDEX);
  });

  it('the current version is a no-op, and a version that already failed here is skipped', async () => {
    const rel = release({ 'dist/index.js': NEW_INDEX });
    assert.equal(await run(root, rel, '0.2.0').result, 'current');
    writeFileSync(join(root, 'update-failed.json'), JSON.stringify({ version: '0.3.0' }));
    assert.equal(await run(root, rel).result, 'skipped');
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), OLD_INDEX);
  });
});

describe('reconcileAtBoot / markHealthy', () => {
  let root: string;
  beforeEach(() => {
    root = install();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('counts boots of a pending update and clears it once a heartbeat proves it', () => {
    writeFileSync(join(root, 'update.json'), JSON.stringify({ from: '0.2.0', to: '0.3.0', at: 'x', attempts: 0 }));
    reconcileAtBoot(root, () => {});
    assert.equal(JSON.parse(readFileSync(join(root, 'update.json'), 'utf8')).attempts, 1);
    markHealthy(root);
    assert.equal(existsSync(join(root, 'update.json')), false);
  });

  it(`rolls back to *.prev on the ${MAX_BOOT_ATTEMPTS}rd boot without a heartbeat and remembers the failed version`, () => {
    mkdirSync(join(root, 'dist.prev'));
    writeFileSync(join(root, 'dist.prev', 'index.js'), OLD_INDEX);
    writeFileSync(join(root, 'dist', 'index.js'), NEW_INDEX);
    writeFileSync(join(root, 'package.json.prev'), '{"version":"0.2.0"}');
    writeFileSync(join(root, 'package.json'), '{"version":"0.3.0"}');
    writeFileSync(join(root, 'update.json'), JSON.stringify({ from: '0.2.0', to: '0.3.0', at: 'x', attempts: MAX_BOOT_ATTEMPTS - 1 }));
    const lines: string[] = [];
    const realExit = process.exit;
    let exited: number | null = null;
    (process as unknown as { exit: (c: number) => void }).exit = (c: number) => {
      exited = c;
    };
    try {
      reconcileAtBoot(root, (l) => lines.push(l));
    } finally {
      process.exit = realExit;
    }
    assert.equal(exited, 0);
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), OLD_INDEX);
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{"version":"0.2.0"}');
    assert.equal(existsSync(join(root, 'dist.prev')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'update-failed.json'), 'utf8')).version, '0.3.0');
    assert.equal(existsSync(join(root, 'update.json')), false);
    assert.ok(lines.some((l) => l.includes('rolled back to 0.2.0')));
  });

  it('does nothing when no update is pending', () => {
    reconcileAtBoot(root, () => assert.fail('nothing should be logged'));
    assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), OLD_INDEX);
  });
});
