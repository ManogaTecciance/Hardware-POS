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
import { PreviewReturnDto } from '../returns/dto/preview-return.dto';
import type { ReturnPreview } from '../returns/returns.types';
import { CompleteExchangeDto } from './dto/complete-exchange.dto';
import { ExchangesService, type ExchangeResult } from './exchanges.service';

/**
 * `/exchanges` — D128, and the end of D2's "reserved key with no workflow".
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

  /**
   * Price the returning leg AS AN EXCHANGE (D130).
   *
   * Its own route rather than `POST /returns/preview` for two reasons. The
   * flag that waives the `Full-sale return` trigger is then set by the server
   * on both exchange paths instead of being asserted by a caller; and this
   * route carries `@RequireModule(EXCHANGES)` and the exchange permission
   * pair, which the returns route does not — so a tenant without the module
   * cannot price an exchange it may not perform.
   *
   * Read-only, so 200 rather than 201.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.RETURN_CREATE, Permission.SALE_CREATE)
  preview(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PreviewReturnDto,
  ): Promise<ReturnPreview> {
    return this.exchanges.preview(tenantId, user, dto);
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
