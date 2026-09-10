import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  ATTRIBUTE_FIELD_TYPES,
  domainFor,
  type AttributeField,
} from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProfileService } from '../platform/business-profile.service';
import { SettingsService } from '../settings/settings.service';

/**
 * D161 — the tenant's own **business details**: the extra per-product fields
 * the wizard collects into `Product.attributes` (D64).
 *
 * ## What this is NOT
 *
 * Not variations. `AttributeDefinition` / `AttributeOption` and the
 * `ProductVariationDimension` rows they map to describe what makes one SKU
 * different from another — a Medium is a thing you sell. Business details
 * describe the product itself: "Material: Cotton", "Season: Summer". Nothing
 * is scanned, priced or depleted by them (D64: behaviour goes in columns,
 * description goes in `attributes`), which is exactly why they can live in a
 * settings blob while variations need tables.
 *
 * ## Where the list comes from
 *
 * A domain declares one (`catalogue.attributeSchema`) and that has always been
 * the whole answer. A tenant whose domain says so may now replace it, and the
 * override lives in `TenantSettings.data.catalogue.businessDetails`.
 *
 * Three states, and they are all different:
 *
 *  - **absent** — the tenant has said nothing. The domain's list applies, which
 *    is every tenant today and why nothing changes until somebody opens the tab.
 *  - **`[]`** — "we track none". The wizard step disappears (`visibleSteps`).
 *  - **a list** — the tenant's own fields.
 *
 * ## Why a separate service
 *
 * `ProductsService` may not reference `BusinessProfileService` (D28, and a
 * tripwire enforces it), and this needs the profile to read a capability. It is
 * the same reasoning that put `ProductAttributesService` beside it: domain DATA
 * rules, resolved from the profile, thrown as ordinary refusals.
 */
@Injectable()
export class BusinessDetailsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly profiles: BusinessProfileService,
    private readonly prisma: PrismaService,
  ) {}

  /** May this tenant's domain define its own fields at all? */
  async isConfigurable(tenantId: string): Promise<boolean> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    return domainFor(profile.businessType).capabilities.catalogue.configurableBusinessDetails === true;
  }

  /**
   * The fields this tenant collects — the ONE resolver, used by the wizard, by
   * `GET /products/attribute-schema` and by attribute validation.
   *
   * The override is honoured only where the capability allows it. A stored list
   * on a domain that does not offer the feature is ignored rather than obeyed:
   * a workspace that changed business type must not keep enforcing the previous
   * type's fields.
   */
  async schemaFor(tenantId: string): Promise<readonly AttributeField[]> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    const domain = domainFor(profile.businessType);
    if (domain.capabilities.catalogue.configurableBusinessDetails !== true) {
      return domain.catalogue.attributeSchema;
    }
    const override = this.settings.getSettings(tenantId).catalogue.businessDetails;
    return override ?? domain.catalogue.attributeSchema;
  }

  /** What the Settings tab renders, and where the list currently comes from. */
  async getConfig(
    tenantId: string,
  ): Promise<{ fields: readonly AttributeField[]; source: 'TENANT' | 'DOMAIN' }> {
    await this.requireConfigurable(tenantId);
    const override = this.settings.getSettings(tenantId).catalogue.businessDetails;
    return override
      ? { fields: override, source: 'TENANT' }
      : { fields: await this.schemaFor(tenantId), source: 'DOMAIN' };
  }

  /**
   * Replace the whole list.
   *
   * Replace semantics, like the attributes document itself: the payload IS the
   * definition. Partial edits would need row identity, and `key` already is it.
   */
  async replace(tenantId: string, fields: AttributeField[]): Promise<{ fields: AttributeField[] }> {
    await this.requireConfigurable(tenantId);
    assertWellFormed(fields);

    const before = await this.schemaFor(tenantId);
    await this.assertNothingInUseIsLost(tenantId, before, fields);

    await this.settings.replaceBusinessDetails(tenantId, fields);
    return { fields };
  }

  // ── rules ──────────────────────────────────────────────────────────────────

  private async requireConfigurable(tenantId: string): Promise<void> {
    if (await this.isConfigurable(tenantId)) return;
    throw new BadRequestException({
      code: 'BUSINESS_DETAILS_NOT_CONFIGURABLE',
      message:
        'This workspace does not define its own business details. Its business type declares the fields it tracks.',
    });
  }

  /**
   * Refuse a removal that would orphan stored values.
   *
   * `validateAttributes` refuses unknown keys, so a product carrying a key the
   * schema no longer declares cannot be SAVED again — the operator would delete
   * a field today and discover next week that a product will not save, with
   * nothing on screen connecting the two. Same for dropping an option a product
   * has selected, and for retyping a field out from under its values.
   *
   * So the deletion is refused while it is in use, with the count, exactly as
   * `AttributeLibraryService.remove` refuses a definition a variant points at.
   * The operator clears the values first. Nothing is cascaded and nothing is
   * silently rewritten.
   */
  private async assertNothingInUseIsLost(
    tenantId: string,
    before: readonly AttributeField[],
    after: readonly AttributeField[],
  ): Promise<void> {
    const byKeyAfter = new Map(after.map((f) => [f.key, f]));

    for (const old of before) {
      const next = byKeyAfter.get(old.key);

      if (!next) {
        const used = await this.countProductsWithKey(tenantId, old.key);
        if (used > 0) {
          throw new ConflictException({
            code: 'BUSINESS_DETAIL_IN_USE',
            message: `${used} product(s) still record "${old.label}". Clear it on those products before removing the field.`,
          });
        }
        continue;
      }

      if (next.type !== old.type) {
        const used = await this.countProductsWithKey(tenantId, old.key);
        if (used > 0) {
          throw new ConflictException({
            code: 'BUSINESS_DETAIL_IN_USE',
            message: `${used} product(s) record "${old.label}", so its type cannot change from ${old.type} to ${next.type}. Clear it on those products first.`,
          });
        }
      }

      if (old.type === 'enum' && next.type === 'enum') {
        const kept = new Set(next.options);
        for (const option of old.options) {
          if (kept.has(option)) continue;
          const used = await this.countProductsWithValue(tenantId, old.key, option);
          if (used > 0) {
            throw new ConflictException({
              code: 'BUSINESS_DETAIL_OPTION_IN_USE',
              message: `${used} product(s) are set to "${option}" for ${old.label}. Change them before removing that option.`,
            });
          }
        }
      }
    }
  }

  /**
   * How many of this tenant's products carry the key at all.
   *
   * `Product.attributes` is GIN-indexed (see the schema), so `?` and `->>` are
   * both index-assisted. Parameterised and tenant-scoped: these read a JSON
   * document, and a key or value reaching SQL unescaped would be an injection
   * in a place nobody thinks to look.
   */
  private async countProductsWithKey(tenantId: string, key: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "Product"
      WHERE "tenantId" = ${tenantId} AND "attributes" ? ${key}
    `;
    return Number(rows[0]?.count ?? 0);
  }

  private async countProductsWithValue(
    tenantId: string,
    key: string,
    value: string,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "Product"
      WHERE "tenantId" = ${tenantId} AND "attributes" ->> ${key} = ${value}
    `;
    return Number(rows[0]?.count ?? 0);
  }
}

/** A key that reports address must be stable and machine-safe (D64). */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Structural rules the DTO cannot express.
 *
 * The DTO validates each field on its own; these are the rules ABOUT the list —
 * duplicate keys, and a dropdown with nothing to choose from.
 */
function assertWellFormed(fields: readonly AttributeField[]): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (!KEY_PATTERN.test(f.key)) {
      throw new BadRequestException({
        code: 'BUSINESS_DETAIL_KEY_INVALID',
        message: `"${f.key}" is not a usable key. Use letters and digits, starting with a lower-case letter.`,
      });
    }
    if (seen.has(f.key)) {
      throw new BadRequestException({
        code: 'BUSINESS_DETAIL_KEY_DUPLICATE',
        message: `Two fields both use the key "${f.key}". Keys identify the value on every product, so they must be unique.`,
      });
    }
    seen.add(f.key);

    if (!ATTRIBUTE_FIELD_TYPES.includes(f.type)) {
      throw new BadRequestException({
        code: 'BUSINESS_DETAIL_TYPE_INVALID',
        message: `"${f.type}" is not a field type.`,
      });
    }

    if (f.type === 'enum') {
      const options = f.options ?? [];
      if (options.length === 0) {
        throw new BadRequestException({
          code: 'BUSINESS_DETAIL_OPTIONS_EMPTY',
          message: `${f.label} is a dropdown, so it needs at least one option.`,
        });
      }
      if (new Set(options).size !== options.length) {
        throw new BadRequestException({
          code: 'BUSINESS_DETAIL_OPTIONS_DUPLICATE',
          message: `${f.label} lists the same option twice.`,
        });
      }
    }
  }
}
