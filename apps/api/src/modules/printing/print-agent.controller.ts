import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { Public } from '../../common/decorators/public.decorator';
import { PrintAgentGuard, type AgentRequest } from './print-agent.guard';
import { AgentReleaseService } from './agent-release.service';
import { PrintAgentService, type AgentPrintJob } from './print-agent.service';

/**
 * D67 — the on-site Print Agent's API.
 *
 * `@Public()` disables the USER authentication stack; `PrintAgentGuard`
 * replaces it with the agent's own branch-scoped bearer token. That is the
 * whole point: an agent is a device with no person and no workspace
 * session, and it must not be able to reach a single workspace route. Every
 * scope on these routes comes from the token's own `PrintAgent` row, never
 * from the request body.
 */

class DiscoveredPrinterDto {
  @IsString() host!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number;
  @IsOptional() @Type(() => Number) @IsInt() latencyMs?: number;
  /** D183 — answered DLE EOT like a receipt printer; absent when not checked. */
  @IsOptional() @IsBoolean() escpos?: boolean;
}

/**
 * D183 — a printer the agent's own Windows spooler knows. Its `name` is the
 * exact string a USB or office printer needs as its address, which is why
 * the agent reports it: the owner picks it instead of copying it by hand.
 */
export class LocalPrinterDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(200) driver?: string | null;
  @IsOptional() @IsString() @MaxLength(200) port?: string | null;
}

export class HeartbeatDto {
  @IsOptional() @IsString() version?: string;
  /** Devices the agent found on the shop LAN, if it just scanned. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DiscoveredPrinterDto)
  discovered?: DiscoveredPrinterDto[];
  /** Printers installed on the agent's machine (D183). Absent from 0.1.0 agents. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LocalPrinterDto)
  localPrinters?: LocalPrinterDto[];
}

class LeaseDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) maxJobs?: number;
}

class AckDto {
  @IsString() leaseId!: string;
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsString() error?: string;
}

@Controller('print-agent')
@Public()
@UseGuards(PrintAgentGuard)
export class PrintAgentController {
  constructor(
    private readonly agents: PrintAgentService,
    private readonly release: AgentReleaseService,
  ) {}

  /**
   * Liveness, version, and (optionally) what the agent can see on the LAN.
   * Also what makes the branch "agent-served" — the API stops trying to
   * print directly the moment a real agent starts checking in.
   */
  @Post('heartbeat')
  async heartbeat(@Req() request: AgentRequest, @Body() dto: HeartbeatDto) {
    const agent = request.agent!;
    if (dto.discovered) {
      this.agents.reportDiscovery(
        agent.branchId,
        agent.name,
        dto.discovered.map((d) => ({
          host: d.host,
          port: d.port,
          latencyMs: d.latencyMs ?? 0,
          escpos: d.escpos,
        })),
        // undefined, not []: an agent that cannot enumerate (0.1.0, Linux)
        // must not erase what a newer one on the same branch reported.
        dto.localPrinters?.map((p) => ({ name: p.name, driver: p.driver ?? null, port: p.port ?? null })),
      );
    }
    await this.agents.heartbeat(agent.agentId, dto.version);
    return {
      ok: true,
      branchId: agent.branchId,
      name: agent.name,
      /** D183 — the settings screen asked for a fresh scan; do one now. */
      scanNow: this.agents.takeScanRequest(agent.branchId),
      /** D183 — the build this API carries; the agent updates itself to it. */
      latestVersion: this.release.latestVersion(),
    };
  }

  /** Claim a batch of ready-to-print documents. */
  /**
   * D183 — the agent build this API ships, for self-update. Behind the agent
   * token like everything else here: the code is not a secret, but an open
   * file server is not something a print API should be.
   */
  @Get('release')
  releaseManifest() {
    const manifest = this.release.manifest();
    if (!manifest) throw new NotFoundException('This API carries no print-agent build');
    return manifest;
  }

  /** One shipped file, by the exact path the manifest lists: `dir/name`… */
  @Get('release/files/:dir/:name')
  releaseFile(@Param('dir') dir: string, @Param('name') name: string, @Res() res: Response) {
    this.sendReleaseFile(`${dir}/${name}`, res);
  }

  /** …or a root file (`package.json` — the only one the manifest ever lists). */
  @Get('release/files/:name')
  releaseRootFile(@Param('name') name: string, @Res() res: Response) {
    this.sendReleaseFile(name, res);
  }

  private sendReleaseFile(path: string, res: Response): void {
    const { bytes, entry } = this.release.file(path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(entry.size));
    res.setHeader('X-Sha256', entry.sha256);
    res.send(bytes);
  }

  @Post('lease')
  lease(@Req() request: AgentRequest, @Body() dto: LeaseDto): Promise<AgentPrintJob[]> {
    return this.agents.lease(request.agent!, dto.maxJobs ?? 8);
  }

  /** Report the outcome of one leased document. */
  @Post('ack')
  ack(@Req() request: AgentRequest, @Body() dto: AckDto) {
    return this.agents.ack(request.agent!, dto);
  }
}
