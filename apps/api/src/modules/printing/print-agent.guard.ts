import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * D67 — authentication for the on-site Print Agent.
 *
 * A branch-scoped bearer token, NOT a user JWT: the agent is a device, has
 * no person behind it, and must never be able to reach a workspace route.
 * The token hashes to exactly one `PrintAgent` row, which supplies the
 * tenant and branch — nothing about scope is taken from the request, so a
 * stolen token can only ever drain its own branch's print queue.
 *
 * Sits beside `PlatformBoundaryGuard` in intent: a separate identity class
 * with a deliberately tiny surface.
 */
export interface AgentPrincipal {
  agentId: string;
  tenantId: string;
  branchId: string;
  name: string;
}

/** Request shape once the guard has attached the agent. */
export interface AgentRequest extends Request {
  agent?: AgentPrincipal;
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class PrintAgentGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('Missing agent token');

    const agent = await this.prisma.printAgent.findFirst({
      where: { tokenHash: hashAgentToken(token), isActive: true },
      select: { id: true, tenantId: true, branchId: true, name: true },
    });
    // One message for "unknown" and "revoked": a token prober learns nothing
    // about which of the two it holds.
    if (!agent) throw new UnauthorizedException('Invalid agent token');

    request.agent = {
      agentId: agent.id,
      tenantId: agent.tenantId,
      branchId: agent.branchId,
      name: agent.name,
    };
    return true;
  }
}
