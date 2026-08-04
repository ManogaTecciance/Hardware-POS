/**
 * Structural rules for the provider layer, enforced against the source text.
 *
 * These are the rules that a reviewer would otherwise have to remember on every
 * future pull request: no vendor types in the ports, a transaction client on every
 * mutator, no provider opening its own transaction, and Slice 5 staying inert.
 *
 * Reading the files as text is crude, and deliberately so. A type-level check
 * cannot express "this file must not import from that directory", and a runtime
 * check cannot prove the absence of a `$transaction` call on a path no test
 * happens to exercise. The tests below fail the moment someone adds the thing they
 * forbid, which is the only property that matters.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PROVIDERS_DIR = resolve(__dirname);
const API_SRC = resolve(__dirname, '../..');

const PORT_FILES = [
  'inventory/inventory-provider.ts',
  'accounting/accounting-provider.ts',
  'provider.types.ts',
];

const IMPLEMENTATION_FILES = [
  'inventory/local-inventory.provider.ts',
  'inventory/quickbooks-inventory.provider.ts',
  'inventory/no-inventory.provider.ts',
  'accounting/quickbooks-accounting.provider.ts',
  'accounting/no-accounting.provider.ts',
];

const FACTORY_FILES = [
  'inventory/inventory-provider.factory.ts',
  'accounting/accounting-provider.factory.ts',
];

function read(relative: string): string {
  return readFileSync(resolve(PROVIDERS_DIR, relative), 'utf8');
}

/** Every `from '…'` specifier in a file. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
}

/** Strip comments so a rule matches real code, not prose describing it. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14 — no QuickBooks or vendor types in the ports
// ─────────────────────────────────────────────────────────────────────────────

describe('the ports expose no QuickBooks SDK or vendor types', () => {
  it.each(PORT_FILES)('%s imports nothing from the QuickBooks module', (file) => {
    const bad = importsOf(read(file)).filter((spec) => spec.includes('quickbooks'));
    expect(bad).toEqual([]);
  });

  it.each(PORT_FILES)('%s imports no Intuit or QuickBooks package', (file) => {
    const bad = importsOf(read(file)).filter((spec) =>
      /^(intuit|node-quickbooks|@intuit)/.test(spec),
    );
    expect(bad).toEqual([]);
  });

  it.each(PORT_FILES)('%s imports no REST DTO', (file) => {
    // A DTO is an HTTP transport shape carrying class-validator metadata. Passing
    // one into a domain port couples the port to the wire format.
    const bad = importsOf(read(file)).filter((spec) => /\bdto\b|\/dto\//.test(spec));
    expect(bad).toEqual([]);
  });

  it.each(PORT_FILES)('%s imports only Prisma primitives and its own types', (file) => {
    for (const spec of importsOf(read(file))) {
      expect(spec).toMatch(/^(@hardware-pos\/database|\.\.?\/)/);
    }
  });

  it('the ports reference no Intuit vocabulary in their signatures', () => {
    for (const file of ['inventory/inventory-provider.ts', 'provider.types.ts']) {
      const code = codeOnly(read(file));
      expect(code).not.toMatch(/\bRealm|realmId|CustomerRef|ItemRef|Qbo[A-Z]|QboClient/);
    }
  });

  /**
   * The accounting port names the two document-type enums, which is correct: they
   * are Prisma enums declared in this repository's own schema, not vendor types.
   * The rule is "no vendor SDK", not "never say the word QuickBooks".
   */
  it('the accounting port names only this repository\'s own document enums', () => {
    const code = codeOnly(read('accounting/accounting-provider.ts'));
    expect(code).toContain('QuickBooksDocumentType');
    expect(code).toContain('QuickBooksReturnDocumentType');
    expect(importsOf(code).filter((s) => s.includes('quickbooks'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17 — every mutating method accepts a Prisma.TransactionClient
// ─────────────────────────────────────────────────────────────────────────────

describe('every mutating provider method accepts Prisma.TransactionClient', () => {
  const MUTATORS = ['reduceStock', 'restoreStock', 'adjustStock', 'postSale', 'postReturn'];

  it.each(PORT_FILES.slice(0, 2))('%s declares tx as the first parameter', (file) => {
    const source = read(file);
    for (const method of MUTATORS) {
      const declaration = new RegExp(
        `${method}\\s*\\(\\s*tx:\\s*Prisma\\.TransactionClient`,
      );
      if (source.includes(`${method}(`)) {
        expect(source).toMatch(declaration);
      }
    }
  });

  it.each(IMPLEMENTATION_FILES)('%s takes tx first on every mutator it implements', (file) => {
    const source = read(file);
    for (const method of MUTATORS) {
      if (!source.includes(`${method}(`)) continue;
      expect(source).toMatch(new RegExp(`${method}\\s*\\(\\s*_?tx:\\s*Prisma\\.TransactionClient`));
    }
  });

  it('read-only methods deliberately take no transaction client', () => {
    // getAvailability and synchronize must NOT be transactional: holding a
    // transaction open across an external API call is the mistake the signature
    // exists to make impossible.
    for (const file of PORT_FILES.slice(0, 2)) {
      const source = read(file);
      expect(source).not.toMatch(/getAvailability\s*\(\s*tx:/);
      expect(source).not.toMatch(/synchronize\s*\(\s*tx:/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19 — no provider starts a nested transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('no provider starts its own transaction', () => {
  it.each([...IMPLEMENTATION_FILES, ...FACTORY_FILES])('%s never calls $transaction', (file) => {
    // A provider that opens its own transaction commits independently of the
    // caller's, so overselling becomes possible again and the outbox stops being
    // an outbox.
    expect(codeOnly(read(file))).not.toContain('$transaction');
  });

  it.each(IMPLEMENTATION_FILES)('%s never calls $connect or $disconnect', (file) => {
    const code = codeOnly(read(file));
    expect(code).not.toContain('$connect');
    expect(code).not.toContain('$disconnect');
  });

  it('the no-op providers hold no database or queue dependency at all', () => {
    // The structural guarantee behind "creates no SyncJob/SyncLog": they have no
    // mechanism to write a row.
    for (const file of ['inventory/no-inventory.provider.ts', 'accounting/no-accounting.provider.ts']) {
      const code = codeOnly(read(file));
      expect(code).not.toContain('PrismaService');
      expect(code).not.toContain('SyncQueueService');
      expect(code).toMatch(/class No\w+Provider/);
      // No constructor means no injected dependency.
      expect(code).not.toMatch(/constructor\s*\(/);
    }
  });

  it('the mutators write only through the tx they were given', () => {
    for (const file of [
      'inventory/local-inventory.provider.ts',
      'inventory/quickbooks-inventory.provider.ts',
    ]) {
      const code = codeOnly(read(file));
      // Any product write must be `tx.product.updateMany`, never
      // `this.prisma.product.update…`.
      expect(code).not.toMatch(/this\.prisma\.product\.update/);
      expect(code).not.toMatch(/this\.prisma\.product\.create/);
      expect(code).toMatch(/tx\.product\.updateMany/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 5 inertness
// ─────────────────────────────────────────────────────────────────────────────

describe('Slice 5 is inert', () => {
  const CALL_SITE_FILES = [
    'modules/sales/sales.service.ts',
    'modules/sales/sales.repository.ts',
    'modules/returns/returns.service.ts',
    'modules/returns/returns.repository.ts',
    'modules/products/products.service.ts',
    'modules/quotations/quotations.service.ts',
    'modules/payments/payments.service.ts',
    'modules/sync/queue/sync-worker.service.ts',
    'modules/sync/queue/sync-queue.service.ts',
    'modules/sync/sync.service.ts',
  ];

  it.each(CALL_SITE_FILES)('%s does not reference a provider', (file) => {
    const source = readFileSync(resolve(API_SRC, file), 'utf8');
    expect(source).not.toContain('InventoryProvider');
    expect(source).not.toContain('AccountingProvider');
    expect(source).not.toContain('providers/');
  });

  it('ProvidersModule is not wired into AppModule', () => {
    // Slice 6 adds this import as part of the deliberate adoption diff. Until
    // then, nothing in the running application can construct a provider.
    const appModule = readFileSync(resolve(API_SRC, 'app.module.ts'), 'utf8');
    expect(appModule).not.toContain('ProvidersModule');
  });

  it('nothing outside the providers directory imports a provider', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'providers') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (full.startsWith(PROVIDERS_DIR)) continue;
        if (importsOf(readFileSync(full, 'utf8')).some((s) => s.includes('providers/'))) {
          offenders.push(full.replace(`${API_SRC}/`, ''));
        }
      }
    };
    walk(API_SRC);
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 5.5 — the accounting result model, and document-renderer independence
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountingSubmissionResult contains no QuickBooks SDK types', () => {
  const types = read('provider.types.ts');

  it('declares the discriminated union with both dispositions', () => {
    expect(types).toContain('AccountingSubmissionResult');
    expect(types).toContain("disposition: 'QUEUED'");
    expect(types).toContain("disposition: 'NOT_REQUIRED'");
  });

  it('carries only a disposition, a provider discriminator, and a document type', () => {
    const union = /export type AccountingSubmissionResult[\s\S]*?\n\n/.exec(types)?.[0] ?? '';
    // Any other field would be a place for provider internals to leak.
    const fields = [...union.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
    expect([...new Set(fields)].sort()).toEqual([
      'disposition',
      'externalDocumentType',
      'provider',
    ]);
  });

  it('never expresses the ambiguous "synced with no document" shape', () => {
    // Decision 1: `{ markSynced: true, quickbooksDocumentType: null }` says a sync
    // succeeded AND that there is no document, and the safe-looking reading is wrong.
    // Comments are stripped first — the doc comment names the anti-pattern in order
    // to explain why it is rejected, and that prose must not fail its own rule.
    expect(codeOnly(types)).not.toMatch(/markSynced|\bsynced\s*:/);
  });

  it('imports no QuickBooks module, package, or DTO', () => {
    for (const spec of importsOf(types)) {
      expect(spec).not.toMatch(/quickbooks|intuit|\bdto\b/i);
    }
  });
});

describe('customer document renderers do not depend on external accounting metadata', () => {
  const WEB_SRC = resolve(API_SRC, '../../web/src');

  /** Renderers that produce customer-facing output. */
  const CLIENT_RENDERERS = [
    'components/documents/sale-a4-document.tsx',
    'lib/document-template-service.ts',
    'app/print/sales/[saleId]/page.tsx',
  ];

  it.each(CLIENT_RENDERERS)('%s never reads quickbooksDocumentType', (file) => {
    // The strongest form of "tolerates null": it cannot be affected by a field it
    // never reads. Title and status badge come from local financial facts
    // (`paymentStatus`) instead.
    const source = readFileSync(resolve(WEB_SRC, file), 'utf8');
    expect(source).not.toContain('quickbooksDocumentType');
  });

  it('the client A4 document derives its badge from paymentStatus', () => {
    const source = readFileSync(
      resolve(WEB_SRC, 'components/documents/sale-a4-document.tsx'),
      'utf8',
    );
    expect(source).toContain('sale.paymentStatus');
  });

  it('the server-side A4 builder never reads quickbooksDocumentType', () => {
    const source = readFileSync(resolve(API_SRC, 'modules/documents/documents.service.ts'), 'utf8');
    expect(source).not.toContain('quickbooksDocumentType');
  });

  it('the thermal sale receipt template guards its external document badge', () => {
    const source = readFileSync(resolve(API_SRC, 'modules/receipts/receipt-templates.ts'), 'utf8');
    // A null must omit the badge, not render an empty one.
    expect(source).toMatch(/d\.documentType\s*\?/);
  });

  it('the thermal return receipt never unconditionally prints QuickBooks wording', () => {
    const template = readFileSync(
      resolve(API_SRC, 'modules/returns/return-receipt.template.ts'),
      'utf8',
    );
    // The row exists, but only behind `d.syncStatus`, which the service now nulls
    // for a tenant with no accounting provider.
    expect(template).toMatch(/d\.syncStatus\s*\?[\s\S]{0,120}QuickBooks/);
    const service = readFileSync(resolve(API_SRC, 'modules/returns/returns.service.ts'), 'utf8');
    expect(service).toMatch(/quickbooksDocumentType === null \? null : ret\.syncStatus/);
  });

  it('the return receipt label has a local-semantics fallback for null', () => {
    const service = readFileSync(resolve(API_SRC, 'modules/returns/returns.service.ts'), 'utf8');
    // Both QuickBooks branches are explicit, and the fallback uses refundMethod —
    // a local fact — rather than letting a null land on "Refund Receipt" by accident.
    expect(service).toContain("=== 'CREDIT_MEMO'");
    expect(service).toContain("=== 'REFUND_RECEIPT'");
    expect(service).toContain("refundMethod === 'STORE_CREDIT'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 30 — no Prisma migration generated
// ─────────────────────────────────────────────────────────────────────────────

describe('Slice 5 generated no Prisma migration', () => {
  const MIGRATIONS_DIR = resolve(API_SRC, '../../../packages/database/prisma/migrations');

  it('the migration count is unchanged at 20 (19 pre-existing + Slice 4)', () => {
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs).toHaveLength(20);
    expect(dirs).toContain('20260804121830_add_tenant_platform_profile');
  });

  it('no migration mentions a provider or a restaurant table', () => {
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((e) =>
      e.isDirectory(),
    );
    for (const dir of dirs) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, dir.name, 'migration.sql'), 'utf8');
      for (const forbidden of [
        'BranchInventory',
        'StockMovement',
        'RestaurantOrder',
        'DiningTable',
        'MenuItem',
        'KitchenTicket',
      ]) {
        expect(sql).not.toContain(forbidden);
      }
    }
  });
});
