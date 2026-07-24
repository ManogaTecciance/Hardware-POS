import { Injectable } from '@nestjs/common';
import { Customer, CustomerType, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

export interface CustomerListFilters {
  search?: string;
  customerType?: CustomerType;
  isActive?: boolean;
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

  /** Queue a locally-created customer for a QuickBooks push (stub until real QBO writes). */
  async queueQuickBooksSync(tenantId: string, id: string): Promise<Customer> {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.update({ where: { id }, data: { syncStatus: 'PENDING' } });
      await tx.syncLog.create({
        data: {
          tenantId,
          entityType: 'CUSTOMER',
          entityId: id,
          direction: 'OUTBOUND',
          status: 'PENDING',
          message: `Customer "${customer.name}" queued for QuickBooks sync`,
        },
      });
      return customer;
    });
  }
}
