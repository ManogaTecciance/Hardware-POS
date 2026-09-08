import { BadRequestException, Injectable } from '@nestjs/common';
import { domainFor, validateAttributes, type AttributeField } from '@hardware-pos/shared';

import { BusinessProfileService } from '../platform/business-profile.service';

/**
 * D64 — the one authority on which `Product.attributes` keys a tenant may
 * store (convergence plan §4.6, Phase 7).
 *
 * A separate service, deliberately: `ProductsService` may not reference
 * `BusinessProfileService` (D28 — the provider owns profile routing, and a
 * tripwire enforces the absence). Attribute validation is not provider
 * routing — it is domain DATA validation — so it gets its own resolver, and
 * `ProductsService` reacts to a thrown refusal exactly as it reacts to any
 * other invalid input.
 */
@Injectable()
export class ProductAttributesService {
  constructor(private readonly profiles: BusinessProfileService) {}

  /** The tenant domain's declared schema. Empty = every key is refused. */
  async schemaForTenant(tenantId: string): Promise<readonly AttributeField[]> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    return domainFor(profile.businessType).catalogue.attributeSchema;
  }

  /**
   * Refuse an invalid attributes document with a machine-readable 400.
   * Replace semantics: the payload IS the document, so `required` fields are
   * checked on every full write, not only on create.
   */
  async assertValidDocument(tenantId: string, attributes: unknown): Promise<void> {
    const schema = await this.schemaForTenant(tenantId);
    const issues = validateAttributes(schema, attributes);
    if (issues.length > 0) {
      throw new BadRequestException({
        code: 'PRODUCT_ATTRIBUTES_INVALID',
        message: `Invalid product attributes: ${issues.map((i) => i.message).join(' ')}`,
        issues,
      });
    }
  }
}
