/**
 * Fixture-divergence tests for the source-analysis primitives (Slice 6C-A.5,
 * approved pattern 3).
 *
 * Every architectural tripwire in this repository is built on these functions. If
 * one of them stopped discriminating — a regex that matches nothing, a comment
 * stripper that strips everything — dozens of `not.toContain` assertions would
 * pass forever having checked nothing, and nothing else in the suite would notice.
 *
 * So each primitive is exercised against **a pair** of synthetic sources: one
 * representing the unadopted state, one the adopted state. The test asserts they
 * produce *different* answers. A primitive that always says "no" fails here, which
 * is the whole point.
 */

import { resolve } from 'node:path';

import {
  collectFiles,
  importsOf,
  listSourceFiles,
  referencesExactly,
  referencesIdentifier,
  stripComments,
} from './source-analysis';

/** What `products.service.ts` looks like today: no provider anywhere. */
const UNADOPTED = `
import { Injectable } from '@nestjs/common';
import { SyncQueueService } from '../sync/queue/sync-queue.service';

@Injectable()
export class ProductsService {
  constructor(private readonly syncQueue: SyncQueueService) {}
  async create() {
    await this.syncQueue.enqueueProductSync('t', 'p');
  }
}
`;

/** The same file after a catalogue provider is wired in. */
const ADOPTED = `
import { Injectable } from '@nestjs/common';
import { CatalogSyncProviderFactory } from '../providers/catalog/catalog-sync-provider.factory';

@Injectable()
export class ProductsService {
  constructor(private readonly catalog: CatalogSyncProviderFactory) {}
  async create() {
    const provider = await this.catalog.forTenant('t');
    await provider.productCreated('p');
  }
}
`;

/**
 * The exact shape that defeated the old analyser: the forbidden thing survives
 * only inside a comment saying it was removed.
 */
const REMOVED_BUT_MENTIONED = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class SalesRepository {
  // \`decrementStock\` used to live here. Its conditional updateMany, guarded by
  // \`quantityOnHand: { gte: qty }\`, moved into LocalInventoryProvider.
  /* It aggregated repeated product ids and threw Insufficient stock. */
  async createCompleted() {
    return null;
  }
}
`;

describe('stripComments', () => {
  it('removes a line comment', () => {
    expect(stripComments('const a = 1; // decrementStock')).not.toContain('decrementStock');
  });

  it('removes a block comment', () => {
    expect(stripComments('/* decrementStock */ const a = 1;')).not.toContain('decrementStock');
  });

  it('keeps the code that surrounds them', () => {
    const code = stripComments('const a = 1; // note\n/* note */ const b = 2;');
    expect(code).toContain('const a = 1;');
    expect(code).toContain('const b = 2;');
  });

  it('does not eat a URL inside a string', () => {
    expect(stripComments("const u = 'https://example.com/x';")).toContain('example.com');
  });

  it('does not strip everything — the failure mode that would silently pass every negative test', () => {
    expect(stripComments(ADOPTED).trim().length).toBeGreaterThan(100);
  });
});

describe('referencesIdentifier discriminates adopted from unadopted', () => {
  it('says NO for the unadopted fixture and YES for the adopted one', () => {
    expect(referencesIdentifier(UNADOPTED, 'CatalogSyncProvider')).toBe(false);
    expect(referencesIdentifier(ADOPTED, 'CatalogSyncProvider')).toBe(true);
  });

  it('the legacy call site is present in one and gone in the other', () => {
    expect(referencesIdentifier(UNADOPTED, 'SyncQueueService')).toBe(true);
    expect(referencesIdentifier(ADOPTED, 'SyncQueueService')).toBe(false);
  });

  /**
   * The regression test for the `decrementStock` failure. A comment saying a thing
   * was removed must read as absent, and the old analyser read it as present.
   */
  it('a comment mentioning a removed symbol does NOT count as a reference', () => {
    expect(REMOVED_BUT_MENTIONED).toContain('decrementStock'); // raw text: present
    expect(referencesIdentifier(REMOVED_BUT_MENTIONED, 'decrementStock')).toBe(false);
    expect(referencesIdentifier(REMOVED_BUT_MENTIONED, 'quantityOnHand')).toBe(false);
    // …while the surviving code is still visible.
    expect(referencesIdentifier(REMOVED_BUT_MENTIONED, 'createCompleted')).toBe(true);
  });

  /**
   * Found by a mutation proof, not by review: `\b$transaction` can never match,
   * because there is no word boundary between `.` and `$`. Every negative
   * assertion using it would have passed forever.
   */
  it('matches identifiers that begin with a non-word character, such as $transaction', () => {
    expect(referencesIdentifier('await this.prisma.$transaction(fn);', '$transaction')).toBe(true);
    expect(referencesIdentifier('await tx.product.updateMany({});', '$transaction')).toBe(false);
    expect(referencesIdentifier('const x = this.prisma.$queryRawUnsafe(q);', '$queryRaw')).toBe(true);
  });

  it('matches on a word boundary, so a substring of another word is not a hit', () => {
    expect(referencesIdentifier('const myInventoryProvider = 1;', 'InventoryProvider')).toBe(false);
  });
});

describe('referencesExactly', () => {
  it('distinguishes a port from its factory, which referencesIdentifier deliberately does not', () => {
    const source = 'import { InventoryProviderFactory } from "x";';
    expect(referencesIdentifier(source, 'InventoryProvider')).toBe(true);
    expect(referencesExactly(source, 'InventoryProvider')).toBe(false);
    expect(referencesExactly(source, 'InventoryProviderFactory')).toBe(true);
  });
});

describe('importsOf', () => {
  it('finds real imports and differs between the two fixtures', () => {
    expect(importsOf(UNADOPTED)).toEqual(['@nestjs/common', '../sync/queue/sync-queue.service']);
    expect(importsOf(ADOPTED)).toEqual([
      '@nestjs/common',
      '../providers/catalog/catalog-sync-provider.factory',
    ]);
  });

  it('ignores an import written inside a comment', () => {
    const source = "// import { X } from 'providers/x';\nimport { Y } from 'real';";
    expect(importsOf(source)).toEqual(['real']);
  });

  it('returns an empty list only when there genuinely are none', () => {
    expect(importsOf('const a = 1;')).toEqual([]);
  });
});

describe('listSourceFiles refuses to be silently empty', () => {
  it('finds the inventory providers', () => {
    const files = listSourceFiles(resolve(__dirname, '../inventory'));
    expect(files).toContain('local-inventory.provider.ts');
    expect(files).toContain('no-inventory.provider.ts');
    expect(files).toContain('quickbooks-inventory.provider.ts');
  });

  it('excludes spec files', () => {
    expect(listSourceFiles(resolve(__dirname, '../inventory')).some((f) => f.endsWith('.spec.ts'))).toBe(
      false,
    );
  });

  it('throws on a wrong path instead of returning [] and passing every loop built on it', () => {
    expect(() => listSourceFiles(resolve(__dirname, '../does-not-exist'))).toThrow();
  });
});

describe('collectFiles refuses to be silently empty', () => {
  const API_SRC = resolve(__dirname, '../../..');

  it('returns paths, not counts, so callers can assert an exact set', () => {
    const matches = collectFiles(API_SRC, {
      accept: (name) => name === 'providers.module.ts',
      predicate: (content) => content.includes('ProvidersModule'),
    });
    expect(matches).toEqual(['modules/providers/providers.module.ts']);
  });

  it('throws when the walk visits nothing, rather than reporting an empty set', () => {
    expect(() =>
      collectFiles(API_SRC, {
        accept: (name) => name.endsWith('.this-extension-does-not-exist'),
        predicate: () => true,
      }),
    ).toThrow(/visited no candidate files/);
  });

  it('an empty RESULT is still possible and meaningful when the walk did run', () => {
    // Assembled at runtime so this spec does not match its own needle — which it
    // did on the first run, and which is itself a small lesson in how easily a
    // source-scanning assertion measures the wrong thing.
    const needle = ['ThisSymbol', 'DoesNotExist', 'Anywhere'].join('');
    const matches = collectFiles(API_SRC, {
      accept: (name) => name.endsWith('.ts'),
      predicate: (content) => content.includes(needle),
    });
    expect(matches).toEqual([]);
  });
});
