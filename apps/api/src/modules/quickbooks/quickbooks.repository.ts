import { Injectable } from '@nestjs/common';
import { QuickBooksConnection } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

export interface ConnectionTokens {
  realmId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  tokenType: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  environment: string;
}

@Injectable()
export class QuickBooksRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(tenantId: string): Promise<QuickBooksConnection | null> {
    return this.prisma.quickBooksConnection.findUnique({ where: { tenantId } });
  }

  upsert(tenantId: string, tokens: ConnectionTokens): Promise<QuickBooksConnection> {
    const data = {
      realmId: tokens.realmId,
      accessToken: tokens.accessTokenEnc,
      refreshToken: tokens.refreshTokenEnc,
      tokenType: tokens.tokenType,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      environment: tokens.environment,
      isActive: true,
    };
    return this.prisma.quickBooksConnection.upsert({
      where: { tenantId },
      update: { ...data, connectedAt: new Date() },
      create: { tenantId, ...data },
    });
  }

  /** Mark the connection dead (e.g. the refresh token was revoked or expired). */
  async deactivate(tenantId: string): Promise<void> {
    await this.prisma.quickBooksConnection.updateMany({
      where: { tenantId },
      data: { isActive: false },
    });
  }

  /** Update just the rotated tokens after a refresh. */
  updateTokens(
    tenantId: string,
    tokens: Pick<
      ConnectionTokens,
      'accessTokenEnc' | 'refreshTokenEnc' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'
    >,
  ): Promise<QuickBooksConnection> {
    return this.prisma.quickBooksConnection.update({
      where: { tenantId },
      data: {
        accessToken: tokens.accessTokenEnc,
        refreshToken: tokens.refreshTokenEnc,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      },
    });
  }

  async delete(tenantId: string): Promise<void> {
    await this.prisma.quickBooksConnection.deleteMany({ where: { tenantId } });
  }
}
