import { Injectable } from '@nestjs/common';
import { Customer, CustomerType, Prisma } from '@hardware-pos/database';

import { mirrorExternalRef } from '../quickbooks/external-ref';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditService } from '../credit/credit.service';

export interface CustomerListFilters {
  search?: string;
  customerType?: CustomerType;
  isActive?: boolean;
  /** Narrow to customers with at least one completed, unsettled sale. */
  hasOutstandingCredit?: boolean;
}

@Injectable()
export class CustomersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    tenantId: string,
    filters: CustomerListFilters,
    skip: number,
    take: number,
  ): Promise<[Customer[], number]> {
    const where: Prisma.CustomerWhereInput = {
      tenantId,
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { company: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
              { phone: { contains: filters.search, mode: 'insensitive' } },
              { mobile: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filters.customerType ? { customerType: filters.customerType } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      // A relational `some` rather than an aggregate: "owes anything at all" is a
      // question about the existence of an unsettled sale, not about a total.
      ...(filters.hasOutstandingCredit ? CreditService.HAS_OUTSTANDING : {}),
    };

    return this.prisma.$transaction([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.customer.count({ where }),
    ]);
  }

  findByIdForTenant(tenantId: string, id: string): Promise<Customer | null> {
    return this.prisma.customer.findFirst({ where: { id, tenantId } });
  }

  create(tenantId: string, data: Prisma.CustomerUncheckedCreateInput): Promise<Customer> {
    return this.prisma.customer.create({ data: { ...data, tenantId } });
  }

  update(id: string, data: Prisma.CustomerUncheckedUpdateInput): Promise<Customer> {
    return this.prisma.customer.update({ where: { id }, data });
  }

  /**
   * Record a failed QuickBooks push so the customer does not read as synced and
   * the reason is visible in the Sync log rather than only in the API response.
   */
  async markQuickBooksSyncFailed(tenantId: string, id: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data: { syncStatus: 'FAILED' } });
      // D63 dual-write — the same mirror `queueQuickBooksSync` performs below.
      await mirrorExternalRef(tx, tenantId, 'CUSTOMER', id, { syncStatus: 'FAILED' });
      await tx.syncLog.create({
        data: {
          tenantId,
          entityType: 'CUSTOMER',
          entityId: id,
          direction: 'OUTBOUND',
          status: 'FAILED',
          message: `QuickBooks customer push failed: ${reason}`,
        },
      });
    });
  }
}
