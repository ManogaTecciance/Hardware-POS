import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';

export interface BrandView {
  id: string;
  name: string;
  isActive: boolean;
  /** How many products carry this brand. What makes archiving a considered act. */
  productCount: number;
}

/**
 * Brands — D112 (`8.9`).
 *
 * A brand is a per-tenant row, not a string on a product and not an enum in the
 * domain's attribute schema. D64 predicted this table and deliberately left
 * `brand` out of the clothing attributes so no tenant would have a stored string
 * to migrate.
 *
 * There is no delete. Archiving keeps the row and every link to it, so an old
 * product still shows what it was; deleting would silently unlink the products,
 * which are the records that actually matter.
 */
@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, includeArchived = false): Promise<BrandView[]> {
    const rows = await this.prisma.brand.findMany({
      where: { tenantId, ...(includeArchived ? {} : { isActive: true }) },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    return rows.map(toView);
  }

  async create(tenantId: string, dto: CreateBrandDto): Promise<BrandView> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('A brand needs a name');
    try {
      const row = await this.prisma.brand.create({
        data: { tenantId, name },
        include: { _count: { select: { products: true } } },
      });
      return toView(row);
    } catch (error) {
      // The unique index, not a prior lookup, is what makes this safe under two
      // simultaneous requests. Translated here so the operator reads a sentence
      // rather than a constraint name.
      if (isUniqueViolation(error)) {
        throw new BadRequestException(`There is already a brand called "${name}"`);
      }
      throw error;
    }
  }

  async update(tenantId: string, id: string, dto: UpdateBrandDto): Promise<BrandView> {
    const existing = await this.prisma.brand.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException(`Brand ${id} not found`);

    try {
      const row = await this.prisma.brand.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        include: { _count: { select: { products: true } } },
      });
      return toView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BadRequestException(`There is already a brand called "${dto.name?.trim()}"`);
      }
      throw error;
    }
  }
}

type BrandRow = Prisma.BrandGetPayload<{ include: { _count: { select: { products: true } } } }>;

function toView(row: BrandRow): BrandView {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    productCount: row._count.products,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
