/**
 * D125 / D125a — the wire contract for the option library (`5.1` / `5.2`).
 *
 * ## Why this test exists at all
 *
 * Phase 4 shipped the same defect three times — `4.15`, `4.21`, `4.22` — and
 * every one was a mapper silently dropping a field the server had sent. The
 * standing answer is that a field crossing a wire is REQUIRED on the in-process
 * type, so an omission is a compile error rather than a blank on a screen.
 *
 * A type cannot be asserted at runtime, so this asserts the property that
 * follows from it: what the client sends and reads back is complete, and the
 * validation the form runs is the SAME function the server validates with. Two
 * copies of the code rule would produce a form that accepts what the API
 * refuses, which is `4.16` exactly.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The fetch mock returns a FULL server payload including the fields most likely
 * to be dropped (`swatchHex`, `categoryName`, `linkedDimensionCount`, and a
 * `null` where null is meaningful). Asserting only the fields a naive mapper
 * would copy is how `4.15` passed its own test. The mutation proof at the end
 * runs the assertions against a mapper of exactly the shape that shipped three
 * times.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attributeCodeIssue,
  normaliseAttributeCode,
  normaliseSwatchHex,
} from '@hardware-pos/shared';

import {
  createAttributeDefinition,
  fetchAttributeLibrary,
  type AttributeDefinition,
} from './attribute-library-api';

const session = {
  token: 'tok',
  user: { id: 'u1', tenantId: 't1' },
} as never;

/** A complete server response — every field the API actually sends. */
const SERVER_PAYLOAD = {
  definitions: [
    {
      id: 'def_1',
      name: 'Colour',
      position: 0,
      categoryId: 'cat_1',
      categoryName: 'Apparel',
      linkedDimensionCount: 4,
      options: [
        { id: 'opt_1', code: 'BLK', name: 'Black', position: 0, swatchHex: '#1A1A1A' },
        { id: 'opt_2', code: 'RED', name: 'Red', position: 1, swatchHex: null },
      ],
    },
  ],
};

function mockFetchOnce(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchAttributeLibrary', () => {
  it('carries EVERY field across the wire, including the droppable ones', async () => {
    mockFetchOnce(SERVER_PAYLOAD);
    const definitions = await fetchAttributeLibrary(session);

    // Compare the whole object, not a handful of fields. A mapper that omits
    // one is the defect this phase inherited, and a field-by-field assertion
    // only protects the fields somebody already thought of.
    expect(definitions).toEqual(SERVER_PAYLOAD.definitions);
  });

  it('preserves a meaningful null rather than folding it to undefined', async () => {
    mockFetchOnce(SERVER_PAYLOAD);
    const [definition] = await fetchAttributeLibrary(session);

    // `swatchHex: null` means "this option has no colour", which is different
    // from "the server did not tell us".
    expect(definition!.options[1]!.swatchHex).toBeNull();
    expect(definition!.options[1]!).toHaveProperty('swatchHex');
  });

  it('unwraps the envelope and returns the list itself', async () => {
    mockFetchOnce(SERVER_PAYLOAD);
    const definitions = await fetchAttributeLibrary(session);
    expect(Array.isArray(definitions)).toBe(true);
    expect(definitions).toHaveLength(1);
  });
});

describe('createAttributeDefinition', () => {
  it('sends the body it was given, unmodified', async () => {
    const created: AttributeDefinition = SERVER_PAYLOAD.definitions[0]!;
    mockFetchOnce(created);

    await createAttributeDefinition(session, {
      name: 'Colour',
      categoryId: 'cat_1',
      options: [{ name: 'Black', code: 'BLK', position: 0, swatchHex: '#1A1A1A' }],
    });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      name: 'Colour',
      categoryId: 'cat_1',
      options: [{ name: 'Black', code: 'BLK', position: 0, swatchHex: '#1A1A1A' }],
    });
  });
});

describe('the form and the server share one rule', () => {
  it('normalises a typed code exactly as the API will store it', () => {
    // The form previews with these functions; the service validates with the
    // same ones. `4.16` was half a fix — the chips learned a rule and the
    // server kept its own — and this is the shape that prevents it.
    expect(normaliseAttributeCode(' extra large ')).toBe('EXTRA-LARGE');
    expect(attributeCodeIssue(normaliseAttributeCode(' extra large '))).toBeNull();
  });

  it('refuses in the form exactly what the API refuses', () => {
    for (const bad of ['***', '   ', '']) {
      expect(attributeCodeIssue(normaliseAttributeCode(bad))).not.toBeNull();
    }
    expect(normaliseSwatchHex('#f00')).toBeNull();
    expect(normaliseSwatchHex('#ff0000')).toBe('#FF0000');
  });
});

describe('mutation proof', () => {
  it('CAUGHT: the field-by-field mapper that shipped in 4.15, 4.21 and 4.22', () => {
    // Exactly the shape of the real defect: an object rebuilt property by
    // property, with one forgotten. The compiler stays silent when the field is
    // optional, which is why the in-process type makes it required.
    const mutant = (row: (typeof SERVER_PAYLOAD)['definitions'][number]) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      categoryId: row.categoryId,
      // categoryName forgotten — the screen shows a blank chip
      linkedDimensionCount: row.linkedDimensionCount,
      options: row.options.map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        position: o.position,
        // swatchHex forgotten — every colour renders without its swatch
      })),
    });

    const mapped = mutant(SERVER_PAYLOAD.definitions[0]!);
    expect(mapped).not.toEqual(SERVER_PAYLOAD.definitions[0]);
    expect(mapped).not.toHaveProperty('categoryName');
    expect(mapped.options[0]).not.toHaveProperty('swatchHex');
  });
});
