import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@nestjs/common';

import { AgentReleaseService } from './agent-release.service';

/**
 * D183 — what the API tells agents about the build it carries.
 *
 * Against a temp folder shaped like apps/print-agent, so the manifest is
 * checked against real bytes, not a stub: a listed file must have the right
 * sha256, an unlisted or escaped path must be a 404, and a folder that is not
 * a build (no dist/index.js, no package.json) must yield "no release", never
 * a crash and never a half manifest an agent might act on.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function build(opts: { version?: string; index?: boolean; extra?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-release-'));
  if (opts.version !== null) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: opts.version ?? '0.3.0' }));
  }
  mkdirSync(join(dir, 'dist'));
  mkdirSync(join(dir, 'scripts'));
  if (opts.index !== false) writeFileSync(join(dir, 'dist', 'index.js'), 'console.log(1)');
  writeFileSync(join(dir, 'dist', 'printer.js'), 'module.exports={}');
  writeFileSync(join(dir, 'dist', 'index.js.map'), '{}'); // not shipped
  writeFileSync(join(dir, 'scripts', 'windows-raw-printer.ps1'), 'Write-Host hi');
  writeFileSync(join(dir, 'scripts', 'package.js'), '// not shipped'); // wrong extension for scripts/
  for (const [p, c] of Object.entries(opts.extra ?? {})) writeFileSync(join(dir, p), c);
  return dir;
}

describe('AgentReleaseService', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('lists exactly dist/*.js and scripts/*.ps1 with sizes and sha256, sorted', () => {
    const dir = build();
    dirs.push(dir);
    const m = new AgentReleaseService(dir).manifest();
    expect(m?.version).toBe('0.3.0');
    expect(m?.files.map((f) => f.path)).toEqual(['package.json', 'dist/index.js', 'dist/printer.js', 'scripts/windows-raw-printer.ps1']);
    const index = m!.files.find((f) => f.path === 'dist/index.js')!;
    expect(index.size).toBe('console.log(1)'.length);
    expect(index.sha256).toBe(sha('console.log(1)'));
    expect(new AgentReleaseService(dir).latestVersion()).toBe('0.3.0');
  });

  it('serves a listed file by its manifest path, and nothing else', () => {
    const dir = build({ extra: { 'agent.json': '{"token":"secret"}' } });
    dirs.push(dir);
    const svc = new AgentReleaseService(dir);
    expect(svc.file('scripts/windows-raw-printer.ps1').bytes.toString()).toBe('Write-Host hi');
    for (const bad of ['agent.json', '../agent.json', 'dist/../agent.json', 'dist/index.js.map', 'scripts/package.js', 'tools/node.exe', '']) {
      expect(() => svc.file(bad)).toThrow(NotFoundException);
    }
  });

  it('a folder without package.json is "no release", not an error', () => {
    const dir = build({ version: null as unknown as string });
    dirs.push(dir);
    const svc = new AgentReleaseService(dir);
    expect(svc.manifest()).toBeNull();
    expect(svc.latestVersion()).toBeNull();
    expect(() => svc.file('dist/index.js')).toThrow(NotFoundException);
  });

  it('a build with no dist/index.js is refused as a whole', () => {
    const dir = build({ index: false });
    dirs.push(dir);
    expect(new AgentReleaseService(dir).manifest()).toBeNull();
  });

  it('a missing directory is "no release", not an error', () => {
    expect(new AgentReleaseService(join(tmpdir(), 'agent-release-does-not-exist')).manifest()).toBeNull();
  });
});
