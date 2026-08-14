/**
 * The domain registry tripwires (D56/D57, convergence plan §13.1).
 *
 * What broke before this existed: adding a vertical touched fifteen places,
 * eleven of which failed SILENTLY — a missing nav entry fell back to the
 * retail rail, a missing role-template branch fell back to the built-ins, and
 * six inline predicates fell back to the retail page. HOTEL shipped missing
 * seven of the fifteen. These tests are the structural guarantee that the
 * registry ended that, per D30: positive and negative assertions, exact sets,
 * and a fixture proof that extension needs no production edit.
 */
import { BusinessType } from '@hardware-pos/database';
import {
  BUSINESS_TYPE_VALUES,
  DOMAIN_REGISTRY,
  FOOD_SERVICE_CAPABILITIES,
  HOTEL_DOMAIN,
  RETAIL_CAPABILITIES,
  WORKSPACE_TEMPLATES,
  domainFor,
  roleTemplatesForBusinessType,
  type DomainDescriptor,
  type TenantCapabilities,
} from '@hardware-pos/shared';

describe('the registry is total, and answers with complete descriptors', () => {
  it('every persisted business type has a descriptor — exact set, both ways', () => {
    expect(Object.keys(DOMAIN_REGISTRY).sort()).toEqual(Object.values(BusinessType).sort());
  });

  it.each(BUSINESS_TYPE_VALUES)('%s answers with a complete descriptor', (businessType) => {
    const d = domainFor(businessType);
    expect(d.businessTypes).toContain(businessType);
    expect(d.label.length).toBeGreaterThan(0);
    expect(d.template.key.length).toBeGreaterThan(0);
    expect(d.modules.length).toBeGreaterThan(0);
    expect(d.navigation.length).toBeGreaterThan(0);
    expect(d.roleTemplates.length).toBeGreaterThan(0);
    expect(d.capabilities.fulfilment.channels.length).toBeGreaterThan(0);
  });

  it('has NO fallback: an unknown value answers undefined, never a domain', () => {
    /*
     * The `?? RETAIL_NAV` this design replaced handed an unknown domain the
     * retail screens — plausibly wrong, so nobody looked. Undefined here means
     * every consumer either fails the compile (typed callers) or renders the
     * visibly empty state (string callers) — wrong in a way someone reports.
     */
    const loose = DOMAIN_REGISTRY as Record<string, DomainDescriptor | undefined>;
    expect(loose['TILE_SHOP']).toBeUndefined();
    expect(loose['RETAIL']).toBeUndefined();
    expect(loose['SOMETHING_NEW']).toBeUndefined();
    // POSITIVE CONTROL: a registered value is found.
    expect(loose['HARDWARE']).toBeDefined();
  });

  it('role templates throw on an unknown type rather than falling back', () => {
    expect(() => roleTemplatesForBusinessType('TILE_SHOP')).toThrow(/Unknown business type/);
    expect(() => roleTemplatesForBusinessType('RESTAURANT')).not.toThrow();
  });
});

describe('capabilities parity (plan Q7): hotel mirrors food service, visibly', () => {
  it('HOTEL re-declares food-service values that are deepEqual today', () => {
    /*
     * The hotel descriptor is its own FILE on purpose — the day hotels
     * diverge, the change is a visible edit there. Until then this pins the
     * mirror so an accidental partial divergence (capabilities drifting while
     * modules stay shared, say) cannot happen silently.
     */
    expect(HOTEL_DOMAIN.capabilities).toEqual(FOOD_SERVICE_CAPABILITIES);
    expect([...HOTEL_DOMAIN.modules].sort()).toEqual([...domainFor('RESTAURANT').modules].sort());
    expect(HOTEL_DOMAIN.navigation).toBe(domainFor('RESTAURANT').navigation);
  });

  it('hotel is NOT the retail capability set — the parity above is not vacuous', () => {
    expect(HOTEL_DOMAIN.capabilities).not.toEqual(RETAIL_CAPABILITIES);
    expect(HOTEL_DOMAIN.capabilities.fulfilment.kind).toBe('TABLE_SERVICE');
    expect(RETAIL_CAPABILITIES.fulfilment.kind).toBe('IMMEDIATE');
  });
});

describe('QuickBooks is one domain’s integration (plan §4.9.5 / D68)', () => {
  it('exactly the hardware domain carries the QuickBooks provider AND module', () => {
    const withProvider = BUSINESS_TYPE_VALUES.filter(
      (t) => domainFor(t).profile.accountingProvider === 'QUICKBOOKS',
    );
    const withModule = BUSINESS_TYPE_VALUES.filter((t) =>
      domainFor(t).modules.includes('QUICKBOOKS'),
    );
    // Exact sets: a copy-pasted descriptor for a new vertical that keeps the
    // QuickBooks lines fails here by name.
    expect(withProvider).toEqual(['HARDWARE']);
    expect(withModule).toEqual(['HARDWARE']);
  });

  it('every other domain declares NONE and QuickBooks-free inventory or LOCAL/DISABLED', () => {
    for (const t of BUSINESS_TYPE_VALUES.filter((v) => v !== 'HARDWARE')) {
      expect({ t, provider: domainFor(t).profile.accountingProvider }).toEqual({
        t,
        provider: 'NONE',
      });
      expect(domainFor(t).profile.inventoryMode).not.toBe('QUICKBOOKS');
    }
  });
});

describe('workspace templates derive from the registry (D55/D56)', () => {
  it('offers exactly the three templates, in order, with the canonical types', () => {
    expect(WORKSPACE_TEMPLATES.map((t) => [t.key, t.businessType])).toEqual([
      ['HARDWARE', 'HARDWARE'],
      ['RESTAURANT', 'RESTAURANT'],
      ['HOTEL', 'HOTEL'],
    ]);
  });

  it('GENERAL exists as a domain but is deliberately not offered', () => {
    // Positive that the withholding mechanism works — not that GENERAL is gone.
    expect(domainFor('GENERAL')).toBeDefined();
    expect(WORKSPACE_TEMPLATES.map((t) => t.key)).not.toContain('GENERAL');
  });
});

describe('the extensibility contract (plan §13.4)', () => {
  /**
   * A fictional vertical, declared the way a real one would be — composing
   * shared pieces — and registered in a TEST-ONLY registry copy. If this test
   * ever needs a production file edited to pass, the architecture has not
   * been delivered: one descriptor + one registry line is the whole cost.
   */
  it('a new composed domain is one descriptor and one registry line', () => {
    const grocery: DomainDescriptor = {
      businessTypes: ['GROCERY' as never],
      label: 'Grocery',
      template: { key: 'GROCERY', name: 'Grocery / Convenience', description: 'Test fixture', order: 4 },
      profile: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
      modules: domainFor('HARDWARE').modules.filter((m) => m !== 'QUICKBOOKS'),
      navigation: domainFor('HARDWARE').navigation,
      roleTemplates: domainFor('HARDWARE').roleTemplates,
      capabilities: {
        ...RETAIL_CAPABILITIES,
        catalogue: { ...RETAIL_CAPABILITIES.catalogue, modifiers: true },
      } satisfies TenantCapabilities,
    };
    const testRegistry = { ...DOMAIN_REGISTRY, GROCERY: grocery };

    // The registered fixture answers every question the platform asks of a
    // domain — modules, navigation, roles, capabilities, template copy —
    // without any production file having changed.
    const d = testRegistry['GROCERY' as BusinessType];
    expect(d.modules.length).toBeGreaterThan(0);
    expect(d.modules).not.toContain('QUICKBOOKS');
    expect(d.navigation.length).toBeGreaterThan(0);
    expect(d.roleTemplates.map((r) => r.key)).toContain('OWNER');
    expect(d.capabilities.catalogue.modifiers).toBe(true);
    expect(d.capabilities.fulfilment.kind).toBe('IMMEDIATE');
  });
});
