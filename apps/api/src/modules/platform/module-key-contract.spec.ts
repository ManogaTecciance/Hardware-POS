/**
 * Drift guard between the persisted `ModuleKey` enum and the front-end's copy.
 *
 * `apps/web/src/lib/platform-api.ts` declares `ModuleKey` as a string-literal
 * union rather than importing it, because `@hardware-pos/database` pulls in the
 * Prisma client and must never reach the browser bundle. That duplication is
 * deliberate — and duplication without a check is drift waiting to happen.
 *
 * Reading the file as text is crude but exact: it fails the moment a module key is
 * added to the schema and not to the client (Slice 8's navigation would silently
 * never render it) or removed from the schema and left in the client (the UI would
 * offer a module the API rejects).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
} from '@hardware-pos/database';

const CLIENT_FILE = resolve(__dirname, '../../../../web/src/lib/platform-api.ts');

/** Pull the string literals out of `export type ModuleKey = 'A' | 'B' | …;`. */
function parseClientUnion(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source);
  if (!match) throw new Error(`Could not find "export type ${typeName}" in ${CLIENT_FILE}`);
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe('ModuleKey contract between the API and the web client', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8');

  it('the web client lists exactly the persisted module keys', () => {
    expect(parseClientUnion(source, 'ModuleKey').sort()).toEqual(Object.values(ModuleKey).sort());
  });

  it('the web client does not offer PAYMENTS as a module', () => {
    expect(parseClientUnion(source, 'ModuleKey')).not.toContain('PAYMENTS');
  });

  it.each([
    ['BusinessType', BusinessType],
    ['InventoryMode', InventoryMode],
    ['AccountingProviderKind', AccountingProviderKind],
  ])('the web client mirrors %s', (typeName, enumObject) => {
    expect(parseClientUnion(source, typeName as string).sort()).toEqual(
      Object.values(enumObject as Record<string, string>).sort(),
    );
  });
});
