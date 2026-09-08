import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProfileService } from '../platform/business-profile.service';

/**
 * D65 — a product's recipe (`ProductComponent`, convergence plan §8.8).
 *
 * Replace-all semantics like the modifier-group junction: the wizard's
 * recipe card owns the whole list. Reads are open (an empty list is a true
 * answer for anyone); WRITES are refused for tenants whose domain does not
 * declare `capabilities.catalogue.components` — the same server-authority
 * rule every hidden control follows (D31: hiding is usability, refusal is
 * the server's).
 *
 * ONE level, no recursion (schema comment): a component that is itself
 * composed is legal to reference, but depletion will treat it as a product,
 * never expand its own recipe.
 */

export interface ProductComponentInput {
  componentProductId: string;
  quantity: number;
  unit?: string | null;
  wastageRate?: number;
}

export interface ProductComponentView {
  id: string;
  componentProductId: string;
  componentName: string;
  componentSku: string | null;
  quantity: string;
  unit: string | null;
  wastageRate: string;
}

@Injectable()
export class ProductComponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: BusinessProfileService,
  ) {}

  async list(tenantId: string, productId: string): Promise<ProductComponentView[]> {
    await this.requireProduct(tenantId, productId);
    const rows = await this.prisma.productComponent.findMany({
      where: { tenantId, productId },
      include: { componentProduct: { select: { name: true, sku: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      componentProductId: r.componentProductId,
      componentName: r.componentProduct.name,
      componentSku: r.componentProduct.sku,
      quantity: r.quantity.toString(),
      unit: r.unit,
      wastageRate: r.wastageRate.toString(),
    }));
  }

  async replace(
    tenantId: string,
    productId: string,
    inputs: ProductComponentInput[],
  ): Promise<ProductComponentView[]> {
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    if (!profile.capabilities.catalogue.components) {
      throw new ForbiddenException({
        code: 'COMPONENTS_NOT_ENABLED',
        message: 'Product components are not enabled for this business type.',
      });
    }
    await this.requireProduct(tenantId, productId);

    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.componentProductId === productId) {
        throw new BadRequestException('A product cannot be a component of itself.');
      }
      if (seen.has(input.componentProductId)) {
        throw new BadRequestException('Each component may appear only once.');
      }
      seen.add(input.componentProductId);
      if (!(input.quantity > 0)) {
        throw new BadRequestException('Component quantity must be greater than zero.');
      }
      const wastage = input.wastageRate ?? 0;
      if (wastage < 0 || wastage >= 1) {
        throw new BadRequestException('Wastage rate must be at least 0 and below 1.');
      }
    }

    // Every referenced component must be this tenant's product — a foreign id
    // matches zero rows and fails by count, leaking nothing.
    if (inputs.length > 0) {
      const found = await this.prisma.product.count({
        where: { id: { in: inputs.map((i) => i.componentProductId) }, tenantId },
      });
      if (found !== seen.size) {
        throw new NotFoundException('One or more component products were not found.');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productComponent.deleteMany({ where: { tenantId, productId } });
      for (const input of inputs) {
        await tx.productComponent.create({
          data: {
            tenantId,
            productId,
            componentProductId: input.componentProductId,
            quantity: new Prisma.Decimal(input.quantity),
            unit: input.unit ?? null,
            wastageRate: new Prisma.Decimal(input.wastageRate ?? 0),
          },
        });
      }
    });
    return this.list(tenantId, productId);
  }

  private async requireProduct(tenantId: string, productId: string): Promise<void> {
    const exists = await this.prisma.product.count({ where: { id: productId, tenantId } });
    if (exists === 0) throw new NotFoundException(`Product ${productId} not found`);
  }
}
