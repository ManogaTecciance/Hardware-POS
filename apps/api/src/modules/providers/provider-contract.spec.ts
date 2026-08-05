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

import {
  collectFiles,
  importsOf,
  listSourceFiles,
  referencesIdentifier,
  stripComments,
} from './testkit/source-analysis';

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

/**
 * Retained alias. `codeOnly` was this file's private comment stripper until Slice
 * 6C-A.5 moved it into `testkit/source-analysis.ts`, where it is tested against
 * fixtures rather than assumed correct.
 */
const codeOnly = stripComments;

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

describe('Slice 6C-A adopted the sale and return paths, and only those', () => {
  /**
   * Rewritten in Slice 6C-A.5 to the non-vacuous standard.
   *
   * Through 5.5 this block asserted total inertness. 6A adopted sale accounting,
   * 6B return accounting, 6C-A sale and return inventory. Twice now the block was
   * updated by rewriting the *expected value* and leaving the *technique* alone,
   * and twice the technique turned out to be the problem:
   *
   *  • `onHand === 99` was true whether or not the provider was consulted.
   *  • `toContain('decrementStock')` matched a comment saying it had been deleted.
   *
   * So every assertion below now pairs a positive with a negative, or compares an
   * exact set, and all of them go through the fixture-tested analyser in
   * `testkit/source-analysis.ts`. `referencesIdentifier` reads code only, so a
   * comment can no longer satisfy or defeat a rule.
   */
  const ADOPTED_PATHS = ['modules/sales', 'modules/returns'];

  /**
   * Files that must stay clear of the provider layer. Each carries the legacy call
   * site that proves it is still on the old path — a negative alone would also pass
   * for a file that had been deleted, emptied, or renamed.
   */
  const NOT_YET_ADOPTED: { file: string; legacyMarker: string }[] = [
    { file: 'modules/products/products.service.ts', legacyMarker: 'SyncQueueService' },
    { file: 'modules/quotations/quotations.service.ts', legacyMarker: 'QuotationsRepository' },
    { file: 'modules/payments/payments.service.ts', legacyMarker: 'PaymentsRepository' },
    { file: 'modules/sync/queue/sync-worker.service.ts', legacyMarker: 'SyncJob' },
    { file: 'modules/sync/queue/sync-queue.service.ts', legacyMarker: 'enqueueSaleSync' },
    { file: 'modules/sync/sync.service.ts', legacyMarker: 'SyncRepository' },
    { file: 'modules/quickbooks/quickbooks-sales-sync.service.ts', legacyMarker: 'syncSale' },
    { file: 'modules/quickbooks/quickbooks-returns-sync.service.ts', legacyMarker: 'syncReturn' },
    { file: 'modules/quickbooks/quickbooks-product-sync.service.ts', legacyMarker: 'quickbooksItemId' },
  ];

  it.each(NOT_YET_ADOPTED)(
    '$file references no provider, and still has its legacy call site',
    ({ file, legacyMarker }) => {
      const source = readFileSync(resolve(API_SRC, file), 'utf8');

      // NEGATIVE — the future state is absent.
      expect(referencesIdentifier(source, 'InventoryProvider')).toBe(false);
      expect(referencesIdentifier(source, 'AccountingProvider')).toBe(false);
      expect(referencesIdentifier(source, 'CatalogSyncProvider')).toBe(false);
      expect(importsOf(source).filter((spec) => spec.includes('providers/'))).toEqual([]);

      // POSITIVE — the current state is present, so the negatives above are being
      // evaluated against a real file with real content rather than an empty one.
      expect(referencesIdentifier(source, legacyMarker)).toBe(true);
    },
  );

  it.each(['modules/sales/sales.service.ts', 'modules/returns/returns.service.ts'])(
    '%s resolves BOTH providers, each from its own factory',
    (file) => {
      const service = readFileSync(resolve(API_SRC, file), 'utf8');

      expect(referencesIdentifier(service, 'AccountingProviderFactory')).toBe(true);
      expect(referencesIdentifier(service, 'InventoryProviderFactory')).toBe(true);
      // And not the catalogue one — that is 6C-B.
      expect(referencesIdentifier(service, 'CatalogSyncProvider')).toBe(false);
    },
  );

  it.each(['modules/sales/sales.repository.ts', 'modules/returns/returns.repository.ts'])(
    '%s takes both as callbacks and resolves no provider itself',
    (file) => {
      const repository = readFileSync(resolve(API_SRC, file), 'utf8');

      // NEGATIVE — no factory, and no direct stock write.
      expect(referencesIdentifier(repository, 'AccountingProviderFactory')).toBe(false);
      expect(referencesIdentifier(repository, 'InventoryProviderFactory')).toBe(false);
      expect(referencesIdentifier(repository, 'quantityOnHand')).toBe(false);

      // POSITIVE — the callback seams it does have. Without these the negatives
      // above would also hold for a repository that had simply stopped doing
      // anything, which is exactly the `decrementStock` failure repeated.
      expect(referencesIdentifier(repository, 'AccountingSubmissionResult')).toBe(true);
      expect(referencesIdentifier(repository, 'StockLine')).toBe(true);
      expect(referencesIdentifier(repository, 'postAccountingChecked')).toBe(true);
    },
  );

  it('stock movement lives in exactly one layer — the providers, and nowhere else', () => {
    // EXACT SET. A count would not distinguish "the right three files" from "three
    // different ones", and a per-file negative would not notice a fourth appearing.
    const writers = collectFiles(API_SRC, {
      accept: (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
      predicate: (content) => /quantityOnHand:\s*\{\s*(increment|decrement)/.test(stripComments(content)),
    });

    expect(writers).toEqual([
      'modules/providers/inventory/local-inventory.provider.ts',
      'modules/providers/inventory/quickbooks-inventory.provider.ts',
    ]);
  });

  it('the return domain, not the provider, decides which lines restock', () => {
    const service = readFileSync(resolve(API_SRC, 'modules/returns/returns.service.ts'), 'utf8');
    expect(referencesIdentifier(service, 'RETURN_TO_STOCK')).toBe(true);
    expect(referencesIdentifier(service, 'itemCondition')).toBe(true);

    // `listSourceFiles` throws on an empty listing, so this loop cannot pass by
    // checking nothing — the failure mode of the version it replaces.
    const providers = listSourceFiles(resolve(PROVIDERS_DIR, 'inventory'));
    expect(providers.length).toBeGreaterThanOrEqual(3);
    for (const file of providers) {
      const source = readFileSync(resolve(PROVIDERS_DIR, 'inventory', file), 'utf8');
      expect(referencesIdentifier(source, 'RETURN_TO_STOCK')).toBe(false);
      expect(referencesIdentifier(source, 'itemCondition')).toBe(false);
    }
  });

  it('no inventory provider opens its own transaction, and each really was inspected', () => {
    const providers = listSourceFiles(resolve(PROVIDERS_DIR, 'inventory'));
    const inspected: string[] = [];
    for (const file of providers) {
      const source = readFileSync(resolve(PROVIDERS_DIR, 'inventory', file), 'utf8');
      expect(referencesIdentifier(source, '$transaction')).toBe(false);
      inspected.push(file);
    }
    // The positive control: name the files that were actually read.
    expect(inspected).toEqual([
      'inventory-provider.factory.ts',
      'inventory-provider.ts',
      'local-inventory.provider.ts',
      'no-inventory.provider.ts',
      'quickbooks-inventory.provider.ts',
    ]);
  });

  it('the multi-branch guard is intact on every LOCAL mutator', () => {
    const local = stripComments(
      readFileSync(resolve(PROVIDERS_DIR, 'inventory/local-inventory.provider.ts'), 'utf8'),
    );
    expect(local).toContain('UnsafeMultiBranchInventoryError');
    // One definition plus one call from each of the four operations.
    expect((local.match(/assertSingleBranch\(/g) ?? []).length).toBe(5);
    // And the QuickBooks provider must NOT have it — the guard is about the LOCAL
    // authority only, so an identical count in both would mean nothing.
    const quickbooks = stripComments(
      readFileSync(resolve(PROVIDERS_DIR, 'inventory/quickbooks-inventory.provider.ts'), 'utf8'),
    );
    expect(quickbooks).not.toContain('assertSingleBranch');
  });

  it('ProvidersModule is imported only by the modules that resolve a provider', () => {
    const importers = collectFiles(API_SRC, {
      skipDirs: ['providers'],
      accept: (name) => name.endsWith('.module.ts'),
      predicate: (content) => referencesIdentifier(content, 'ProvidersModule'),
    });

    // Not AppModule, and not every feature module "because it is live now".
    expect(importers).toEqual([
      'modules/returns/returns.module.ts',
      'modules/sales/sales.module.ts',
    ]);
  });

  it('only the sales and returns modules import from the providers directory', () => {
    const offenders = collectFiles(API_SRC, {
      skipDirs: ['providers'],
      predicate: (content) => importsOf(content).some((spec) => spec.includes('providers/')),
    });

    expect(offenders).toEqual([
      'modules/returns/customer-return-document.spec.ts',
      'modules/returns/returns.module.ts',
      'modules/returns/returns.repository.ts',
      'modules/returns/returns.service.spec.ts',
      'modules/returns/returns.service.ts',
      'modules/returns/returns.types.ts',
      'modules/sales/sales.module.ts',
      'modules/sales/sales.repository.ts',
      'modules/sales/sales.service.ts',
    ]);
    // Every offender is inside an adopted module — stated separately so a future
    // path outside sales/returns fails loudly even if someone updates the list.
    for (const file of offenders) {
      expect(ADOPTED_PATHS.some((prefix) => file.startsWith(prefix))).toBe(true);
    }
  });

  it('the test-only analyser is never imported by production code', () => {
    const importers = collectFiles(API_SRC, {
      accept: (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
      predicate: (content) => importsOf(content).some((spec) => spec.includes('testkit/')),
    });
    expect(importers).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 6C-A.5 — mutation proofs for the high-risk tripwires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approved pattern 4. Each test below takes the **real** current source, injects
 * the change the tripwire forbids, and asserts the analyser's answer flips.
 *
 * Production code is never mutated: the injection happens in memory, on a string.
 * That keeps the proof deterministic and leaves nothing to clean up, at the cost
 * of proving the *rule* rather than the whole `it()` body — so each proof mirrors
 * the exact predicate its tripwire uses, and they sit next to each other here so a
 * change to one is obvious against the other.
 */
describe('the adoption tripwires can actually fail', () => {
  function sourceOf(relative: string): string {
    return readFileSync(resolve(API_SRC, relative), 'utf8');
  }

  it('ProductsService adoption would be detected — the highest-risk boundary', () => {
    const real = sourceOf('modules/products/products.service.ts');
    expect(referencesIdentifier(real, 'CatalogSyncProvider')).toBe(false);

    const mutated = [
      "import { CatalogSyncProviderFactory } from '../providers/catalog/catalog-sync-provider.factory';",
      real,
    ].join('\n');
    expect(mutated).not.toEqual(real);
    expect(referencesIdentifier(mutated, 'CatalogSyncProvider')).toBe(true);
    expect(importsOf(mutated).filter((s) => s.includes('providers/'))).toEqual([
      '../providers/catalog/catalog-sync-provider.factory',
    ]);
  });

  it('a provider import hidden in a comment would NOT be detected — and must not be', () => {
    const real = sourceOf('modules/products/products.service.ts');
    const commented = `// import { CatalogSyncProviderFactory } from '../providers/catalog/x';\n${real}`;
    expect(referencesIdentifier(commented, 'CatalogSyncProvider')).toBe(false);
    expect(importsOf(commented).filter((s) => s.includes('providers/'))).toEqual([]);
  });

  it('a stock write reappearing in a repository would be detected', () => {
    const real = sourceOf('modules/sales/sales.repository.ts');
    expect(referencesIdentifier(real, 'quantityOnHand')).toBe(false);

    const mutated = real.replace(
      'await reduceStock(tx, toStockLines(input.computed.lines));',
      'await tx.product.updateMany({ data: { quantityOnHand: { decrement: 1 } } });',
    );
    expect(mutated).not.toEqual(real);
    expect(referencesIdentifier(mutated, 'quantityOnHand')).toBe(true);
  });

  it('a comment mentioning a deleted symbol does not resurrect it — the 6C-A regression', () => {
    // `sales.repository.ts` really does still say "decrementStock" in a comment
    // explaining where it went. A test asserting the function is present used to
    // pass on exactly this, while claiming stock had not been adopted.
    const real = sourceOf('modules/sales/sales.repository.ts');
    expect(real).toContain('decrementStock');
    expect(referencesIdentifier(real, 'decrementStock')).toBe(false);
  });

  it('a new ProvidersModule importer would be detected by the exact-set assertion', () => {
    const importers = collectFiles(API_SRC, {
      skipDirs: ['providers'],
      accept: (name) => name.endsWith('.module.ts'),
      predicate: (content) => referencesIdentifier(content, 'ProvidersModule'),
    });
    const withNewImporter = [...importers, 'modules/products/products.module.ts'].sort();
    // The assertion the tripwire makes, applied to the mutated set, must fail.
    expect(withNewImporter).not.toEqual(importers);
    expect(() =>
      expect(withNewImporter).toEqual([
        'modules/returns/returns.module.ts',
        'modules/sales/sales.module.ts',
      ]),
    ).toThrow();
  });

  it('an inventory provider opening its own transaction would be detected', () => {
    const real = readFileSync(
      resolve(PROVIDERS_DIR, 'inventory/local-inventory.provider.ts'),
      'utf8',
    );
    expect(referencesIdentifier(real, '$transaction')).toBe(false);
    const mutated = real.replace(
      'async reduceStock(',
      ['async other() { await this.prisma.$transaction(async () => {}); }', '  async reduceStock('].join(
        '\n',
      ),
    );
    expect(mutated).not.toEqual(real);
    expect(referencesIdentifier(mutated, '$transaction')).toBe(true);
  });

  it('removing the multi-branch guard would be detected', () => {
    const real = readFileSync(
      resolve(PROVIDERS_DIR, 'inventory/local-inventory.provider.ts'),
      'utf8',
    );
    const mutated = stripComments(real).replace(/await this\.assertSingleBranch\([^;]+;/g, '');
    expect((stripComments(real).match(/assertSingleBranch\(/g) ?? []).length).toBe(5);
    expect((mutated.match(/assertSingleBranch\(/g) ?? []).length).toBeLessThan(5);
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
    // Both QuickBooks branches stay explicit, so their wording cannot move.
    expect(service).toContain("=== 'CREDIT_MEMO'");
    expect(service).toContain("=== 'REFUND_RECEIPT'");
    // Slice 6B: the fallback is the shared local resolver rather than an inline
    // ternary, so the label and the API's `documentKind` cannot drift apart.
    expect(service).toContain('customerReturnDocumentLabel(');
    expect(service).toContain('resolveCustomerReturnDocumentKind(');
  });

  it('the local return-document resolver reads no external accounting metadata', () => {
    const module = readFileSync(
      resolve(API_SRC, 'modules/returns/customer-return-document.ts'),
      'utf8',
    );
    // Just the resolver body: `customerReturnDocumentKindOf` further down names
    // CREDIT_MEMO on purpose — it exists to state QuickBooks' rule for comparison.
    const code = codeOnly(module);
    const start = code.indexOf('export function resolveCustomerReturnDocumentKind');
    const decision = code.slice(start, code.indexOf('export function', start + 1));
    expect(decision).toContain('CustomerReturnDocumentKind.CREDIT_NOTE');
    // The decision reads a refund method and a payment status. It must not consult
    // the QuickBooks document type, or it would be the old rule wearing a new name.
    expect(decision).not.toContain('quickbooksDocumentType');
    expect(decision).not.toContain('CREDIT_MEMO');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 30 — no Prisma migration generated
// ─────────────────────────────────────────────────────────────────────────────

describe('no Prisma migration was generated by Slices 5 through 6C-A', () => {
  const MIGRATIONS_DIR = resolve(API_SRC, '../../../packages/database/prisma/migrations');

  function migrationDirs(): string[] {
    return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  it('the migration set is exactly the 20 that existed after Slice 4', () => {
    // EXACT SET, not a count: a count cannot tell "the same 20" from "one added and
    // one deleted", and the whole claim is that nothing was added.
    expect(migrationDirs()).toEqual([
      '20260709104420_init',
      '20260709121301_add_auth_fields',
      '20260709131923_add_printjob_and_warehouse_pickup',
      '20260709145818_add_qr_payment_method',
      '20260710160825_add_order_discount_to_sale',
      '20260710170714_add_product_management_fields',
      '20260710180019_add_customer_management_fields',
      '20260714090621_add_returns_and_refunds',
      '20260714104606_add_quotations_and_subcategories',
      '20260714231302_add_refresh_tokens',
      '20260715094152_add_tenant_settings',
      '20260716181014_add_product_batch_grouping',
      '20260716233022_add_variation_config',
      '20260717201840_add_product_is_draft',
      '20260717235634_mirror_qb_product_fields',
      '20260718043727_restore_product_image_url',
      '20260722002628_add_document_sequence',
      '20260724150128_add_suppliers',
      '20260724164658_reshape_customer_to_qb_fields',
      '20260804121830_add_tenant_platform_profile',
    ]);
  });

  it('no migration creates a provider, inventory or restaurant table', () => {
    const dirs = migrationDirs();
    const scanned: string[] = [];
    const createdTables = new Set<string>();

    for (const dir of dirs) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
      scanned.push(dir);
      for (const match of sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)) {
        createdTables.add(match[1]);
      }
      for (const forbidden of [
        'BranchInventory',
        'InventoryBalance',
        'InventoryMovement',
        'StockMovement',
        'RestaurantOrder',
        'OrderRound',
        'DiningTable',
        'DiningArea',
        'RestaurantTable',
        'MenuItem',
        'KitchenTicket',
      ]) {
        expect(sql).not.toContain(forbidden);
      }
    }

    // POSITIVE CONTROL. Without these the loop would also pass having scanned
    // nothing, or having scanned files whose CREATE TABLE statements it cannot
    // parse — in which case the negatives above prove nothing at all.
    expect(scanned).toEqual(dirs);
    expect(scanned.length).toBe(20);
    expect(createdTables.has('Sale')).toBe(true);
    expect(createdTables.has('Product')).toBe(true);
    expect(createdTables.has('TenantBusinessProfile')).toBe(true);
    expect(createdTables.size).toBeGreaterThan(20);
  });
});
