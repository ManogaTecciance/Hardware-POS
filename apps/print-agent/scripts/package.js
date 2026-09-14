#!/usr/bin/env node
/**
 * D183 — build the customer release: one zip that installs with one script.
 *
 *   pnpm --filter @hardware-pos/print-agent package
 *   → apps/print-agent/release/axlo-print-agent-<version>.zip
 *
 * Contents are exactly what install.ps1 expects beside itself: dist/ (the
 * compiled agent), scripts/ (the Windows spooler helper), package.json,
 * install.ps1 and README-CUSTOMER.md. No node_modules — the agent has no
 * runtime dependencies, which is what makes "unzip and run" possible.
 *
 * Plain Node so it runs on the developer machine whatever the platform;
 * zipping uses PowerShell on Windows and `zip` elsewhere.
 */
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, rmSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const stageParent = join(root, 'release');
const stage = join(stageParent, 'axlo-print-agent');
const zip = join(stageParent, `axlo-print-agent-${version}.zip`);

if (!existsSync(join(root, 'dist', 'index.js'))) {
  console.error('dist/index.js is missing — run `pnpm build` first (the package script does).');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(stage, { recursive: true });

for (const entry of ['dist', 'scripts', 'package.json', 'install.ps1', 'README-CUSTOMER.md']) {
  const from = join(root, entry);
  if (!existsSync(from)) {
    console.error(`missing ${entry}`);
    process.exit(1);
  }
  cpSync(from, join(stage, entry), {
    recursive: true,
    // Source maps and type declarations are for developers; the customer
    // zip carries only what runs.
    filter: (src) => !/\.(map|d\.ts)$/.test(src) && !/package\.js$/.test(src),
  });
}

if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path "${stage}\\*" -DestinationPath "${zip}" -Force`],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-qr', zip, 'axlo-print-agent'], { cwd: stageParent, stdio: 'inherit' });
}

console.log(`release: ${zip}`);
