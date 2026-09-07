import { ModuleKey } from '@hardware-pos/database';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CompleteExchangeDto } from './dto/complete-exchange.dto';
import { ExchangesService, type ExchangeResult } from './exchanges.service';

/**
 * `/exchanges` — D107, and the end of D2's "reserved key with no workflow".
 *
 * Gated on `ModuleKey.EXCHANGES`, which retail already carries and food service
 * deliberately does not (D2). That gate has existed since Phase 0; until now it
 * guarded a document with no transaction behind it.
 *
 * Permissions are **both** `RETURN_CREATE` and `SALE_CREATE`, because an
 * exchange really does both. Requiring only one would let somebody who may not
 * take returns cause a refund through the side door.
 */
@Controller('exchanges')
@RequireModule(ModuleKey.EXCHANGES)
export class ExchangesController {
  constructor(private readonly exchanges: ExchangesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.RETURN_CREATE, Permission.SALE_CREATE)
  complete(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteExchangeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ExchangeResult> {
    return this.exchanges.complete(tenantId, user, dto, idempotencyKey ?? null);
  }

  @Get()
  @RequirePermissions(Permission.RETURN_READ)
  list(@TenantId() tenantId: string, @Query('take') take?: string): Promise<ExchangeResult[]> {
    return this.exchanges.list(tenantId, take ? Number(take) : undefined);
  }

  @Get(':id')
  @RequirePermissions(Permission.RETURN_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<ExchangeResult> {
    return this.exchanges.getById(tenantId, id);
  }
}
