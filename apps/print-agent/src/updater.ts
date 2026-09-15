import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * D183 — self-update: the agent replaces its own code with what the API
 * ships, verifies it, restarts, and rolls back if the new code cannot even
 * check in.
 *
 * Why here and not an installer: an installed agent otherwise changes only
 * when someone re-runs install.cmd on that shop's PC, so every fix meant a
 * visit per customer. The agent already trusts one place and talks to it
 * every three seconds; this lets that place say "current is 0.3.0" and be
 * believed — with every byte checked against a sha256 before it is used.
 *
 * What moves: `dist/*.js`, `scripts/*.ps1` and `package.json` (the version
 * comes from it), into `*.next` first, then a rename swap that keeps the
 * previous build as `*.prev`. Node holds no file
 * handles on loaded modules and the working directory is the install
 * folder, so renaming `dist` under a running process is safe on Windows.
 * node.exe, nssm and agent.json are never touched.
 *
 * Restart is `process.exit(0)`: the service wrapper restarts the program
 * (install.ps1 sets AppExit Restart). A manual `node dist\\index.js` in a
 * terminal is not restarted by anyone, so updating there is off by default
 * — it would just stop.
 */

export interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseManifest {
  version: string;
  files: ReleaseFile[];
}

/** Written across the swap; its presence at boot means "prove this build". */
interface UpdateState {
  from: string;
  to: string;
  at: string;
  /** Boots of the new build that did not reach a heartbeat. */
  attempts: number;
}

export interface UpdaterOptions {
  /** The install folder — the parent of `dist` and `scripts`. */
  root: string;
  currentVersion: string;
  fetchManifest: () => Promise<ReleaseManifest>;
  fetchFile: (path: string) => Promise<Buffer>;
  log: (line: string) => void;
  /** Injectable for tests; production exits so the service wrapper restarts. */
  exit?: (code: number) => never;
}

const FOLDERS = ['dist', 'scripts'] as const;
const STATE_FILE = 'update.json';
const FAILED_FILE = 'update-failed.json';
/** Boots of a fresh build that may die before a heartbeat before we give up on it. */
export const MAX_BOOT_ATTEMPTS = 3;
/** How often a behind agent re-checks after a failed or skipped attempt. */
export const RETRY_EVERY_MS = 10 * 60_000;

/** A shipped path is `dist/x.js`, `scripts/x.ps1` or `package.json` — nothing else, ever. */
export function isShippedPath(path: string): boolean {
  if (path === 'package.json') return true;
  const m = /^(dist|scripts)\/([A-Za-z0-9_.-]+)$/.exec(path);
  if (!m) return false;
  const dir = m[1];
  const name = m[2] ?? '';
  if (name === '' || name === '.' || name === '..' || name.includes('..')) return false;
  return (dir === 'dist' && name.endsWith('.js')) || (dir === 'scripts' && name.endsWith('.ps1'));
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stateOf(root: string): UpdateState | null {
  try {
    return JSON.parse(readFileSync(join(root, STATE_FILE), 'utf8').replace(/^\uFEFF/, '')) as UpdateState;
  } catch {
    return null;
  }
}

/**
 * Called first thing at boot. Counts this boot against a pending update and,
 * when the new build has died too often without checking in, puts the
 * previous build back. Returns the version that should now be running so the
 * caller can log it; never throws — a broken updater must not stop printing.
 */
export function reconcileAtBoot(root: string, log: (line: string) => void): void {
  const state = stateOf(root);
  if (!state) return;
  state.attempts += 1;
  if (state.attempts < MAX_BOOT_ATTEMPTS) {
    writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2));
    return;
  }
  // Three boots and never a heartbeat: the new code is broken here. Put the
  // old one back and remember not to try this version again.
  let restored = false;
  for (const folder of FOLDERS) {
    const prev = join(root, `${folder}.prev`);
    if (!existsSync(prev)) continue;
    const live = join(root, folder);
    const broken = join(root, `${folder}.broken`);
    rmSync(broken, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, broken);
    renameSync(prev, live);
    restored = true;
  }
  if (existsSync(join(root, 'package.json.prev'))) {
    rmSync(join(root, 'package.json.broken'), { force: true });
    if (existsSync(join(root, 'package.json'))) renameSync(join(root, 'package.json'), join(root, 'package.json.broken'));
    renameSync(join(root, 'package.json.prev'), join(root, 'package.json'));
  }
  rmSync(join(root, STATE_FILE), { force: true });
  writeFileSync(
    join(root, FAILED_FILE),
    JSON.stringify({ version: state.to, at: new Date().toISOString(), attempts: state.attempts }, null, 2),
  );
  log(
    restored
      ? `rolled back to ${state.from}: ${state.to} did not check in after ${state.attempts} starts — restarting`
      : `${state.to} did not check in after ${state.attempts} starts and there is nothing to roll back to`,
  );
  if (restored) process.exit(0);
}

/** After the first successful heartbeat: the running build is proven. */
export function markHealthy(root: string): void {
  rmSync(join(root, STATE_FILE), { force: true });
  for (const folder of FOLDERS) rmSync(join(root, `${folder}.broken`), { recursive: true, force: true });
  rmSync(join(root, 'package.json.broken'), { force: true });
}

function failedVersion(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, FAILED_FILE), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch, verify, swap, restart. Returns without doing anything when the
 * build is current, was already tried and failed here, or does not verify;
 * every early return is logged once so the log explains why an agent is
 * still behind.
 */
export async function applyUpdate(latestVersion: string, opts: UpdaterOptions): Promise<'current' | 'skipped' | 'failed' | 'restarting'> {
  const { root, currentVersion, log } = opts;
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  if (latestVersion === currentVersion) return 'current';
  if (failedVersion(root) === latestVersion) {
    return 'skipped';
  }

  let manifest: ReleaseManifest;
  try {
    manifest = await opts.fetchManifest();
  } catch (err) {
    log(`update: could not read the release manifest — ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
  if (manifest.version !== latestVersion) {
    log(`update: manifest says ${manifest.version}, heartbeat said ${latestVersion}; waiting for them to agree`);
    return 'failed';
  }
  if (!manifest.files.some((f) => f.path === 'dist/index.js')) {
    log('update: release has no dist/index.js — refusing it');
    return 'failed';
  }
  for (const file of manifest.files) {
    if (!isShippedPath(file.path)) {
      log(`update: release lists a path the agent will not write (${file.path}) — refusing it`);
      return 'failed';
    }
  }

  // Everything lands in *.next first; nothing live is touched until every
  // byte has been checked.
  for (const folder of FOLDERS) rmSync(join(root, `${folder}.next`), { recursive: true, force: true });
  rmSync(join(root, 'package.json.next'), { force: true });
  try {
    for (const file of manifest.files) {
      const bytes = await opts.fetchFile(file.path);
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
        throw new Error(`${file.path} did not match its checksum`);
      }
      const target =
        file.path === 'package.json'
          ? join(root, 'package.json.next')
          : join(root, file.path.replace(/^(dist|scripts)\//, '$1.next/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  } catch (err) {
    for (const folder of FOLDERS) rmSync(join(root, `${folder}.next`), { recursive: true, force: true });
    rmSync(join(root, 'package.json.next'), { force: true });
    log(`update to ${latestVersion} abandoned: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }

  // Swap. The order matters only for the crash-in-the-middle case: a folder
  // is never absent, at worst *.prev exists twice, and reconcileAtBoot only
  // moves what it finds.
  for (const folder of FOLDERS) {
    const next = join(root, `${folder}.next`);
    if (!existsSync(next)) continue; // a release without scripts changes is fine
    const live = join(root, folder);
    const prev = join(root, `${folder}.prev`);
    rmSync(prev, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, prev);
    renameSync(next, live);
  }
  if (existsSync(join(root, 'package.json.next'))) {
    rmSync(join(root, 'package.json.prev'), { force: true });
    if (existsSync(join(root, 'package.json'))) renameSync(join(root, 'package.json'), join(root, 'package.json.prev'));
    renameSync(join(root, 'package.json.next'), join(root, 'package.json'));
  }
  const state: UpdateState = { from: currentVersion, to: latestVersion, at: new Date().toISOString(), attempts: 0 };
  writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2));
  log(`updated ${currentVersion} → ${latestVersion}, restarting`);
  exit(0);
  return 'restarting';
}

/** The install folder for a running agent: the parent of its `dist`. */
export function installRootOf(entryFile: string): string {
  return resolve(dirname(entryFile), '..');
}
