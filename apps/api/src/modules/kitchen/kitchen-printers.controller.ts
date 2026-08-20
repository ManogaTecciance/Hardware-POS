import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ModuleKey, Prisma, KitchenPrinterKind, PrinterRole } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreatePrinterDto, SetPrinterStationsDto, UpdatePrinterDto } from './dto/kitchen.dto';
import { PrintingService } from '../printing/printing.service';

interface PrinterView {
  id: string;
  branchId: string;
  code: string;
  name: string;
  kind: KitchenPrinterKind;
  address: string;
  isActive: boolean;
  /** D67 — KITCHEN (station-routed) or CASHIER (bills). */
  role: PrinterRole;
  columns: number;
  /** D67 — stations this printer serves. Empty on a CASHIER printer. */
  stationIds: string[];
}

function toView(
  row: Prisma.KitchenPrinterGetPayload<Record<string, never>>,
  stationIds: string[] = [],
): PrinterView {
  return {
    id: row.id,
    branchId: row.branchId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    address: row.address,
    isActive: row.isActive,
    role: row.role,
    columns: row.columns,
    stationIds,
  };
}

@Controller('restaurant/branches/:branchId/kitchen-printers')
@RequireModule(ModuleKey.KITCHEN)
export class KitchenPrintersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly printing: PrintingService,
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
    // D67 — one junction read for the whole page rather than N+1 per row.
    const links = await this.prisma.kitchenStationPrinter.findMany({
      where: { printerId: { in: rows.map((r) => r.id) } },
      select: { printerId: true, stationId: true },
    });
    const byPrinter = new Map<string, string[]>();
    for (const link of links) {
      const list = byPrinter.get(link.printerId) ?? [];
      list.push(link.stationId);
      byPrinter.set(link.printerId, list);
    }
    return rows.map((r) => toView(r, byPrinter.get(r.id) ?? []));
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
          role: (dto.role as PrinterRole | undefined) ?? PrinterRole.KITCHEN,
          columns: dto.columns ?? 48,
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
        role: (dto.role as PrinterRole | undefined) ?? undefined,
        columns: dto.columns ?? undefined,
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

  /**
   * D67 — which stations this printer serves. Replace-all.
   *
   * KOT print attempts are created per station→printer link, so a KITCHEN
   * printer with no links is a printer that never prints. Before this
   * endpoint the junction could only be written by hand in SQL.
   */
  @Put(':printerId/stations')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async setStations(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('printerId') printerId: string,
    @Body() dto: SetPrinterStationsDto,
  ): Promise<PrinterView> {
    const printer = await this.prisma.kitchenPrinter.findFirst({
      where: { id: printerId, tenantId, branchId },
    });
    if (!printer) throw new NotFoundException('Printer not found');

    const stationIds = [...new Set(dto.stationIds)];
    if (stationIds.length > 0) {
      // Every station must belong to THIS branch: a cross-branch link would
      // route one shop's tickets to another's printer.
      const valid = await this.prisma.kitchenStation.count({
        where: { id: { in: stationIds }, tenantId, branchId },
      });
      if (valid !== stationIds.length) {
        throw new NotFoundException('One or more stations were not found on this branch');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.kitchenStationPrinter.deleteMany({ where: { printerId: printer.id } });
      for (const stationId of stationIds) {
        await tx.kitchenStationPrinter.create({
          data: { stationId, printerId: printer.id, isPrimary: dto.isPrimary ?? true },
        });
      }
    });
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_PRINTER_STATIONS_SET',
      entityType: 'KitchenPrinter',
      entityId: printer.id,
      metadata: { branchId, stationIds, count: stationIds.length },
    });
    return toView(printer, stationIds);
  }

  /**
   * D67 — print a self-test page NOW and report the outcome verbatim.
   *
   * The one place an operator can answer "can the server reach this
   * printer?" without placing a real order; the error string is the driver's
   * own (socket refused, timed out, bad path), because a generic failure
   * message is useless when configuring hardware.
   */
  @Post(':printerId/test-print')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async testPrint(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Param('printerId') printerId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const printer = await this.prisma.kitchenPrinter.findFirst({
      where: { id: printerId, tenantId, branchId },
      select: { id: true },
    });
    if (!printer) throw new NotFoundException('Printer not found');
    return this.printing.testPrint(tenantId, printer.id);
  }
}
