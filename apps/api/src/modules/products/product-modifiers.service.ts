import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * D45 — Product ↔ ModifierGroup attachments.
 *
 * The service is the tenant-scoped façade over `ProductModifierGroup`. It
 * intentionally does NOT reach into `ModifiersService` in `modules/menu/`: the
 * modifier-group catalogue itself is owned there, and this file only cares
 * about which of those groups a Product is wired to. Reads go through Prisma
 * `include` to keep the payload one query, matching what the wizard reopens
 * with in a single fetch.
 */
export interface ProductModifierOptionView {
  id: string;
  name: string;
  priceDelta: string;
  position: number;
  isActive: boolean;
}

export interface ProductModifierGroupView {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  role: string | null;
  /** Position of this group *on the product* (not in the tenant catalogue). */
  position: number;
  options: ProductModifierOptionView[];
}

@Injectable()
export class ProductModifiersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, productId: string): Promise<ProductModifierGroupView[]> {
    await this.assertProduct(tenantId, productId);
    const rows = await this.prisma.productModifierGroup.findMany({
      where: { productId },
      orderBy: [{ position: 'asc' }],
      include: {
        modifierGroup: {
          include: {
            options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.modifierGroup.id,
      name: row.modifierGroup.name,
      selection: row.modifierGroup.selection,
      minSelections: row.modifierGroup.minSelections,
      maxSelections: row.modifierGroup.maxSelections,
      role: row.modifierGroup.role,
      position: row.position,
      options: row.modifierGroup.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceDelta: o.priceDelta.toFixed(2),
        position: o.position,
        isActive: o.isActive,
      })),
    }));
  }

  /**
   * Replace-semantics: caller sends the desired set (ordered), the junction is
   * wiped and rewritten inside one transaction. `position` = array index so a
   * reorder is one call. Cross-tenant IDs are rejected before any write.
   */
  async replace(
    tenantId: string,
    productId: string,
    modifierGroupIds: string[],
  ): Promise<ProductModifierGroupView[]> {
    await this.assertProduct(tenantId, productId);

    // Empty is legal (detach everything). Guard duplicates first — the unique
    // `(productId, modifierGroupId)` index would surface as an opaque P2002.
    const seen = new Set<string>();
    for (const id of modifierGroupIds) {
      if (seen.has(id)) {
        throw new BadRequestException(`Duplicate modifier group id: ${id}`);
      }
      seen.add(id);
    }

    if (modifierGroupIds.length > 0) {
      const owned = await this.prisma.modifierGroup.findMany({
        where: { id: { in: modifierGroupIds }, tenantId },
        select: { id: true },
      });
      if (owned.length !== modifierGroupIds.length) {
        const foreign = modifierGroupIds.filter(
          (id) => !owned.find((g) => g.id === id),
        );
        throw new NotFoundException(
          `Modifier group(s) not found in this tenant: ${foreign.join(', ')}`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.productModifierGroup.deleteMany({ where: { productId } }),
      ...(modifierGroupIds.length
        ? [
            this.prisma.productModifierGroup.createMany({
              data: modifierGroupIds.map((modifierGroupId, i) => ({
                productId,
                modifierGroupId,
                position: i,
              })),
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
