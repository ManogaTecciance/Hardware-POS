import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';

import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { Permission } from '../../auth/permissions';
import { AttributeDefinitionView, AttributeLibraryService } from './attribute-library.service';
import {
  CreateAttributeDefinitionDto,
  UpdateAttributeDefinitionDto,
} from './dto/attribute-library.dto';

/**
 * `/attribute-library` — the tenant option library (D104 / D104a).
 *
 * SHARED CORE, not a retail module. Any business that sells variants benefits
 * from saying "Size" once, and gating it on a business type would be the D56
 * mistake — read a capability, never a business type. A tenant that never
 * creates a definition sees an empty list, which is a real answer.
 *
 * Reads take `PRODUCT_READ` so the wizard can offer the library to anyone who
 * can browse the catalogue; writes take `PRODUCT_MANAGE`, matching the
 * variations endpoints these definitions are mapped from.
 */
@Controller('attribute-library')
export class AttributeLibraryController {
  constructor(private readonly service: AttributeLibraryService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  async list(@TenantId() tenantId: string): Promise<{ definitions: AttributeDefinitionView[] }> {
    return { definitions: await this.service.list(tenantId) };
  }

  @Get(':definitionId')
  @RequirePermissions(Permission.PRODUCT_READ)
  get(
    @TenantId() tenantId: string,
    @Param('definitionId') definitionId: string,
  ): Promise<AttributeDefinitionView> {
    return this.service.get(tenantId, definitionId);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  create(
    @TenantId() tenantId: string,
    @Body() dto: CreateAttributeDefinitionDto,
  ): Promise<AttributeDefinitionView> {
    return this.service.create(tenantId, dto);
  }

  @Patch(':definitionId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  update(
    @TenantId() tenantId: string,
    @Param('definitionId') definitionId: string,
    @Body() dto: UpdateAttributeDefinitionDto,
  ): Promise<AttributeDefinitionView> {
    return this.service.update(tenantId, definitionId, dto);
  }

  @Delete(':definitionId')
  @HttpCode(204)
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  remove(
    @TenantId() tenantId: string,
    @Param('definitionId') definitionId: string,
  ): Promise<void> {
    return this.service.remove(tenantId, definitionId);
  }
}
