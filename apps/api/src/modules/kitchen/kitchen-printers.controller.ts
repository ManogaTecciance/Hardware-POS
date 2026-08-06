import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ModuleKey, Prisma, KitchenPrinterKind } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreatePrinterDto, UpdatePrinterDto } from './dto/kitchen.dto';

interface PrinterView {
  id: string;
  branchId: string;
  code: string;
  name: string;
  kind: KitchenPrinterKind;
  address: string;
  isActive: boolean;
}

function toView(row: Prisma.KitchenPrinterGetPayload<Record<string, never>>): PrinterView {
  return {
    id: row.id,
    branchId: row.branchId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    address: row.address,
    isActive: row.isActive,
  };
}

@Controller('restaurant/branches/:branchId/kitchen-printers')
@RequireModule(ModuleKey.KITCHEN)
export class KitchenPrintersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  async list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
  ): Promise<PrinterView[]> {
    const rows = await this.prisma.kitchenPrinter.findMany({
      where: { tenantId, branchId },
      orderBy: { code: 'asc' },
    });
    return rows.map(toView);
  }

  @Post()
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreatePrinterDto,
  ): Promise<PrinterView> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    try {
      const created = await this.prisma.kitchenPrinter.create({
        data: {
          tenantId,
          branchId,
          code: dto.code,
          name: dto.name,
          kind: dto.kind as KitchenPrinterKind,
          address: dto.address,
        },
      });
      await this.audit.record(tenantId, {
        userId: actor.id,
        action: 'KITCHEN_PRINTER_CREATED',
        entityType: 'KitchenPrinter',
        entityId: created.id,
        metadata: { branchId, code: created.code, kind: created.kind },
      });
      return toView(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Printer code ${dto.code} already exists on this branch`);
      }
      throw e;
    }
  }

  @Patch(':printerId')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('printerId') printerId: string,
    @Body() dto: UpdatePrinterDto,
  ): Promise<PrinterView> {
    const existing = await this.prisma.kitchenPrinter.findFirst({
      where: { id: printerId, tenantId, branchId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Printer not found');
    const updated = await this.prisma.kitchenPrinter.update({
      where: { id: existing.id },
      data: {
        name: dto.name ?? undefined,
        kind: (dto.kind as KitchenPrinterKind | undefined) ?? undefined,
        address: dto.address ?? undefined,
        isActive: dto.isActive ?? undefined,
      },
    });
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_PRINTER_UPDATED',
      entityType: 'KitchenPrinter',
      entityId: printerId,
      metadata: {
        branchId,
        isActive: updated.isActive,
        kind: updated.kind,
      },
    });
    return toView(updated);
  }
}
