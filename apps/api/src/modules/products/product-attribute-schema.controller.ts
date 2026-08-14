import { Controller, Get } from '@nestjs/common';
import type { AttributeField } from '@hardware-pos/shared';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { ProductAttributesService } from './product-attributes.service';

/**
 * D64 — `GET /products/attribute-schema`: the tenant domain's declared
 * catalogue attribute fields (convergence plan §4.6, Phase 7).
 *
 * One declarative list drives both the wizard's generic attributes step and
 * the server-side validator, so what the form offers and what the API
 * accepts cannot drift apart. `fields: []` is a real answer — "this
 * vertical stores no domain attributes" — not an error.
 *
 * SHARED CORE, like the rest of the catalogue read surface: every domain may
 * ask; the schema itself is what varies.
 */
@Controller('products/attribute-schema')
export class ProductAttributeSchemaController {
  constructor(private readonly attributes: ProductAttributesService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  async get(@TenantId() tenantId: string): Promise<{ fields: readonly AttributeField[] }> {
    return { fields: await this.attributes.schemaForTenant(tenantId) };
  }
}
