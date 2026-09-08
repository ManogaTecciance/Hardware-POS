/**
 * Probe: can a QuickBooks inventory item's `InvStartDate` be moved EARLIER once
 * the item already has transactions?
 *
 * This is the question behind sync error 6270 ("Transaction date is prior to
 * start date for inventory item"). A backdated POS sale is rejected when its
 * items started tracking quantity on hand after the sale's date. Moving the
 * item's start date back would fix it — if QuickBooks allows it over the API.
 *
 * Intuit's own docs describe `InvStartDate` as the date of the item's opening
 * balance transaction ("Inventory Starting Value"), and the QBO UI does let you
 * edit that date. Whether a sparse or full update applies it is the part worth
 * measuring rather than assuming, which is what this script does.
 *
 * Usage (from the repo root):
 *   pnpm --filter @hardware-pos/api probe:invstart -- --item 42
 *   pnpm --filter @hardware-pos/api probe:invstart -- --item 42 --date 2024-01-01 --apply
 *   pnpm --filter @hardware-pos/api probe:invstart -- --sku CEM-50 --apply --mode full
 *
 * Read-only by default: it reports the item's current state and the request it
 * WOULD send. `--apply` is what actually writes, and it writes to the connected
 * company — sandbox or production, whichever the tenant is linked to. The
 * original date is printed before any change so it can be put back.
 */

import * as path from 'node:path';

import {
  queryItemById,
  updateItemSparse,
  type QboItem,
} from '../src/modules/quickbooks/quickbooks.api';
import { decryptSecret, encryptSecret } from '../src/common/crypto';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_API_BASE = 'https://quickbooks.api.intuit.com';

interface CliOptions {
  itemId: string | null;
  sku: string | null;
  date: string;
  tenantId: string;
  apply: boolean;
  mode: 'sparse' | 'full' | 'both';
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    itemId: null,
    sku: null,
    // Far enough back that any realistic backdated sale clears it.
    date: '2020-01-01',
    tenantId: 'tnt_dev',
    apply: false,
    mode: 'both',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue; // pnpm passes the script-arg separator through
    if (arg === '--item') opts.itemId = argv[++i];
    else if (arg === '--sku') opts.sku = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--tenant') opts.tenantId = argv[++i];
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--mode') opts.mode = argv[++i] as CliOptions['mode'];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!opts.itemId && !opts.sku) {
    console.error('Give the item to probe: --item <quickbooksItemId> or --sku <sku>');
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    console.error(`--date must be YYYY-MM-DD (got "${opts.date}")`);
    process.exit(1);
  }
  if (!['sparse', 'full', 'both'].includes(opts.mode)) {
    console.error(`--mode must be sparse, full or both (got "${opts.mode}")`);
    process.exit(1);
  }
  return opts;
}

function loadEnvFile(filePath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch {
    /* env file is optional */
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} (apps/api/.env)`);
    process.exit(1);
  }
  return v;
}

interface Session {
  apiBase: string;
  realmId: string;
  accessToken: string;
}

/** Refresh and persist the OAuth pair, exactly as the seeding script does. */
async function connect(tenantId: string): Promise<Session> {
  loadEnvFile(path.resolve(__dirname, '../.env'));
  const clientId = requireEnv('QUICKBOOKS_CLIENT_ID');
  const clientSecret = requireEnv('QUICKBOOKS_CLIENT_SECRET');
  const encryptionKey = requireEnv('TOKEN_ENCRYPTION_KEY');

  const { prisma } = await import('@hardware-pos/database');
  const connection = await prisma.quickBooksConnection.findUnique({ where: { tenantId } });
  if (!connection || !connection.isActive) {
    console.error(
      `No QuickBooks connection for tenant "${tenantId}". Connect from the web app first: /quickbooks/connect`,
    );
    process.exit(1);
  }

  const refreshToken = decryptSecret(connection.refreshToken, encryptionKey);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    console.error(`Token refresh failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
  };
  const now = Date.now();
  await prisma.quickBooksConnection.update({
    where: { tenantId },
    data: {
      accessToken: encryptSecret(tokens.access_token, encryptionKey),
      refreshToken: encryptSecret(tokens.refresh_token, encryptionKey),
      accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
    },
  });

  return {
    apiBase:
      process.env.QUICKBOOKS_API_BASE ??
      (connection.environment === 'production' ? PRODUCTION_API_BASE : SANDBOX_API_BASE),
    realmId: connection.realmId,
    accessToken: tokens.access_token,
  };
}

/** Resolve a local SKU to the QuickBooks item id the POS has mapped for it. */
async function itemIdForSku(tenantId: string, sku: string): Promise<string> {
  const { prisma } = await import('@hardware-pos/database');
  const product = await prisma.product.findFirst({
    where: { tenantId, sku },
    select: { name: true, quickbooksItemId: true },
  });
  if (!product) {
    console.error(`No product with SKU "${sku}" for tenant ${tenantId}`);
    process.exit(1);
  }
  if (!product.quickbooksItemId) {
    console.error(`Product "${product.name}" (${sku}) is not linked to QuickBooks yet`);
    process.exit(1);
  }
  return product.quickbooksItemId;
}

/**
 * A full (non-sparse) Item update. Not in quickbooks.api.ts because the app only
 * ever sparse-updates; a full update replaces the whole entity, so every field
 * that should survive has to be echoed back.
 */
async function fullUpdate(
  session: Session,
  body: Record<string, unknown>,
): Promise<{ ok: true; item: QboItem } | { ok: false; status: number; detail: string }> {
  const res = await fetch(`${session.apiBase}/v3/company/${session.realmId}/item?minorversion=65`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, detail: text };
  return { ok: true, item: (JSON.parse(text) as { Item: QboItem }).Item };
}

function show(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${value ?? '—'}`);
}

/** Everything the probe reports about an item, before and after. */
function report(item: Record<string, unknown>): void {
  show('Id', item.Id);
  show('Name', item.Name);
  show('Sku', item.Sku);
  show('Type', item.Type);
  show('TrackQtyOnHand', item.TrackQtyOnHand);
  show('QtyOnHand', item.QtyOnHand);
  show('InvStartDate', item.InvStartDate);
  show('SyncToken', item.SyncToken);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const session = await connect(opts.tenantId);
  const itemId = opts.itemId ?? (await itemIdForSku(opts.tenantId, opts.sku as string));

  const params = {
    apiBase: session.apiBase,
    realmId: session.realmId,
    accessToken: session.accessToken,
  };
  const before = (await queryItemById(params, itemId)) as unknown as Record<string, unknown> | null;
  if (!before) {
    console.error(`QuickBooks item ${itemId} not found in realm ${session.realmId}`);
    process.exit(1);
  }

  const env = session.apiBase === PRODUCTION_API_BASE ? 'PRODUCTION' : 'sandbox';
  console.log(`\nQuickBooks item ${itemId} (${env}, realm ${session.realmId}) — BEFORE:`);
  report(before);

  if (before.Type !== 'Inventory') {
    console.log(
      `\nType is ${before.Type}, not Inventory — it has no InvStartDate and cannot raise error 6270.`,
    );
    console.log('Nothing to probe. Non-inventory items can be dated freely.');
    return;
  }

  console.log(`\nWould move InvStartDate  ${before.InvStartDate} → ${opts.date}`);

  if (!opts.apply) {
    console.log('\nRead-only run. Re-run with --apply to actually attempt it.');
    console.log(`Record the current value first: InvStartDate = ${before.InvStartDate}`);
    return;
  }

  console.log(`\n⚠  Writing to the ${env} company now.\n`);

  const attempts: Array<'sparse' | 'full'> =
    opts.mode === 'both' ? ['sparse', 'full'] : [opts.mode];

  for (const mode of attempts) {
    // Re-read each time: a failed attempt leaves the SyncToken alone, but a
    // successful one bumps it, and QBO rejects a stale token outright.
    const current = (await queryItemById(params, itemId)) as unknown as Record<string, unknown>;
    console.log(`── ${mode} update ─────────────────────────────────────────`);

    try {
      if (mode === 'sparse') {
        const updated = (await updateItemSparse(params, {
          Id: String(current.Id),
          SyncToken: String(current.SyncToken),
          InvStartDate: opts.date,
        })) as unknown as Record<string, unknown>;
        console.log('  HTTP 200 — QuickBooks accepted the request.');
        console.log(`  InvStartDate now: ${updated.InvStartDate}`);
        // Accepting the call and honouring the field are different things.
        console.log(
          updated.InvStartDate === opts.date
            ? '  ✅ Applied — the start date really moved.'
            : `  ⚠  IGNORED — still ${updated.InvStartDate}. QuickBooks took the request but kept the old date.`,
        );
      } else {
        const result = await fullUpdate(session, {
          ...current,
          InvStartDate: opts.date,
        });
        if (!result.ok) {
          console.log(`  HTTP ${result.status} — rejected.`);
          console.log(`  ${result.detail}`);
        } else {
          const updated = result.item as unknown as Record<string, unknown>;
          console.log('  HTTP 200 — QuickBooks accepted the request.');
          console.log(`  InvStartDate now: ${updated.InvStartDate}`);
          console.log(
            updated.InvStartDate === opts.date
              ? '  ✅ Applied — the start date really moved.'
              : `  ⚠  IGNORED — still ${updated.InvStartDate}.`,
          );
        }
      }
    } catch (err) {
      // quickbooks.api throws with the QBO fault body attached; that body is the
      // whole point of the probe, so print it verbatim rather than a summary.
      console.log(`  Rejected: ${(err as Error).message}`);
    }
    console.log('');
  }

  const after = (await queryItemById(params, itemId)) as unknown as Record<string, unknown>;
  console.log('AFTER:');
  report(after);
  console.log(
    after.InvStartDate === before.InvStartDate
      ? `\nUnchanged — still ${before.InvStartDate}. Moving the start date over the API is not available here.`
      : `\nChanged: ${before.InvStartDate} → ${after.InvStartDate}. Re-run with --date ${before.InvStartDate} to put it back.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import('@hardware-pos/database');
    await prisma.$disconnect();
  });
