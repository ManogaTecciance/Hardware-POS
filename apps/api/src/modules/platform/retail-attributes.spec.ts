import { domainFor, validateAttributes, coerceAttributeQueryValue } from '@hardware-pos/shared';

/**
 * D64 / D99 (2.4) — the clothing catalogue fields.
 *
 * The schema is data, but it is a COMMITMENT: `validateAttributes` refuses
 * unknown keys, so removing a field later strands whatever tenants have stored
 * under it on their next full write. An exact-set assertion (D30 prefers a set
 * to a count) makes any change to the list deliberate.
 *
 * The dimension/attribute split is the thing worth protecting. Size and colour
 * must never appear here: a Medium has its own price, barcode and stock row, so
 * it is a variation dimension. "Slim fit" changes nothing the engine touches.
 */
const schema = domainFor('RETAIL').catalogue.attributeSchema;

describe('the retail schema is exactly the declared clothing fields', () => {
  it('declares these five keys, in this order', () => {
    expect(schema.map((f) => f.key)).toEqual([
      'material',
      'fit',
      'careInstructions',
      'gender',
      'season',
    ]);
  });

  it('declares no field as required', () => {
    // `required: true` would block product creation for a tenant that does not
    // track the field — a shop with no fabric data could not add a product.
    expect(schema.filter((f) => f.required)).toEqual([]);
  });

  it('never declares size or colour — those are variation dimensions', () => {
    // The negative half, and the rule the whole of Phase 1 rests on. A size has
    // its own price, barcode and stock row; storing it as a descriptive string
    // would make it unsellable and unscannable.
    const keys = schema.map((f) => f.key.toLowerCase());

    for (const forbidden of ['size', 'colour', 'color', 'variant', 'sku', 'barcode']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('never declares brand — it becomes a column in Phase 8', () => {
    // Declaring it here would mean migrating stored strings into an entity later
    // (step 8.8). Asserted so the omission reads as a decision, not a gap.
    expect(schema.map((f) => f.key)).not.toContain('brand');
  });

  it('declares no grocery field while clothing and grocery share one business type', () => {
    // `schemaForTenant` resolves ONE schema per business type. Until the enum is
    // split (2.5, blocked), a grocery key here would appear in a clothing shop's
    // product wizard.
    const keys = schema.map((f) => f.key);

    expect(keys).not.toContain('allergens');
    expect(keys).not.toContain('countryOfOrigin');
  });
});

describe('the schema validates what it says it validates', () => {
  it('accepts a full, well-formed clothing document', () => {
    expect(
      validateAttributes(schema, {
        material: '60% cotton, 40% polyester',
        fit: 'Slim',
        careInstructions: 'Machine wash cold. Do not tumble dry.',
        gender: 'Women',
        season: 'Summer',
      }),
    ).toEqual([]);
  });

  it('accepts an empty document — every field is optional', () => {
    expect(validateAttributes(schema, {})).toEqual([]);
  });

  it('refuses an unknown key, which is the closed-door guarantee', () => {
    // The reason an empty schema is safe elsewhere: nothing is stored that was
    // not declared. A typo'd key is refused rather than silently persisted.
    const issues = validateAttributes(schema, { fabric: 'cotton' });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.key).toBe('fabric');
  });

  it('refuses an enum value outside its options', () => {
    const issues = validateAttributes(schema, { fit: 'Skinny' });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('Regular, Slim, Relaxed, Oversized');
  });

  it('refuses text past its maxLength', () => {
    expect(validateAttributes(schema, { material: 'x'.repeat(121) })).toHaveLength(1);
    // POSITIVE CONTROL: the boundary itself is accepted, so the check is not
    // simply refusing everything.
    expect(validateAttributes(schema, { material: 'x'.repeat(120) })).toEqual([]);
  });

  it('refuses null rather than treating it as "clear this field"', () => {
    // Replace semantics: omit the key to clear it. One way to say "absent".
    expect(validateAttributes(schema, { fit: null })).toHaveLength(1);
  });
});

describe('the schema is filterable on /products/sellable', () => {
  it('coerces an enum filter value, and refuses one outside the options', () => {
    const fit = schema.find((f) => f.key === 'fit')!;

    expect(coerceAttributeQueryValue(fit, 'Slim')).toEqual({ ok: true, value: 'Slim' });
    expect(coerceAttributeQueryValue(fit, 'Skinny').ok).toBe(false);
  });
});

describe('other domains are unchanged (regression guard)', () => {
  it('HARDWARE still declares an empty schema and still refuses every key', () => {
    // An empty schema is a closed door, not an absent one. If 2.4 had been
    // written on the wrong descriptor this is what would have caught it.
    expect(domainFor('HARDWARE').catalogue.attributeSchema).toEqual([]);
    expect(validateAttributes(domainFor('HARDWARE').catalogue.attributeSchema, { fit: 'Slim' }))
      .toHaveLength(1);
  });

  it('HOTEL keeps its own fields — schemas are per domain, not global', () => {
    expect(domainFor('HOTEL').catalogue.attributeSchema.map((f) => f.key)).toEqual([
      'bedCount',
      'maxOccupancy',
      'viewType',
    ]);
  });
});
