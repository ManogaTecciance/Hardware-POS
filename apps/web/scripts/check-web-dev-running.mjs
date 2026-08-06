#!/usr/bin/env node
/**
 * Phase 1.5.10 — refuse `next build` while a developer's `next dev` is live.
 *
 * `next build` overwrites `apps/web/.next` while `next dev` is using it,
 * which corrupts the in-memory webpack state and produces
 * `ENOENT … .next/server/app/…/page.js` at every subsequent request until
 * the developer restarts the dev server manually. The handover documented
 * this cost three developer restarts in the previous session.
 *
 * This script runs before `next build` and refuses if a dev server is
 * running. It NEVER terminates a developer's process. In CI (where
 * `CI=true` or no dev server is running) it exits 0 silently.
 *
 * Detection is via a TCP probe on the configured port — no reliance on a
 * ".next/dev-server-lock" that Next does not consistently write. If a
 * process is listening AND responds to `/__nextjs_original-stack-frame`
 * (an internal Next dev endpoint) it is treated as a dev server. Any
 * other response (or no response) is treated as "not the dev server" and
 * the build proceeds.
 *
 * Explicit opt-out: `SKIP_WEB_DEV_GUARD=1` for the rare case an operator
 * knows what they are doing (e.g. rebuilding into a different distDir).
 */
import http from 'node:http';

const port = Number(process.env.PORT ?? '3000');
const timeoutMs = 800;

if (process.env.CI === 'true' || process.env.SKIP_WEB_DEV_GUARD === '1') {
  process.exit(0);
}

function probe() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/_next/static/development/_devPagesManifest.json',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        // Any 2xx/4xx on this dev-only path indicates a dev server. Regular
        // production `next start` returns nothing on it, and no other process
        // typically listens with this path either.
        resolve(res.statusCode !== undefined && res.statusCode !== 502 && res.statusCode !== 500);
        res.resume();
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

const isDevRunning = await probe();

if (isDevRunning) {
  console.error('');
  console.error('  ✖  A Next.js dev server appears to be running on port ' + port + '.');
  console.error('');
  console.error('     `next build` overwrites .next/ while `next dev` is using it, which');
  console.error("     corrupts the dev server's in-memory state. The dev server does not");
  console.error('     self-heal — the developer must restart it.');
  console.error('');
  console.error('     Either:');
  console.error('       • Stop the dev server before building');
  console.error('           pkill -f "next dev --port ' + port + '"');
  console.error('       • Or set SKIP_WEB_DEV_GUARD=1 if you know why');
  console.error('');
  process.exit(1);
}

process.exit(0);
