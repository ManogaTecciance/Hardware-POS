import { Injectable } from '@nestjs/common';
import { Prisma, Supplier, SupplierQbStatus } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import type { SupplierSort } from './dto/query-suppliers.dto';

export interface SupplierListFilters {
  search?: string;
  isActive?: boolean;
  qbStatus?: SupplierQbStatus;
}

function orderByFor(sort: SupplierSort | undefined): Prisma.SupplierOrderByWithRelationInput[] {
  switch (sort) {
    case 'company':
      return [{ company: 'asc' }, { name: 'asc' }];
    case 'dateAdded':
      return [{ createdAt: 'desc' }];
    case 'name':
    default:
      return [{ name: 'asc' }];
  }
}

@Injectable()
export class SuppliersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    tenantId: string,
    filters: SupplierListFilters,
    sort: SupplierSort | undefined,
    skip: number,
    take: number,
  ): Promise<[Supplier[], number]> {
    const where: Prisma.SupplierWhereInput = {
      tenantId,
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { company: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
              { phone: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.qbStatus ? { qbStatus: filters.qbStatus } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.supplier.findMany({ where, orderBy: orderByFor(sort), skip, take }),
      this.prisma.supplier.count({ where }),
    ]);
  }

  findByIdForTenant(tenantId: string, id: string): Promise<Supplier | null> {
    return this.prisma.supplier.findFirst({ where: { id, tenantId } });
  }

  findByName(tenantId: string, name: string): Promise<Supplier | null> {
    return this.prisma.supplier.findFirst({
      where: { tenantId, name: { equals: name, mode: 'insensitive' } },
    });
  }

  create(tenantId: string, data: Omit<Prisma.SupplierUncheckedCreateInput, 'tenantId'>): Promise<Supplier> {
    return this.prisma.supplier.create({ data: { ...data, tenantId } });
  }

  update(id: string, data: Prisma.SupplierUncheckedUpdateInput): Promise<Supplier> {
    return this.prisma.supplier.update({ where: { id }, data });
  }

  delete(id: string): Promise<unknown> {
    return this.prisma.supplier.delete({ where: { id } });
  }
}
