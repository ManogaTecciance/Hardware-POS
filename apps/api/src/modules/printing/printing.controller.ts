import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { PrintAgentService } from './print-agent.service';
import { PrintDispatcherService } from './print-dispatcher.service';
import { PrinterDiscoveryService, DEFAULT_PRINTER_PORT } from './printer-discovery.service';
import { PrintingService } from './printing.service';

/** `null` clears a choice; an omitted field leaves it untouched. */
export class SetMyPrintersDto {
  @IsOptional() @IsString() kitchenPrinterId?: string | null;
  @IsOptional() @IsString() cashierPrinterId?: string | null;
}

export class ProbePrinterDto {
  @IsString() host!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
}

export class PairAgentDto {
  @IsString() branchId!: string;
  @IsString() name!: string;
}

/**
 * D67 — the print queue's operator surface: how deep is it, what failed, and
 * a retry. Gated on KITCHEN like the rest of the printing configuration.
 */
@Controller('printing')
@RequireModule(ModuleKey.KITCHEN)
export class PrintingController {
  constructor(
    private readonly printing: PrintingService,
    private readonly dispatcher: PrintDispatcherService,
    private readonly discovery: PrinterDiscoveryService,
    private readonly agents: PrintAgentService,
  ) {}

  /**
   * D67 — pair an on-site print agent. The token is returned ONCE.
   *
   * Owner-facing: the shop installs the agent on a machine that can see the
   * printers, pastes this token, and the branch flips to agent transport
   * automatically on the first heartbeat.
   */
  @Post('agents')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  pairAgent(@TenantId() tenantId: string, @Body() dto: PairAgentDto) {
    return this.agents.pair(tenantId, dto.branchId, dto.name);
  }

  @Get('agents')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  listAgents(@TenantId() tenantId: string, @Query('branchId') branchId: string) {
    return this.agents.listAgents(tenantId, branchId);
  }

  @Post('agents/:agentId/revoke')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async revokeAgent(
    @TenantId() tenantId: string,
    @Param('agentId') agentId: string,
  ): Promise<{ ok: true }> {
    await this.agents.revoke(tenantId, agentId);
    return { ok: true };
  }

  /**
   * D67 — scan the shop network for devices answering on the printer port.
   *
   * The SERVER scans, because the tablet cannot: a browser has no raw
   * sockets, and the API is the process that will hold the print connection
   * anyway. Requires the API to be on the shop LAN — see
   * `PrinterDiscoveryService` for why that is inherent rather than a
   * shortcut.
   */
  @Get('discover')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async discover(@Query('branchId') branchId?: string, @Query('port') port?: string) {
    const parsed = Number(port);
    const wanted = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PRINTER_PORT;

    /*
     * Whoever can SEE the shop network answers this. In the cloud
     * deployment (Amplify + EC2) that is the on-site agent, which reports
     * what it found on each heartbeat; the API itself is on a different
     * network entirely and would scan its own VPC — a wrong answer
     * presented as a right one. On an on-prem install there is no agent and
     * the API scans its own LAN, which IS the shop's.
     */
    const reported = branchId ? this.agents.lastDiscovery(branchId) : null;
    if (reported) {
      return {
        source: 'AGENT' as const,
        agentName: reported.agentName,
        at: reported.at,
        port: wanted,
        printers: reported.printers,
        subnets: [],
        hostsScanned: reported.printers.length,
      };
    }
    return { source: 'SERVER' as const, ...(await this.discovery.scan(wanted)) };
  }

  /** Check ONE address — the manual-entry counterpart to the scan. */
  @Post('probe')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async probe(@Body() dto: ProbePrinterDto) {
    const found = await this.discovery.probe(dto.host, dto.port ?? DEFAULT_PRINTER_PORT);
    return {
      reachable: found !== null,
      host: dto.host,
      port: dto.port ?? DEFAULT_PRINTER_PORT,
      latencyMs: found?.latencyMs ?? null,
    };
  }

  /**
   * D67 — the signed-in user's own kitchen/cashier printers.
   *
   * Per-user rather than per-device: a waiter signs in on whichever tablet
   * is charged, and their tickets should still come out of their printer.
   */
  /*
   * PLATFORM_PROFILE_READ, not KOT_VIEW: this is a personal preference every
   * signed-in workspace user sets for themselves, and the WAITER template
   * deliberately does not carry KOT_VIEW (they send to the kitchen, they do
   * not work the kitchen display). Gating on the kitchen permission would
   * have locked the very people this setting exists for out of it.
   */
  @Get('my-printers')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  myPrinters(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Query('branchId') branchId: string,
  ) {
    return this.printing.getMyPrinters(tenantId, actor.id, branchId);
  }

  @Put('my-printers')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  async setMyPrinters(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: SetMyPrintersDto,
  ): Promise<{ ok: true }> {
    await this.printing.setMyPrinters(tenantId, actor.id, dto);
    return { ok: true };
  }

  @Get('queue')
  @RequirePermissions(Permission.KOT_VIEW)
  queue(@TenantId() tenantId: string, @Query('branchId') branchId: string) {
    return this.printing.queueStatus(tenantId, branchId);
  }

  @Post('jobs/:jobId/retry')
  @RequirePermissions(Permission.KOT_PRINT)
  async retry(@TenantId() tenantId: string, @Param('jobId') jobId: string): Promise<{ ok: true }> {
    await this.printing.retryJob(tenantId, jobId);
    return { ok: true };
  }

  /**
   * Drain the queue now rather than waiting for the worker's next tick.
   * Exists for the operator ("print the stuck ones") and for tests, which
   * run with the worker disabled so nothing races a timer.
   */
  @Post('drain')
  @RequirePermissions(Permission.KOT_PRINT)
  drain(): Promise<{ kot: number; bill: number }> {
    return this.dispatcher.drain();
  }
}
