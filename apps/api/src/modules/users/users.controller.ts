import { ModuleKey } from '@hardware-pos/database';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { Paginated } from '@hardware-pos/shared';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Permission } from '../auth/permissions';
import { CreateUserDto } from './dto/create-user.dto';
import { PublicUser } from './users.repository';
import { UsersService } from './users.service';

@Controller('users')
// Slice 7.6 — enabled for every business profile; inert today, meaningful once switched off.
@RequireModule(ModuleKey.USERS)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions(Permission.USER_MANAGE)
  list(
    @TenantId() tenantId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<PublicUser>> {
    return this.usersService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.USER_MANAGE)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<PublicUser> {
    return this.usersService.getById(tenantId, id);
  }

  @Post()
  @RequirePermissions(Permission.USER_MANAGE)
  create(@TenantId() tenantId: string, @Body() dto: CreateUserDto): Promise<PublicUser> {
    return this.usersService.create(tenantId, dto);
  }
}
