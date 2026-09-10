import { Body, Controller, Get, Put } from '@nestjs/common';
import type { AttributeField } from '@hardware-pos/shared';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { BusinessDetailsService } from './business-details.service';
import { ReplaceBusinessDetailsDto } from './dto/business-details.dto';

/**
 * D150 — `/products/business-details`: the tenant's own catalogue fields.
 *
 * Configuration, not catalogue data, so the write takes `PRODUCT_MANAGE` while
 * the read takes `PRODUCT_READ` — the same split `/attribute-library` uses for
 * the option library beside it.
 *
 * Deliberately NOT gated on a module key. Whether a tenant may define its own
 * fields is a CAPABILITY of its business type (D56), which the service reads;
 * a module gate would be a second, weaker answer to the same question. The
 * service refuses a workspace whose domain does not offer it, so hiding the
 * Settings tab stays what it should be — usability, with the server as the
 * authority.
 */
@Controller('products/business-details')
export class BusinessDetailsController {
  constructor(private readonly businessDetails: BusinessDetailsService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  get(
    @TenantId() tenantId: string,
  ): Promise<{ fields: readonly AttributeField[]; source: 'TENANT' | 'DOMAIN' }> {
    return this.businessDetails.getConfig(tenantId);
  }

  @Put()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  replace(
    @TenantId() tenantId: string,
    @Body() dto: ReplaceBusinessDetailsDto,
  ): Promise<{ fields: AttributeField[] }> {
    return this.businessDetails.replace(tenantId, dto.fields as AttributeField[]);
  }
}
