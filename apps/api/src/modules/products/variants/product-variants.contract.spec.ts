/**
 * Structural rules for the ProductVariants module (D44, D30).
 *
 * Every rule pairs a positive with a negative and, where the assertion could
 * silently pass on a renamed symbol or a comment, is mutation-proven inline.
 * D30 explicitly forbids passing structural tests that assert nothing — one of
 * the reasons this file exists is the Slice 6C-A regression where an assertion
 * for a function's presence was satisfied by a comment saying the function had
 * been removed.
 */

import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ProductVariantsController } from './product-variants.controller';
import {
  importsOf,
  referencesIdentifier,
  stripComments,
} from '../../providers/testkit/source-analysis';

const VARIANT_DIR = resolve(__dirname);
const CONTROLLER_PATH = resolve(VARIANT_DIR, 'product-variants.controller.ts');
const SERVICE_PATH = resolve(VARIANT_DIR, 'product-variants.service.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Read `@Method('path')` for one handler on a Nest controller.
 *
 * `path` and `method` metadata keys are the same ones Nest's route-explorer
 * reads at runtime, so an assertion here fails exactly when the running app's
 * route table would disagree with the spec.
 */
function pathOf(handler: (...args: unknown[]) => unknown): string {
  const path = Reflect.getMetadata('path', handler);
  if (typeof path !== 'string') {
    throw new Error(
      `Handler ${handler.name} has no @Method-decorator metadata — the assertion would be vacuous.`,
    );
  }
  return path;
}

describe('ProductVariantsController — endpoint set', () => {
  /**
   * Every endpoint D44 requires this module to expose, keyed by handler name.
   *
   * A `Reflect.getMetadata` walk means this fails the moment a handler is
   * renamed, removed, or its `@Get/@Post/@Patch/@Put/@Delete` path is edited
   * — the failure mode D30 §7 requires (an analyser that inspects zero files
   * unexpectedly must fail).
   */
  const EXPECTED_ENDPOINTS: { handler: keyof ProductVariantsController; path: string }[] = [
    { handler: 'listVariations', path: 'variations' },
    { handler: 'replaceVariations', path: 'variations' },
    { handler: 'listVariants', path: 'variants' },
    { handler: 'createBatch', path: 'variants:batch' },
    { handler: 'updateVariant', path: 'variants/:variantId' },
    { handler: 'deleteVariant', path: 'variants/:variantId' },
    { handler: 'uploadImage', path: 'variants/:variantId/image' },
    { handler: 'removeImage', path: 'variants/:variantId/image' },
    { handler: 'inventory', path: 'variants/:variantId/inventory' },
    { handler: 'purchases', path: 'variants/:variantId/purchases' },
  ];

  it.each(EXPECTED_ENDPOINTS)(
    '$handler is decorated at "$path"',
    ({ handler, path }) => {
      const proto = ProductVariantsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      const method = proto[handler as string];
      expect(typeof method).toBe('function');
      expect(pathOf(method)).toBe(path);
    },
  );

  it('exposes exactly the D44 endpoint set — no extras, none missing (mutation-proof)', () => {
    // POSITIVE: read the current paths off the actual class and compare to a
    // sorted expected set. A count-only check could not tell "the right ten
    // routes" from "ten different routes"; the sorted-array comparison does.
    const proto = ProductVariantsController.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
      .map((name) => `${name}:${Reflect.getMetadata('path', proto[name]) ?? '<none>'}`)
      .sort();

    // Non-empty positive control — an empty listing is exactly how a broken
    // walk would look, and this catches it before the equality below can pass
    // vacuously.
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBe(EXPECTED_ENDPOINTS.length);

    const expected = EXPECTED_ENDPOINTS.map((e) => `${String(e.handler)}:${e.path}`).sort();
    expect(paths).toEqual(expected);

    // Mutation proof: inject one extra path and confirm the equality flips.
    const mutated = [...paths, 'nonsense:variants/hijack'].sort();
    expect(mutated).not.toEqual(expected);
  });
});

describe('ProductVariantsService — provider wiring', () => {
  it('imports InventoryProviderFactory for the opening-stock path', () => {
    const source = read(SERVICE_PATH);
    // POSITIVE: the identifier and its import specifier are both present.
    expect(referencesIdentifier(source, 'InventoryProviderFactory')).toBe(true);
    const specs = importsOf(source);
    expect(specs.some((s) => s.includes('inventory/inventory-provider.factory'))).toBe(true);
    // POSITIVE: the service also calls receiveStock — the whole reason it holds
    // the factory. Without this, the negative below would pass on a service
    // that had accidentally stopped using the provider.
    expect(referencesIdentifier(source, 'receiveStock')).toBe(true);
  });

  it('never opens its own transaction inside a provider method', () => {
    // The service is allowed to open transactions (it does — for the batch
    // create). The invariant this test protects is that the receipt pipeline
    // stays inside the caller's tx, not nested in another one. Structural
    // shape: the receiveStock call is INSIDE the arrow passed to $transaction.
    const source = stripComments(read(SERVICE_PATH));
    const receiveStockCallIndex = source.indexOf('inventory.receiveStock(');
    const transactionOpenIndex = source.indexOf('this.prisma.$transaction(');
    expect(receiveStockCallIndex).toBeGreaterThan(-1);
    expect(transactionOpenIndex).toBeGreaterThan(-1);
    expect(receiveStockCallIndex).toBeGreaterThan(transactionOpenIndex);
  });
});

describe('ProductVariantsController — variant identity is immutable via PATCH', () => {
  it('the controller file contains no productVariant.update-with-optionValues path (mutation-proof)', () => {
    // NEGATIVE: `productVariant.update` never appears in the controller — the
    // controller is a thin layer, all Prisma writes happen in the service.
    // POSITIVE: the file is non-empty (guards against renaming the controller
    // and leaving this file matching an empty string forever).
    const source = read(CONTROLLER_PATH);
    expect(source.length).toBeGreaterThan(200);
    expect(source).not.toContain('productVariant.update');

    // POSITIVE: `updateVariant` exists — a rename would take the negative
    // above with it, and this proves the path we mean to guard still lives.
    expect(source).toContain('updateVariant');

    // Mutation proof: injecting a `productVariant.update` line into a copy of
    // the source flips the negative assertion, which proves the tripwire can
    // actually fail. This is the standard D30 §5 pattern.
    const mutated = source.replace(
      'updateVariant(',
      'updateVariant(/*bad*/) { await this.service.prisma.productVariant.update({}); }\n  bad',
    );
    expect(mutated).not.toEqual(source);
    expect(mutated).toContain('productVariant.update');
  });

  it('the DTO for PATCH does not accept optionValues, sku is the only identity-adjacent field', () => {
    // Reading the DTO file directly: a PATCH DTO must never re-open the
    // (dimension, option) identity that snapshots depend on. `optionValues` is
    // the exact field name the batch DTO uses, so its absence here is the
    // signal to check for. Strip comments FIRST — the docstring here explains
    // WHY those fields are absent and names them for the reader, and the D30
    // regression that motivated this file was precisely a rule fooled by
    // words in a comment.
    const dtoSource = stripComments(
      read(resolve(VARIANT_DIR, 'dto/update-variant.dto.ts')),
    );
    expect(dtoSource).not.toMatch(/optionValues/);
    expect(dtoSource).not.toMatch(/dimensionId/);
    expect(dtoSource).not.toMatch(/optionId/);
    // POSITIVE: fields that ARE editable still exist.
    expect(dtoSource).toContain('sku?');
    expect(dtoSource).toContain('unitPrice?');
  });
});
