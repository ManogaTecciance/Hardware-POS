import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';

/**
 * D183 — the API carries the current print-agent build, so deploying the API
 * deploys every shop's agent.
 *
 * An installed agent otherwise changes only when someone re-runs install.cmd
 * on that PC, and every agent-side fix became a visit per customer. The agent
 * already trusts one place and talks to it every three seconds; this lets
 * that place answer "you are on 0.2.0, current is 0.3.0, here are the files"
 * and the agent does the rest (see apps/print-agent/src/updater.ts).
 *
 * What is served: the agent's own code — `dist/*.js`, `scripts/*.ps1` and
 * `package.json` (the version the agent reports comes from it, so it must
 * move with the code or an updated agent would forever think it is behind).
 * Never node.exe, nssm or agent.json; those are the installer's, and they
 * change once a year.
 *
 * The build is located, not bundled: `AGENT_RELEASE_DIR` when set, otherwise
 * the workspace's `apps/print-agent` next to this API (the Dockerfile builds
 * both). A missing build is not fatal — the release routes answer 404 and
 * agents simply stay on what they have.
 */

export interface ReleaseFile {
  /** Path relative to the install folder, forward slashes: `dist/index.js`. */
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseManifest {
  version: string;
  files: ReleaseFile[];
}

/** DI token for a release directory override (tests point it at a fixture). */
export const AGENT_RELEASE_DIR = Symbol('AGENT_RELEASE_DIR');

/** The only folders an agent ever replaces, and the only extensions in them. */
const SHIPPED: { dir: string; ext: string }[] = [
  { dir: 'dist', ext: '.js' },
  { dir: 'scripts', ext: '.ps1' },
];

@Injectable()
export class AgentReleaseService {
  private readonly logger = new Logger(AgentReleaseService.name);
  private cached: ReleaseManifest | null | undefined;
  private warned = false;

  private readonly releaseDir: string;

  constructor(@Optional() @Inject(AGENT_RELEASE_DIR) releaseDir?: string) {
    this.releaseDir = releaseDir ?? defaultReleaseDir();
  }

  /** The current build, or null when the API has none beside it. Read once. */
  manifest(): ReleaseManifest | null {
    if (this.cached !== undefined) return this.cached;
    this.cached = this.read();
    return this.cached;
  }

  /** `latestVersion` for the heartbeat reply; null when there is no build. */
  latestVersion(): string | null {
    return this.manifest()?.version ?? null;
  }

  /**
   * One shipped file's bytes. Only paths the manifest lists are served — the
   * manifest is the allow-list, so `..`, absolute paths and anything outside
   * dist/scripts are simply "not found".
   */
  file(path: string): { bytes: Buffer; entry: ReleaseFile } {
    const entry = this.manifest()?.files.find((f) => f.path === path);
    if (!entry) throw new NotFoundException('No such release file');
    const bytes = readFileSync(join(this.releaseDir, ...entry.path.split('/')));
    return { bytes, entry };
  }

  private read(): ReleaseManifest | null {
    const pkg = join(this.releaseDir, 'package.json');
    if (!existsSync(pkg)) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `No print-agent build at ${this.releaseDir}; agents will not self-update. ` +
            'Set AGENT_RELEASE_DIR or build apps/print-agent beside the API.',
        );
      }
      return null;
    }
    const version = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version;
    if (!version) return null;

    const files: ReleaseFile[] = [];
    {
      const bytes = readFileSync(pkg);
      files.push({ path: 'package.json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    for (const { dir, ext } of SHIPPED) {
      const abs = join(this.releaseDir, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs).sort()) {
        if (!name.endsWith(ext)) continue;
        const full = join(abs, name);
        if (!statSync(full).isFile()) continue;
        const bytes = readFileSync(full);
        files.push({
          path: `${dir}/${name}`,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
    // A build with no entry point is not a build; refusing here keeps an
    // agent from ever swapping in an empty folder.
    if (!files.some((f) => f.path === 'dist/index.js')) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`print-agent at ${this.releaseDir} has no dist/index.js — run its build.`);
      }
      return null;
    }
    this.logger.log(`Serving print-agent ${version} (${files.length} files) from ${this.releaseDir}`);
    return { version, files };
  }
}

/**
 * The agent workspace beside this API. From `apps/api/dist/modules/printing`
 * (dev and Docker alike, both run the compiled output) that is four levels up
 * and across — the same shape in a checkout and in the image, which is why it
 * is resolved from this file and not from the working directory.
 */
export function defaultReleaseDir(): string {
  const fromEnv = process.env.AGENT_RELEASE_DIR;
  if (fromEnv) return resolve(fromEnv);
  return resolve(__dirname, '..', '..', '..', '..', 'print-agent');
}
