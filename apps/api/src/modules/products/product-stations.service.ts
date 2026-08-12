import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * D45 — Product ↔ KitchenStation attachments.
 *
 * KitchenStations are branch-scoped (each row carries `branchId`) but the
 * junction is intentionally not: a Product is a tenant-wide entity, and a
 * cross-branch KOT rule ("Pizzas always route to the Pizza station on every
 * branch that has one") is a common shape. The junction stores station IDs
 * from any branch in the tenant; `KitchenService` picks the one matching the
 * branch a round was submitted to at KOT generation time.
 */
export interface ProductStationView {
  id: string;
  branchId: string;
  code: string;
  name: string;
  category: string;
  isActive: boolean;
}

@Injectable()
export class ProductStationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, productId: string): Promise<ProductStationView[]> {
    await this.assertProduct(tenantId, productId);
    const rows = await this.prisma.productStationLink.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'asc' }],
      include: { station: true },
    });
    return rows.map((row) => ({
      id: row.station.id,
      branchId: row.station.branchId,
      code: row.station.code,
      name: row.station.name,
      category: row.station.category,
      isActive: row.station.isActive,
    }));
  }

  async replace(
    tenantId: string,
    productId: string,
    stationIds: string[],
  ): Promise<ProductStationView[]> {
    await this.assertProduct(tenantId, productId);

    const seen = new Set<string>();
    for (const id of stationIds) {
      if (seen.has(id)) {
        throw new BadRequestException(`Duplicate station id: ${id}`);
      }
      seen.add(id);
    }

    if (stationIds.length > 0) {
      const owned = await this.prisma.kitchenStation.findMany({
        where: { id: { in: stationIds }, tenantId },
        select: { id: true },
      });
      if (owned.length !== stationIds.length) {
        const foreign = stationIds.filter((id) => !owned.find((s) => s.id === id));
        throw new NotFoundException(
          `Kitchen station(s) not found in this tenant: ${foreign.join(', ')}`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.productStationLink.deleteMany({ where: { productId } }),
      ...(stationIds.length
        ? [
            this.prisma.productStationLink.createMany({
              data: stationIds.map((stationId) => ({ productId, stationId })),
            }),
          ]
        : []),
    ]);

    return this.list(tenantId, productId);
  }

  private async assertProduct(tenantId: string, productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
  }
}
