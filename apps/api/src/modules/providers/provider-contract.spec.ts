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

describe('Slice 6C-B adopted the sale, return and product paths, and only those', () => {
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
  const ADOPTED_PATHS = [
    'modules/sales',
    'modules/returns',
    'modules/products',
    'modules/inventory-receipts',
  ];

  /**
   * Files that must stay clear of the provider layer. Each carries the legacy call
   * site that proves it is still on the old path — a negative alone would also pass
   * for a file that had been deleted, emptied, or renamed.
   */
  const NOT_YET_ADOPTED: { file: string; legacyMarker: string }[] = [
    { file: 'modules/products/products-import.service.ts', legacyMarker: 'ProductsService' },
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

  it('products.service.ts resolves ONLY the catalogue provider, and no profile conditional', () => {
    const service = readFileSync(resolve(API_SRC, 'modules/products/products.service.ts'), 'utf8');
    const code = stripComments(service);

    // POSITIVE — the catalogue provider is resolved.
    expect(referencesIdentifier(service, 'CatalogSyncProviderFactory')).toBe(true);
    expect(code).toContain('this.catalogProviders.forTenant(tenantId)');

    // NEGATIVE — no stock or accounting provider, and no direct queue use.
    expect(referencesIdentifier(service, 'InventoryProvider')).toBe(false);
    expect(referencesIdentifier(service, 'AccountingProvider')).toBe(false);
    expect(referencesIdentifier(service, 'SyncQueueService')).toBe(false);

    // NEGATIVE — the provider owns the routing, so no profile branch may appear.
    // This is the specific thing D28 forbids: trading one hard-coded QuickBooks
    // branch for several profile-condition branches.
    expect(referencesIdentifier(service, 'BusinessProfileService')).toBe(false);
    expect(code).not.toMatch(/inventoryMode\s*[=!]==/);
    expect(code).not.toMatch(/accountingProvider\s*[=!]==/);
    expect(code).not.toMatch(/businessType\s*[=!]==/);
    expect(code).not.toContain('InventoryMode.');
    expect(code).not.toContain('AccountingProviderKind.');
  });

  it('the catalogue provider owns the mirrored-field rule, ProductsService no longer does', () => {
    const service = stripComments(
      readFileSync(resolve(API_SRC, 'modules/products/products.service.ts'), 'utf8'),
    );
    const provider = stripComments(
      readFileSync(resolve(PROVIDERS_DIR, 'catalog/quickbooks-catalog-sync.provider.ts'), 'utf8'),
    );

    // Moved, not duplicated: exactly one of the two files decides this.
    expect(service).not.toContain('qboFieldsChanged');
    expect(service).not.toContain('purchaseDescription !==');
    expect(provider).toContain('mirroredFieldsChanged');
    expect(provider).toContain('before.purchaseDescription !== after.purchaseDescription');
  });

  it('no catalogue provider writes a Product row — local persistence stays in products', () => {
    const files = listSourceFiles(resolve(PROVIDERS_DIR, 'catalog'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const code = stripComments(readFileSync(resolve(PROVIDERS_DIR, 'catalog', file), 'utf8'));
      expect(code).not.toContain('product.update');
      expect(code).not.toContain('product.create');
      expect(code).not.toContain('ProductsRepository');
      expect(code).not.toContain('$transaction');
    }
  });

  it('NoCatalogSyncProvider has no mechanism to write anything', () => {
    const code = stripComments(
      readFileSync(resolve(PROVIDERS_DIR, 'catalog/no-catalog-sync.provider.ts'), 'utf8'),
    );
    // Structural, not behavioural: no constructor means no injected dependency, so
    // "creates no SyncJob" is not a behaviour that could regress.
    expect(code).not.toMatch(/constructor\s*\(/);
    expect(code).not.toContain('PrismaService');
    expect(code).not.toContain('SyncQueueService');
    expect(code).toContain('class NoCatalogSyncProvider');
  });

  it.each(['modules/sales/sales.service.ts', 'modules/returns/returns.service.ts'])(
    '%s resolves BOTH providers, each from its own factory',
    (file) => {
      const service = readFileSync(resolve(API_SRC, file), 'utf8');

      expect(referencesIdentifier(service, 'AccountingProviderFactory')).toBe(true);
      expect(referencesIdentifier(service, 'InventoryProviderFactory')).toBe(true);
      // And not the catalogue one — a sale does not change the catalogue.
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
      // D44 — Receive Stock holds InventoryProviderFactory to route the
      // per-cell BranchInventory + StockMovement writes through the provider
      // port. `ProductsService` still resolves ONLY CatalogSyncProviderFactory
      // (asserted separately above), so ProductsModule remains legal here
      // because the products/variants sub-controller consumes the port for
      // the opening-stock path only via the same factory.
      'modules/inventory-receipts/inventory-receipts.module.ts',
      'modules/products/products.module.ts',
      'modules/returns/returns.module.ts',
      'modules/sales/sales.module.ts',
    ]);
  });

  it('only the adopted modules import from the providers directory', () => {
    const offenders = collectFiles(API_SRC, {
      skipDirs: ['providers'],
      predicate: (content) => importsOf(content).some((spec) => spec.includes('providers/')),
    });

    expect(offenders).toEqual([
      // D44 — Receive Stock module (holds InventoryProviderFactory) + its
      // unit spec that imports the same types.
      'modules/inventory-receipts/inventory-receipts.module.ts',
      'modules/inventory-receipts/inventory-receipts.service.spec.ts',
      'modules/inventory-receipts/inventory-receipts.service.ts',
      'modules/products/products.module.ts',
      'modules/products/products.service.ts',
      // D44 — products/variants sub-module. `product-variants.service.ts`
      // holds InventoryProviderFactory for the opening-stock path; the
      // contract spec exercises those imports.
      'modules/products/variants/product-variants.contract.spec.ts',
      'modules/products/variants/product-variants.service.ts',
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

  /**
   * Inverted in Slice 6C-B. Until 6C-B this proved that *adding* a provider to
   * ProductsService would be caught; now that it is adopted, it proves *removing*
   * it would be — a reversion to the old direct-queue path.
   */
  it('reverting ProductsService to the direct queue path would be detected', () => {
    const real = sourceOf('modules/products/products.service.ts');
    expect(referencesIdentifier(real, 'CatalogSyncProviderFactory')).toBe(true);
    expect(referencesIdentifier(real, 'SyncQueueService')).toBe(false);

    const reverted = real
      .replace(/CatalogSyncProviderFactory/g, 'SyncQueueService')
      .replace(/catalogProviders/g, 'syncQueue');
    expect(reverted).not.toEqual(real);
    expect(referencesIdentifier(reverted, 'CatalogSyncProviderFactory')).toBe(false);
    expect(referencesIdentifier(reverted, 'SyncQueueService')).toBe(true);
  });

  it('a profile conditional creeping into ProductsService would be detected', () => {
    const real = stripComments(sourceOf('modules/products/products.service.ts'));
    expect(real).not.toMatch(/inventoryMode\s*[=!]==/);

    const mutated = real.replace(
      'const catalog = await this.catalogProviders.forTenant(tenantId);',
      "const profile = await this.profiles.getEffectiveProfile(tenantId);\n    if (profile.inventoryMode === 'QUICKBOOKS') { /* … */ }",
    );
    expect(mutated).not.toEqual(real);
    expect(mutated).toMatch(/inventoryMode\s*===/);
  });

  it('a provider import hidden in a comment would NOT be detected — and must not be', () => {
    const real = sourceOf('modules/quotations/quotations.service.ts');
    expect(referencesIdentifier(real, 'CatalogSyncProvider')).toBe(false);
    const commented = `// import { CatalogSyncProviderFactory } from '../providers/catalog/x';\n${real}`;
    expect(referencesIdentifier(commented, 'CatalogSyncProvider')).toBe(false);
    expect(importsOf(commented).filter((s) => s.includes('providers/'))).toEqual([]);
  });

  it('a new catalogue write path in a provider would be detected', () => {
    const real = readFileSync(
      resolve(PROVIDERS_DIR, 'catalog/quickbooks-catalog-sync.provider.ts'),
      'utf8',
    );
    expect(stripComments(real)).not.toContain('product.update');
    const mutated = real.replace(
      'private async enqueue(',
      'async bad() { await this.prisma.product.update({}); }\n  private async enqueue(',
    );
    expect(mutated).not.toEqual(real);
    expect(stripComments(mutated)).toContain('product.update');
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
    const withNewImporter = [...importers, 'modules/quotations/quotations.module.ts'].sort();
    // The assertion the tripwire makes, applied to the mutated set, must fail.
    expect(withNewImporter).not.toEqual(importers);
    expect(() =>
      expect(withNewImporter).toEqual([
        'modules/products/products.module.ts',
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

/**
 * The claim here is about *which* migrations exist, not that none may ever be
 * added. Slices 5 through 6C-A added none, and that is still asserted below by
 * pinning the exact set.
 *
 * Later phases have added migrations, all additive: Phase 1.5.4 (role key),
 * Phase 1.5.5 (role lifecycle), Phase 1.5.6 (branch access) and Restaurant
 * Phase 2A (restaurant config + kitchen stations). Each is listed explicitly
 * so a new migration fails this spec until someone adds its name here, which
 * is the moment they have to say why it exists.
 *
 * The additive-only loop covers the two ALTER-TABLE role migrations. The
 * others create new tables on purpose (BranchAccess, RestaurantBranchConfig,
 * KitchenStation, KitchenStationPrinter) and are asserted separately below.
 * The Restaurant Phase 2A migration MUST NOT create any of the restaurant
 * *operational* tables (RestaurantOrder, OrderRound, DiningArea, etc.) —
 * those are Phase 2B, 2C, 2D on their own migrations (decision AD-12).
 */
describe('no Prisma migration was generated by Slices 5 through 6C-A', () => {
  const MIGRATIONS_DIR = resolve(API_SRC, '../../../packages/database/prisma/migrations');

  const PHASE_1_5_ROLE_MIGRATIONS = [
    '20260806140000_add_role_key',
    '20260806160000_add_role_lifecycle',
  ] as const;

  function migrationDirs(): string[] {
    return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  it('the migration set is exactly the 20 from Slice 4 plus the thirteen post-Slice-4 additions', () => {
    // EXACT SET, not a count: a count cannot tell "the same 20" from "one added and
    // one deleted".
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
      // Phase 1.5, D40 — adds `Role.key` and its unique index. Additive, no data
      // migration (the table holds no rows in any environment).
      '20260806140000_add_role_key',
      // Phase 1.5.5 — adds `Role.isActive` (archival) and `Role.version`
      // (optimistic concurrency). Additive, defaults for both existing/new rows.
      '20260806160000_add_role_lifecycle',
      // Phase 1.5.6 — introduces `BranchAccess` for multi-branch users. Purely
      // additive: no existing table is altered, `User.branchId` remains the
      // default active branch for backwards compat (decision AD-02).
      '20260806180000_add_branch_access',
      // Restaurant Phase 2A — introduces RestaurantBranchConfig,
      // KitchenStation and KitchenStationPrinter. Purely additive; hardware
      // tenants have zero rows in any of them.
      '20260806200000_add_restaurant_config',
      // Restaurant Phase 2B — the menu, sections, items, modifiers plus the
      // menu-item ↔ kitchen-station routing join. Purely additive.
      '20260806220000_add_menu',
      // Restaurant Phase 2C — dining areas and the physical restaurant table
      // model, with a status enum. Purely additive.
      '20260806240000_add_dining_areas',
      // Restaurant Phase 2D — the operational core: TableSession,
      // RestaurantOrder, OrderRound, RestaurantOrderItem, its modifier
      // snapshot, plus the append-only status-history table. Additive; the
      // Sale junction is a nullable @unique FK.
      '20260806260000_add_table_sessions',
      // Phase 2.5 — branch-scoped inventory (D10, AD-16). Adds
      // BranchInventory and StockMovement; Product.quantityOnHand is
      // retained permanently as a rollup + QuickBooks cache.
      '20260806280000_add_branch_inventory',
      // Phase 6 — KOTs and printers (D6, scenario 20). KitchenPrinter,
      // KitchenTicket, KitchenTicketItem, KitchenPrintAttempt.
      '20260806300000_add_kitchen_printing',
      // Phase 7 — Takeaway. TakeawayOrderProfile row per takeaway
      // RestaurantOrder; the order model itself is unchanged.
      '20260806320000_add_takeaway',
      // Phase 8 — Billing. Adds serviceChargeAmount, packagingCharge,
      // billingVersion, closeIdempotencyKey to Sale; introduces BillSplit.
      '20260806340000_add_billing',
      // Phase 10 — Online order integration hub (infrastructure only).
      // DeliveryPlatform, ExternalOrder, ExternalOrderEvent,
      // WebhookDeliveryLog. Only the MOCK adapter registers today.
      '20260806360000_add_delivery_hub',
      // Restaurant Pilot Change 1 — additive creator ownership on
      // DiningArea and RestaurantTable, plus a one-shot backfill that
      // attributes existing rows to the tenant's first active OWNER.
      // Nothing dropped, no column altered.
      '20260807000000_add_dining_creator_ownership',
      // Restaurant Menu wizard (D41) — additive presentation fields on
      // MenuItem (imageUrl / itemType / dietaryTags / prepMinutes) and a
      // role marker on ModifierGroup. Every new column is nullable or
      // defaulted so legacy rows remain valid; no data backfill required.
      '20260811000000_add_menu_item_presentation_fields',
      // D44 — Product variants + Purchase Receipts + Weighted-Average
      // costing. Adds ProductVariant + variation dimension/option/junction
      // tables, InventoryReceipt + InventoryReceiptLine, a nullable
      // productVariantId + averageCost/unitCost columns across SaleItem /
      // ReturnItem / MenuItem / BranchInventory / StockMovement, and a
      // RECEIPT value on StockMovementReason. The only non-additive change
      // is a swap of the BranchInventory (branchId, productId) unique for
      // two partial unique indexes — data-safe because BranchInventory
      // holds zero rows in every environment (Phase 2.5 shipped the table
      // but no code wrote to it until this slice).
      '20260812000000_add_product_variants_and_purchase_receipts',
      // D45 — Restaurant Product wizard + Promotions. Merges Restaurant
      // Menu Item authority into the Product wizard. Additive:
      // • Product columns prepMinutes / dietaryTags / foodType.
      // • ProductVariant.isDefault + partial unique index.
      // • ProductModifierGroup, ProductStationLink junctions (peers of
      //   the existing MenuItem junctions — nothing dropped).
      // • Promotion + PromotionItem + PromotionType + PromotionItemRole.
      //   Discount stays untouched.
      '20260813000000_add_restaurant_product_wizard_promotions',
      // D46 — POS Product Variations in the Customise dialog. Unblocks
      // the last piece D45 deferred: sending Product-sourced round items
      // to the kitchen. Additive:
      // • RestaurantOrderItemSourceKind enum (MENU_ITEM | PRODUCT).
      // • RestaurantOrderItem gains sourceKind (default MENU_ITEM so
      //   every historical row keeps semantics) + productId? +
      //   productVariantId? + immutable variant snapshots.
      // • KitchenTicketItem.variantName? for the printed KOT.
      // Nothing dropped, no ALTER COLUMN SET NOT NULL, no rename.
      '20260814000000_add_pos_variation_snapshots',
      // D47 — table reservations by timeslot. Purely additive: the
      // ReservationStatus enum + the TableReservation table, indexes and
      // FKs (tenant/branch/table CASCADE like TableSession; customer and
      // creator SET NULL so booking history survives either deletion).
      '20260815000000_add_table_reservations',
      // D49 — open tables (ad-hoc joined tables). Additive except two
      // deliberate widenings named in the decision record: RestaurantTable
      // areaId + capacity DROP NOT NULL (null only ever written for
      // kind=OPEN rows). RESERVED status value, RestaurantTableKind enum,
      // OpenTableMember join table.
      '20260816000000_add_open_tables',
      // D50 — one physical table may back several open tables. Drops the
      // one-membership-per-table unique (a widening: the index only ever
      // refused rows), keeps the (openTableId, memberTableId) pair unique.
      '20260817000000_share_open_table_members',
      // D51 — item-level bill splitting. Purely additive: BillSplitItem, one
      // row per (split, order line) with the portion that split covers.
      '20260818000000_add_bill_split_items',
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
      // Restaurant Phase 2A-2D + 2.5 + Phase 6 have introduced every
      // restaurant/kitchen table the plan calls for. The remaining forbidden
      // entries are alternative names for models we DO have (guard against
      // a rename being accidentally re-introduced under the wrong name).
      for (const forbidden of [
        'InventoryBalance',
        'InventoryMovement',
        'DiningTable',
      ]) {
        expect(sql).not.toContain(forbidden);
      }
    }

    // POSITIVE CONTROL. Without these the loop would also pass having scanned
    // nothing, or having scanned files whose CREATE TABLE statements it cannot
    // parse — in which case the negatives above prove nothing at all.
    expect(scanned).toEqual(dirs);
    expect(scanned.length).toBe(41);
    expect(createdTables.has('Sale')).toBe(true);
    expect(createdTables.has('Product')).toBe(true);
    expect(createdTables.has('TenantBusinessProfile')).toBe(true);
    // `BranchAccess` is a Phase 1.5.6 table but explicitly not in the forbidden
    // list — it is administration, not stock or restaurant domain.
    expect(createdTables.has('BranchAccess')).toBe(true);
    // `RestaurantBranchConfig`, `KitchenStation`, `KitchenStationPrinter` are
    // Phase 2A tables. They are restaurant *configuration*, not operational
    // order state — the forbidden list covers the operational tables the
    // later sub-slices (2C/2D) will introduce.
    expect(createdTables.has('RestaurantBranchConfig')).toBe(true);
    expect(createdTables.has('KitchenStation')).toBe(true);
    expect(createdTables.has('KitchenStationPrinter')).toBe(true);
    // Phase 2B — Menu is configuration too.
    expect(createdTables.has('Menu')).toBe(true);
    expect(createdTables.has('MenuSection')).toBe(true);
    // Phase 2C — dining areas + tables. `DiningArea` and `RestaurantTable`
    // land here on purpose; no other migration may create them.
    expect(createdTables.has('DiningArea')).toBe(true);
    expect(createdTables.has('RestaurantTable')).toBe(true);
    // Phase 2D — operational core.
    expect(createdTables.has('TableSession')).toBe(true);
    expect(createdTables.has('RestaurantOrder')).toBe(true);
    expect(createdTables.has('OrderRound')).toBe(true);
    expect(createdTables.has('RestaurantOrderItem')).toBe(true);
    // Phase 2.5 — branch inventory + movement ledger.
    expect(createdTables.has('BranchInventory')).toBe(true);
    expect(createdTables.has('StockMovement')).toBe(true);
    // Phase 6 — KOTs + printers + attempt ledger.
    expect(createdTables.has('KitchenPrinter')).toBe(true);
    expect(createdTables.has('KitchenTicket')).toBe(true);
    expect(createdTables.has('KitchenTicketItem')).toBe(true);
    expect(createdTables.has('KitchenPrintAttempt')).toBe(true);
    // Phase 7 — takeaway profile.
    expect(createdTables.has('TakeawayOrderProfile')).toBe(true);
    // Phase 8 — billing splits.
    expect(createdTables.has('BillSplit')).toBe(true);
    // Phase 10 — delivery hub tables.
    expect(createdTables.has('DeliveryPlatform')).toBe(true);
    expect(createdTables.has('ExternalOrder')).toBe(true);
    expect(createdTables.has('WebhookDeliveryLog')).toBe(true);
    // D44 — product variants + purchase receipts.
    expect(createdTables.has('ProductVariant')).toBe(true);
    expect(createdTables.has('ProductVariationDimension')).toBe(true);
    expect(createdTables.has('ProductVariationOption')).toBe(true);
    expect(createdTables.has('ProductVariantOptionValue')).toBe(true);
    expect(createdTables.has('InventoryReceipt')).toBe(true);
    expect(createdTables.has('InventoryReceiptLine')).toBe(true);
    // D45 — Restaurant Product wizard + Promotions.
    expect(createdTables.has('Promotion')).toBe(true);
    expect(createdTables.has('PromotionItem')).toBe(true);
    expect(createdTables.has('ProductModifierGroup')).toBe(true);
    expect(createdTables.has('ProductStationLink')).toBe(true);
    expect(createdTables.size).toBeGreaterThan(20);
  });

  it.each(PHASE_1_5_ROLE_MIGRATIONS)(
    'the Phase 1.5 role migration %s creates no table and drops nothing',
    (name) => {
      // Additive means additive. `Role`, `Permission` and `_RolePermissions` already
      // existed; each of these Phase 1.5 migrations only adds columns and indexes to
      // `Role`. The Phase 1.5.6 branch-access migration creates a new table on
      // purpose (see the assertion below) and is out of this loop.
      const sql = readFileSync(resolve(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

      expect(sql).toContain('ALTER TABLE "Role" ADD COLUMN');
      expect(sql).not.toMatch(/CREATE TABLE/);
      expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN .* SET NOT NULL/);
    },
  );

  it('the Phase 1.5.6 branch-access migration creates one table and alters no existing one', () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_DIR, '20260806180000_add_branch_access', 'migration.sql'),
      'utf8',
    );

    // Positively: it creates exactly `BranchAccess` and adds its foreign keys.
    const creates = [...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(creates).toEqual(['BranchAccess']);
    expect(sql).toContain('"BranchAccess_userId_branchId_key"');
    expect(sql).toContain('"BranchAccess_userId_fkey"');
    expect(sql).toContain('"BranchAccess_branchId_fkey"');

    // Negatively: nothing existing is altered or dropped.
    expect(sql).not.toMatch(/ALTER TABLE "User"/);
    expect(sql).not.toMatch(/ALTER TABLE "Branch"/);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN .* SET NOT NULL/);
  });

  it('the D44 product-variants + purchase-receipts migration is additive except for the empty BranchInventory unique swap', () => {
    const sql = readFileSync(
      resolve(
        MIGRATIONS_DIR,
        '20260812000000_add_product_variants_and_purchase_receipts',
        'migration.sql',
      ),
      'utf8',
    );

    // Positively: it creates exactly the six D44 tables — and no more.
    const creates = [...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(creates).toEqual(
      [
        'ProductVariationDimension',
        'ProductVariationOption',
        'ProductVariant',
        'ProductVariantOptionValue',
        'InventoryReceipt',
        'InventoryReceiptLine',
      ].sort(),
    );

    // Positively: RECEIPT is added to the movement-reason enum, and the two
    // partial unique indexes replace the empty BranchInventory unique.
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'RECEIPT'");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "BranchInventory_branchId_productId_legacy_key"[\s\S]*WHERE "productVariantId" IS NULL/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "BranchInventory_branchId_productVariantId_key"[\s\S]*WHERE "productVariantId" IS NOT NULL/,
    );

    // Positively: each additive column lands as NULLABLE or DEFAULTED so
    // pre-migration rows remain valid. `hasVariants` and `dietaryTags`-style
    // NOT-NULL DEFAULT columns are the only NOT NULL adds allowed.
    expect(sql).toMatch(
      /ALTER TABLE "Product"[\s\S]*ADD COLUMN "hasVariants" BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(sql).toContain('ADD COLUMN "averageCost" DECIMAL(12,4)');
    expect(sql).toMatch(/ALTER TABLE "SaleItem"[\s\S]*ADD COLUMN "productVariantId" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "ReturnItem"[\s\S]*ADD COLUMN "productVariantId" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "MenuItem"[\s\S]*ADD COLUMN "productVariantId" TEXT/);
    expect(sql).toMatch(
      /ALTER TABLE "BranchInventory"[\s\S]*ADD COLUMN "productVariantId" TEXT/,
    );
    expect(sql).toMatch(/ALTER TABLE "StockMovement"[\s\S]*ADD COLUMN "productVariantId" TEXT/);

    // Negatively: exactly one DROP is permitted (the empty BranchInventory
    // unique swap explained in the migration header) and NOTHING else.
    const drops = [...sql.matchAll(/^DROP\s+[A-Z]+.*$/gm)].map((m) => m[0].trim());
    expect(drops).toEqual(['DROP INDEX "BranchInventory_branchId_productId_key";']);

    // Negatively: no ALTER COLUMN … SET NOT NULL on an existing column, no
    // rename, no data-loss ALTER, and no reference to the forbidden names.
    expect(sql).not.toMatch(/ALTER COLUMN .* SET NOT NULL/);
    expect(sql).not.toMatch(/RENAME TO|RENAME COLUMN/);
    expect(sql).not.toContain('InventoryBalance');
    expect(sql).not.toContain('InventoryMovement');
    expect(sql).not.toContain('DiningTable');

    // Positively: every additive integrity constraint is present — asserts
    // the migration reached the FK section instead of being truncated.
    expect(sql).toContain('"ProductVariant_tenantId_sku_key"');
    expect(sql).toContain('"ProductVariant_productId_fkey"');
    expect(sql).toContain('"InventoryReceipt_tenantId_receiptNumber_key"');
    expect(sql).toContain('"InventoryReceiptLine_receiptId_fkey"');
  });

  it('the D45 Restaurant Product wizard + Promotions migration is purely additive', () => {
    const sql = readFileSync(
      resolve(
        MIGRATIONS_DIR,
        '20260813000000_add_restaurant_product_wizard_promotions',
        'migration.sql',
      ),
      'utf8',
    );

    // Positively: creates exactly the four D45 tables — and no more.
    const creates = [...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(creates).toEqual(
      ['Promotion', 'PromotionItem', 'ProductModifierGroup', 'ProductStationLink'].sort(),
    );

    // Positively: PromotionType + PromotionItemRole enums land, and the
    // partial "one default variant per product" unique index is present.
    expect(sql).toContain(`CREATE TYPE "PromotionType"`);
    expect(sql).toContain(`CREATE TYPE "PromotionItemRole"`);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ProductVariant_productId_default_key"[\s\S]*WHERE "isDefault" = true/,
    );

    // Positively: additive columns on Product + ProductVariant.
    expect(sql).toMatch(/ALTER TABLE "Product"[\s\S]*ADD COLUMN "prepMinutes" INTEGER/);
    expect(sql).toContain(`ADD COLUMN "dietaryTags" TEXT[]`);
    expect(sql).toContain(`ADD COLUMN "foodType"    "MenuItemType"`);
    expect(sql).toMatch(
      /ALTER TABLE "ProductVariant"[\s\S]*ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false/,
    );

    // Negatively: NO drops, NO ALTER COLUMN SET NOT NULL, NO rename. The
    // migration is strictly additive because MenuItem rows must remain
    // readable per the "Read-only deprecate" Product Owner decision.
    // (These checks are against SQL statements — the file's header
    // comment names the MenuItem junctions as peers, which is fine.)
    expect(sql).not.toMatch(/^DROP\s+/m);
    expect(sql).not.toMatch(/ALTER COLUMN .* SET NOT NULL/);
    expect(sql).not.toMatch(/RENAME TO|RENAME COLUMN/);
    // No ALTER/DROP against the existing MenuItem junctions.
    expect(sql).not.toMatch(/(ALTER|DROP)\s+TABLE\s+"MenuItemModifierGroup"/);
    expect(sql).not.toMatch(/(ALTER|DROP)\s+TABLE\s+"MenuItemStationLink"/);
    expect(sql).not.toMatch(/(ALTER|DROP)\s+TABLE\s+"MenuItem"/);
    // The existing operator-applied `Discount` model must stay untouched
    // — Promotion is its peer, not its replacement.
    expect(sql).not.toMatch(/(ALTER|DROP)\s+TABLE\s+"Discount"/);

    // Positively: every additive integrity constraint is present.
    expect(sql).toContain('"ProductModifierGroup_productId_modifierGroupId_key"');
    expect(sql).toContain('"ProductStationLink_productId_stationId_key"');
    expect(sql).toContain('"Promotion_tenantId_name_key"');
    expect(sql).toContain('"PromotionItem_promotionId_productId_role_key"');
    expect(sql).toContain('"PromotionItem_productId_fkey"');
    expect(sql).toContain('"Promotion_tenantId_fkey"');
  });

  it('the D46 POS variation-snapshots migration is purely additive on RestaurantOrderItem + KitchenTicketItem', () => {
    const sql = readFileSync(
      resolve(
        MIGRATIONS_DIR,
        '20260814000000_add_pos_variation_snapshots',
        'migration.sql',
      ),
      'utf8',
    );

    // Positively: creates NO new tables (this migration is columns only).
    const creates = [...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(creates).toEqual([]);

    // Positively: the source-discriminator enum lands.
    expect(sql).toContain(`CREATE TYPE "RestaurantOrderItemSourceKind"`);
    expect(sql).toContain(`'MENU_ITEM'`);
    expect(sql).toContain(`'PRODUCT'`);

    // Positively: RestaurantOrderItem gains sourceKind + Product+Variant
    // + variant snapshots. `sourceKind` DEFAULT 'MENU_ITEM' is
    // load-bearing — it's what keeps every historical row valid.
    expect(sql).toMatch(
      /ALTER TABLE "RestaurantOrderItem"[\s\S]*ADD COLUMN "sourceKind" "RestaurantOrderItemSourceKind" NOT NULL DEFAULT 'MENU_ITEM'/,
    );
    expect(sql).toContain(`ADD COLUMN "productId" TEXT,`);
    expect(sql).toContain(`ADD COLUMN "productVariantId" TEXT,`);
    expect(sql).toContain(`ADD COLUMN "variantNameSnapshot" TEXT,`);
    expect(sql).toContain(`ADD COLUMN "variantPriceSnapshot" DECIMAL(12,2)`);

    // Positively: KitchenTicketItem gains variantName? for the printed
    // KOT. Nullable so legacy tickets render unchanged.
    expect(sql).toMatch(
      /ALTER TABLE "KitchenTicketItem"[\s\S]*ADD COLUMN "variantName" TEXT/,
    );

    // Positively: the two Product+Variant FKs are ON DELETE SET NULL so a
    // Product deletion never cascades into historical orders.
    expect(sql).toMatch(
      /"RestaurantOrderItem_productId_fkey"[\s\S]*ON DELETE SET NULL/,
    );
    expect(sql).toMatch(
      /"RestaurantOrderItem_productVariantId_fkey"[\s\S]*ON DELETE SET NULL/,
    );

    // Negatively: NO drops, NO ALTER COLUMN SET NOT NULL on any existing
    // column, NO rename. Every historical RestaurantOrderItem /
    // KitchenTicketItem row stays valid — the snapshot columns are
    // additive so a reprint / receipt / bill query keeps working.
    expect(sql).not.toMatch(/^DROP\s+/m);
    expect(sql).not.toMatch(/ALTER COLUMN .* SET NOT NULL/);
    expect(sql).not.toMatch(/RENAME TO|RENAME COLUMN/);
    // The existing `menuItemId` loose-string column stays exactly as it
    // is — no rename, no FK, no default change.
    expect(sql).not.toMatch(/ALTER TABLE "RestaurantOrderItem"[\s\S]*"menuItemId"/);
  });

  it('the D47 table-reservations migration is purely additive', () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_DIR, '20260815000000_add_table_reservations', 'migration.sql'),
      'utf8',
    );

    // Positively: exactly one new table, and it is the reservation book.
    const creates = [...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(creates).toEqual(['TableReservation']);

    // Positively: the lifecycle enum with the exact five states of D47.
    expect(sql).toContain(`CREATE TYPE "ReservationStatus"`);
    for (const status of ['BOOKED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']) {
      expect(sql).toContain(`'${status}'`);
    }

    // Positively: the timeslot pair and the contact snapshot columns exist,
    // customer link nullable (phone bookings must not force a Customer row).
    expect(sql).toContain(`"startAt" TIMESTAMP(3) NOT NULL`);
    expect(sql).toContain(`"endAt" TIMESTAMP(3) NOT NULL`);
    expect(sql).toContain(`"customerName" TEXT NOT NULL`);
    expect(sql).toMatch(/"customerId" TEXT,/);

    // Positively: deletion posture — tenant/branch/table cascade like
    // TableSession; customer and creator SET NULL so deleting either never
    // destroys booking history.
    expect(sql).toMatch(/"TableReservation_tenantId_fkey"[\s\S]*ON DELETE CASCADE/);
    expect(sql).toMatch(/"TableReservation_tableId_fkey"[\s\S]*ON DELETE CASCADE/);
    expect(sql).toMatch(/"TableReservation_customerId_fkey"[\s\S]*ON DELETE SET NULL/);
    expect(sql).toMatch(/"TableReservation_createdByUserId_fkey"[\s\S]*ON DELETE SET NULL/);

    // Negatively: touches nothing that exists. No drops, no column changes,
    // no renames — the only ALTER TABLE statements are the new table's own
    // constraint additions.
    expect(sql).not.toMatch(/^DROP\s+/m);
    expect(sql).not.toMatch(/ALTER COLUMN/);
    expect(sql).not.toMatch(/RENAME TO|RENAME COLUMN/);
    const altered = [...sql.matchAll(/ALTER TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(['TableReservation']));
  });

  it('the D49 open-tables migration is additive except the two named widenings', () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_DIR, '20260816000000_add_open_tables', 'migration.sql'),
      'utf8',
    );

    // Positively: the discriminator enum, the RESERVED status value, the
    // kind column with the compatibility default, and the join table.
    expect(sql).toContain(`CREATE TYPE "RestaurantTableKind" AS ENUM ('PHYSICAL', 'OPEN')`);
    expect(sql).toContain(`ALTER TYPE "RestaurantTableStatus" ADD VALUE 'RESERVED'`);
    expect(sql).toMatch(/ADD COLUMN\s+"kind" "RestaurantTableKind" NOT NULL DEFAULT 'PHYSICAL'/);
    const creates = [...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(creates).toEqual(['OpenTableMember']);

    // Positively: one live membership per physical table — the constraint
    // that makes "a table cannot be absorbed twice" structural, not code.
    expect(sql).toContain(`CREATE UNIQUE INDEX "OpenTableMember_memberTableId_key"`);

    // The two widenings are EXACTLY these — named in D49. Any third ALTER
    // COLUMN, or any SET NOT NULL, is a different migration than approved.
    const alterCols = [...sql.matchAll(/ALTER COLUMN "([A-Za-z_]+)" ([A-Z ]+?NULL)/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(alterCols.sort()).toEqual(['areaId:DROP NOT NULL', 'capacity:DROP NOT NULL']);
    expect(sql).not.toMatch(/SET NOT NULL/);
    expect(sql).not.toMatch(/^DROP\s+/m);
    expect(sql).not.toMatch(/RENAME TO|RENAME COLUMN/);
    const altered = new Set([...sql.matchAll(/ALTER TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]));
    expect(altered).toEqual(new Set(['RestaurantTable', 'OpenTableMember']));
  });

  it('the D50 sharing migration drops ONLY the one-membership unique', () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_DIR, '20260817000000_share_open_table_members', 'migration.sql'),
      'utf8',
    );

    // Positively: exactly one index dropped, and it is the per-table unique
    // that made sharing impossible.
    const dropped = [...sql.matchAll(/DROP INDEX "([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual(['OpenTableMember_memberTableId_key']);
    // …replaced by a plain index, so member lookups stay indexed.
    expect(sql).toContain(`CREATE INDEX "OpenTableMember_memberTableId_idx"`);

    // Nothing else moves: no table created or altered, no data touched.
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|UPDATE |DELETE |INSERT /);
  });

  it('the D51 split-items migration is purely additive', () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_DIR, '20260818000000_add_bill_split_items', 'migration.sql'),
      'utf8',
    );

    // Positively: exactly one new table, with the (split, line) unique that
    // makes re-assigning a line an edit rather than a duplicate row.
    expect([...sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((m) => m[1])).toEqual([
      'BillSplitItem',
    ]);
    expect(sql).toContain(`CREATE UNIQUE INDEX "BillSplitItem_billSplitId_orderItemId_key"`);
    // Quantity carries the same precision as the order line it slices, so a
    // fractional line can be split without silent truncation.
    expect(sql).toContain(`"quantity" DECIMAL(12,3) NOT NULL`);
    // Cascades: a split's rows die with the split, and with the order line.
    expect(sql).toMatch(/"BillSplitItem_billSplitId_fkey"[\s\S]*ON DELETE CASCADE/);
    expect(sql).toMatch(/"BillSplitItem_orderItemId_fkey"[\s\S]*ON DELETE CASCADE/);

    // Negatively: nothing existing is touched — a bill with no assignments
    // must behave exactly as it did before this migration.
    expect(sql).not.toMatch(/^DROP\s+/m);
    expect(sql).not.toMatch(/ALTER COLUMN|RENAME TO|RENAME COLUMN/);
    const altered = new Set([...sql.matchAll(/ALTER TABLE "([A-Za-z_]+)"/g)].map((m) => m[1]));
    expect(altered).toEqual(new Set(['BillSplitItem']));
  });

  /**
   * The pair unique is the ONLY thing still stopping the same table being added
   * twice to one open table, so it gets a positive assertion against the live
   * schema rather than an inference from the migration — plus the inline
   * mutation proof D30 requires for a load-bearing structural claim.
   */
  it('the (openTableId, memberTableId) pair unique survives D50 — mutation-proven', () => {
    const schema = readFileSync(
      resolve(MIGRATIONS_DIR, '..', 'schema.prisma'),
      'utf8',
    );
    const model = /model OpenTableMember \{([\s\S]*?)\n\}/.exec(schema);
    expect(model).not.toBeNull();
    const body = model![1]!;

    // POSITIVE: the pair unique is declared today…
    expect(body).toMatch(/@@unique\(\[openTableId, memberTableId\]\)/);
    // …and the per-table unique is gone (that is what D50 bought).
    expect(body).not.toMatch(/@@unique\(\[memberTableId\]\)/);
    expect(body).toMatch(/@@index\(\[memberTableId\]\)/);

    // MUTATION PROOF: dropping the pair unique must flip both predicates, so
    // the positive above cannot be passing for an unrelated reason.
    const mutated = body.replace('@@unique([openTableId, memberTableId])', '');
    expect(mutated).not.toEqual(body);
    expect(mutated).not.toMatch(/@@unique\(\[openTableId, memberTableId\]\)/);

    // And the reverse mutation — re-adding the per-table unique — is caught.
    const reverted = body.replace(
      '@@index([memberTableId])',
      '@@unique([memberTableId])',
    );
    expect(reverted).not.toEqual(body);
    expect(reverted).toMatch(/@@unique\(\[memberTableId\]\)/);
  });
});
