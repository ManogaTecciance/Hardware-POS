import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Data access for the tenant option library (D125 / D125a).
 *
 * The repository owns every `Prisma.*Args` shape, so the service reasons in
 * domain terms only — the same split the variants repository next door uses.
 */
@Injectable()
export class AttributeLibraryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every definition for a tenant, options in display order. */
  listDefinitions(tenantId: string) {
    return this.prisma.attributeDefinition.findMany({
      where: { tenantId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: {
        options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
        category: { select: { id: true, name: true } },
      },
    });
  }

  /** One definition, scoped to the tenant so a stray id cannot cross tenants. */
  findDefinition(tenantId: string, definitionId: string) {
    return this.prisma.attributeDefinition.findFirst({
      where: { id: definitionId, tenantId },
      include: {
        options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
        category: { select: { id: true, name: true } },
      },
    });
  }

  /** Category row scoped to tenant, or `null` — used to refuse a foreign id. */
  findCategoryForTenant(tenantId: string, categoryId: string) {
    return this.prisma.productCategory.findFirst({
      where: { id: categoryId, tenantId },
      select: { id: true },
    });
  }

  createDefinition(
    tenantId: string,
    data: {
      name: string;
      position: number;
      categoryId: string | null;
      options: Array<{ code: string; name: string; position: number; swatchHex: string | null }>;
    },
  ) {
    return this.prisma.attributeDefinition.create({
      data: {
        tenantId,
        name: data.name,
        position: data.position,
        categoryId: data.categoryId,
        options: {
          create: data.options.map((o) => ({
            tenantId,
            code: o.code,
            name: o.name,
            position: o.position,
            swatchHex: o.swatchHex,
          })),
        },
      },
      include: {
        options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
        category: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * How many product-level rows point at this definition or its options.
   *
   * Read before a destructive change so the refusal can name a number, not just
   * say "in use". The links are `SET NULL` at the database, so an unguarded
   * delete would not error — it would quietly unmap every product that had
   * adopted the scale, which is the silent-damage case this exists to prevent.
   */
  async countLinks(definitionId: string): Promise<{ dimensions: number; options: number }> {
    const [dimensions, options] = await Promise.all([
      this.prisma.productVariationDimension.count({ where: { attributeDefinitionId: definitionId } }),
      this.prisma.productVariationOption.count({
        where: { attributeOption: { definitionId } },
      }),
    ]);
    return { dimensions, options };
  }

  /** Product options bound to a specific library option. */
  countOptionLinks(attributeOptionId: string): Promise<number> {
    return this.prisma.productVariationOption.count({ where: { attributeOptionId } });
  }

  /**
   * Replace a definition's option set inside one transaction.
   *
   * `keepCodes` are the codes surviving from the payload; anything else is
   * pruned. The caller has already refused the prune when a product option
   * points at it, so by the time this runs the deletes are known to be safe.
   */
  replaceOptions(
    tenantId: string,
    definitionId: string,
    options: Array<{ code: string; name: string; position: number; swatchHex: string | null }>,
    removeOptionIds: string[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (removeOptionIds.length > 0) {
        await tx.attributeOption.deleteMany({ where: { id: { in: removeOptionIds } } });
      }
      for (const o of options) {
        await tx.attributeOption.upsert({
          where: { definitionId_code: { definitionId, code: o.code } },
          create: {
            tenantId,
            definitionId,
            code: o.code,
            name: o.name,
            position: o.position,
            swatchHex: o.swatchHex,
          },
          update: { name: o.name, position: o.position, swatchHex: o.swatchHex },
        });
      }
    });
  }

  updateDefinition(
    definitionId: string,
    data: { name?: string; position?: number; categoryId?: string | null },
  ) {
    return this.prisma.attributeDefinition.update({
      where: { id: definitionId },
      data,
      include: {
        options: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
        category: { select: { id: true, name: true } },
      },
    });
  }

  deleteDefinition(definitionId: string) {
    return this.prisma.attributeDefinition.delete({ where: { id: definitionId } });
  }

  /** Prisma's unique-violation code, for turning a race into a clean 409. */
  static isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}
