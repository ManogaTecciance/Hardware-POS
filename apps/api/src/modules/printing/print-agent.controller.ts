import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { Public } from '../../common/decorators/public.decorator';
import { PrintAgentGuard, type AgentRequest } from './print-agent.guard';
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
}

class HeartbeatDto {
  @IsOptional() @IsString() version?: string;
  /** Devices the agent found on the shop LAN, if it just scanned. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DiscoveredPrinterDto)
  discovered?: DiscoveredPrinterDto[];
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
  constructor(private readonly agents: PrintAgentService) {}

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
        dto.discovered.map((d) => ({ host: d.host, port: d.port, latencyMs: d.latencyMs ?? 0 })),
      );
    }
    await this.agents.heartbeat(agent.agentId, dto.version);
    return { ok: true, branchId: agent.branchId, name: agent.name };
  }

  /** Claim a batch of ready-to-print documents. */
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
