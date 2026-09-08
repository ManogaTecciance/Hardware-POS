import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@hardware-pos/database';
import type { Paginated } from '@hardware-pos/shared';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { paginate } from '../../common/pagination';
import { AuditLogRepository } from './audit-log.repository';
import { sanitizeAuditMetadata } from './sanitize-audit-metadata';

export interface RecordAuditInput {
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly auditLogRepository: AuditLogRepository) {}

  async list(tenantId: string, query: PaginationQueryDto): Promise<Paginated<AuditLog>> {
    const [items, total] = await this.auditLogRepository.findManyByTenant(
      tenantId,
      query.skip,
      query.take,
    );
    return paginate(items, total, query.page, query.pageSize);
  }

  /**
   * Record an audit entry. Exported for other modules to call.
   *
   * Metadata runs through `sanitizeAuditMetadata` (Phase 1.5.7) so that a
   * caller shipping a raw request body cannot leak a password, PIN, token or
   * credential into the permanent record. See the redactor for the full
   * forbidden-key list.
   */
  record(tenantId: string, input: RecordAuditInput): Promise<AuditLog> {
    const metadata =
      input.metadata !== undefined
        ? (sanitizeAuditMetadata(input.metadata) as Prisma.InputJsonValue)
        : undefined;
    return this.auditLogRepository.create({ tenantId, ...input, metadata });
  }
}
