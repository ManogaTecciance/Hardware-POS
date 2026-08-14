import { BadRequestException } from '@nestjs/common';
import {
  coerceAttributeQueryValue,
  domainFor,
  validateAttributes,
  type AttributeField,
} from '@hardware-pos/shared';

import { BusinessProfileService } from '../platform/business-profile.service';
import { ProductAttributesService } from './product-attributes.service';

/**
 * D64 — the attribute validator IS the server's refusal logic, so this spec
 * holds it to the D30 analyser standard: valid input accepted (positively),
 * every rejection class proven (negatively), and the empty schema shown to
 * refuse rather than admit-by-vacuity.
 */

const SCHEMA: readonly AttributeField[] = [
  { key: 'bedCount', label: 'Beds', type: 'integer', min: 1, max: 12, required: true },
  { key: 'rating', label: 'Rating', type: 'number', min: 0, max: 5 },
  { key: 'viewType', label: 'View', type: 'enum', options: ['Sea', 'Garden'] },
  { key: 'smoking', label: 'Smoking', type: 'boolean' },
  { key: 'note', label: 'Note', type: 'text', maxLength: 10 },
];

describe('validateAttributes', () => {
  it('accepts a fully valid document — the positive control', () => {
    expect(
      validateAttributes(SCHEMA, {
        bedCount: 2,
        rating: 4.5,
        viewType: 'Sea',
        smoking: false,
        note: 'quiet',
      }),
    ).toEqual([]);
  });

  it('accepts optional keys omitted, but not a required one', () => {
    expect(validateAttributes(SCHEMA, { bedCount: 1 })).toEqual([]);
    const missing = validateAttributes(SCHEMA, { viewType: 'Sea' });
    expect(missing.map((i) => i.key)).toEqual(['bedCount']);
  });

  it('refuses every wrong-type value, naming its key', () => {
    const issues = validateAttributes(SCHEMA, {
      bedCount: 2.5, // not an integer
      rating: '4', // not a number
      viewType: 'Mountain', // not an option
      smoking: 'yes', // not a boolean
      note: 'far too long a note', // over maxLength
    });
    expect(issues.map((i) => i.key).sort()).toEqual([
      'bedCount',
      'note',
      'rating',
      'smoking',
      'viewType',
    ]);
  });

  it('enforces min/max bounds', () => {
    expect(validateAttributes(SCHEMA, { bedCount: 0 }).map((i) => i.key)).toEqual(['bedCount']);
    expect(validateAttributes(SCHEMA, { bedCount: 13 }).map((i) => i.key)).toEqual(['bedCount']);
  });

  it('refuses unknown keys — including against an EMPTY schema', () => {
    expect(validateAttributes(SCHEMA, { bedCount: 2, colour: 'red' }).map((i) => i.key)).toEqual([
      'colour',
    ]);
    // The empty schema is a closed door, not an open one: this is what makes
    // "hardware declares no attributes" mean something at the API boundary.
    expect(validateAttributes([], { anything: 1 }).map((i) => i.key)).toEqual(['anything']);
    expect(validateAttributes([], {})).toEqual([]);
  });

  it('refuses null values and non-object payloads', () => {
    expect(validateAttributes(SCHEMA, { bedCount: 2, smoking: null })).toHaveLength(1);
    for (const bad of [null, [], 'x', 7]) {
      expect(validateAttributes(SCHEMA, bad)).toEqual([
        { key: '', message: 'Attributes must be an object of key → value.' },
      ]);
    }
  });
});

describe('coerceAttributeQueryValue', () => {
  const integer = SCHEMA[0]!;
  const enumField = SCHEMA[2]!;
  const boolField = SCHEMA[3]!;

  it('coerces to the field type, and refuses what cannot be it', () => {
    expect(coerceAttributeQueryValue(integer, '3')).toEqual({ ok: true, value: 3 });
    expect(coerceAttributeQueryValue(integer, '3.5').ok).toBe(false);
    expect(coerceAttributeQueryValue(integer, 'many').ok).toBe(false);
    expect(coerceAttributeQueryValue(boolField, 'true')).toEqual({ ok: true, value: true });
    expect(coerceAttributeQueryValue(boolField, '1').ok).toBe(false);
    expect(coerceAttributeQueryValue(enumField, 'Sea')).toEqual({ ok: true, value: 'Sea' });
    expect(coerceAttributeQueryValue(enumField, 'Mountain').ok).toBe(false);
  });
});

describe('ProductAttributesService', () => {
  const serviceFor = (businessType: string) => {
    const profiles = {
      getEffectiveProfile: jest.fn().mockResolvedValue({ businessType }),
    } as unknown as BusinessProfileService;
    return new ProductAttributesService(profiles);
  };

  it('serves the tenant domain schema — HOTEL declares fields, HARDWARE declares none', async () => {
    // Pins the registry data the integration specs (and the wizard) rely on:
    // the feature has one live declaring domain and one live refusing domain.
    await expect(serviceFor('HOTEL').schemaForTenant('t1')).resolves.toEqual(
      domainFor('HOTEL').catalogue.attributeSchema,
    );
    expect(domainFor('HOTEL').catalogue.attributeSchema.length).toBeGreaterThan(0);
    await expect(serviceFor('HARDWARE').schemaForTenant('t1')).resolves.toEqual([]);
  });

  it('refuses an invalid document with the machine-readable code', async () => {
    const err = await serviceFor('HOTEL')
      .assertValidDocument('t1', { bedCount: 'two' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as {
      code: string;
      issues: { key: string }[];
    };
    expect(body.code).toBe('PRODUCT_ATTRIBUTES_INVALID');
    expect(body.issues.map((i) => i.key)).toEqual(['bedCount']);
    // Positive control on the same service instance: a valid document passes.
    await expect(
      serviceFor('HOTEL').assertValidDocument('t1', { bedCount: 2, viewType: 'Sea' }),
    ).resolves.toBeUndefined();
  });
});
