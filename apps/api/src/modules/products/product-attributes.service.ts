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

  /**
   * D134e — refuse a measured product from a domain that does not sell by
   * measure. RETAIL declares `catalogue.measuredGoods`; hardware, food
   * service and general do not.
   *
   * Here for the reason this whole class exists: `ProductsService` may not
   * reference `BusinessProfileService` (D28, and a tripwire enforces it), and
   * this is domain DATA validation rather than provider routing — the same
   * shape as the attribute check below. The class name lags what it now
   * holds; it is the products module's domain-rule resolver.
   *
   * ## Why this checks the INCOMING value, not the resulting state
   *
   * D134c's unit check reads the resulting state, because leaving a product
   * measured-with-no-unit is invalid however you arrive there. This one is
   * the opposite: it must not brick a row that already exists. A hardware
   * tenant that acquired a DECIMAL product before this guard — the pilot has
   * a real one — must still be able to rename it, reprice it, and above all
   * switch it back to WHOLE. Reading the resulting state would refuse every
   * edit to that row, including the edit that fixes it.
   *
   * So the rule is “you may not ASSERT measured here”, not “no measured row
   * may exist here”. Frontend hiding is usability; this is the authority.
   */
  async assertMeasuredGoodsAllowed(
    tenantId: string,
    quantityType: string | null | undefined,
  ): Promise<void> {
    if (quantityType !== 'DECIMAL') return;
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    if (domainFor(profile.businessType).capabilities.catalogue.measuredGoods === true) {
      return;
    }
    throw new BadRequestException({
      code: 'MEASURED_GOODS_NOT_OFFERED',
      message:
        'This workspace does not sell products by weight or measure. Products here are counted in whole units.',
    });
  }

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
