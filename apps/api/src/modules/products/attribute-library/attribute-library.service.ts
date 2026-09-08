import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { attributeCodeIssue, isValidSwatchHex, normaliseAttributeCode, normaliseSwatchHex } from '@hardware-pos/shared';

import { AttributeLibraryRepository } from './attribute-library.repository';
import {
  AttributeOptionInputDto,
  CreateAttributeDefinitionDto,
  UpdateAttributeDefinitionDto,
} from './dto/attribute-library.dto';

export interface AttributeOptionView {
  id: string;
  code: string;
  name: string;
  position: number;
  swatchHex: string | null;
}

export interface AttributeDefinitionView {
  id: string;
  name: string;
  position: number;
  categoryId: string | null;
  categoryName: string | null;
  options: AttributeOptionView[];
  /** How many product dimensions currently point at this definition. */
  linkedDimensionCount: number;
}

interface NormalisedOption {
  code: string;
  name: string;
  position: number;
  swatchHex: string | null;
}

/**
 * D125 / D125a — the tenant option library.
 *
 * The library is a vocabulary, not a rule. It exists so that `Colour :: Black`
 * means the same thing on every product that adopts it, which is what makes a
 * stable SKU segment possible in `5.3`. It does not decide what a product may
 * sell: a product's own `ProductVariationDimension` rows still own its
 * variations, and a dimension with no link keeps working exactly as it did
 * before this table existed (D28/D31 — unresolved is its own state).
 *
 * Nothing here merges `Colour` into `Color`. That judgement belongs to an
 * operator looking at their own catalogue, which is why D125 kept the link
 * columns nullable and the mapping a UI task.
 */
@Injectable()
export class AttributeLibraryService {
  constructor(private readonly repo: AttributeLibraryRepository) {}

  async list(tenantId: string): Promise<AttributeDefinitionView[]> {
    const rows = await this.repo.listDefinitions(tenantId);
    const views = await Promise.all(
      rows.map(async (row) => {
        const links = await this.repo.countLinks(row.id);
        return this.toView(row, links.dimensions);
      }),
    );
    return views;
  }

  async get(tenantId: string, definitionId: string): Promise<AttributeDefinitionView> {
    const row = await this.requireDefinition(tenantId, definitionId);
    const links = await this.repo.countLinks(definitionId);
    return this.toView(row, links.dimensions);
  }

  async create(
    tenantId: string,
    dto: CreateAttributeDefinitionDto,
  ): Promise<AttributeDefinitionView> {
    const name = dto.name.trim();
    const categoryId = await this.resolveCategory(tenantId, dto.categoryId ?? null);
    const options = this.normaliseOptions(dto.options);

    try {
      const row = await this.repo.createDefinition(tenantId, {
        name,
        position: dto.position ?? 0,
        categoryId,
        options,
      });
      return this.toView(row, 0);
    } catch (err) {
      if (AttributeLibraryRepository.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'ATTRIBUTE_DEFINITION_EXISTS',
          message: `An attribute named "${name}" already exists for this tenant.`,
        });
      }
      throw err;
    }
  }

  async update(
    tenantId: string,
    definitionId: string,
    dto: UpdateAttributeDefinitionDto,
  ): Promise<AttributeDefinitionView> {
    const existing = await this.requireDefinition(tenantId, definitionId);

    if (dto.options) {
      const options = this.normaliseOptions(dto.options);
      const keep = new Set(options.map((o) => o.code));
      const removing = existing.options.filter((o) => !keep.has(o.code));

      // Refuse the prune BEFORE writing anything. The FK is SET NULL, so an
      // unguarded delete would succeed and silently unmap every product option
      // that had adopted this value — damage with no error to notice.
      for (const option of removing) {
        const inUse = await this.repo.countOptionLinks(option.id);
        if (inUse > 0) {
          throw new ConflictException({
            code: 'ATTRIBUTE_OPTION_IN_USE',
            message: `Option "${option.name}" (${option.code}) is used by ${inUse} product option(s) and cannot be removed. Unmap it from those products first.`,
          });
        }
      }

      try {
        await this.repo.replaceOptions(
          tenantId,
          definitionId,
          options,
          removing.map((o) => o.id),
        );
      } catch (err) {
        if (AttributeLibraryRepository.isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'ATTRIBUTE_OPTION_DUPLICATE',
            message: 'Two options in this attribute would share a code or a name.',
          });
        }
        throw err;
      }
    }

    const categoryId =
      dto.categoryId === undefined
        ? undefined
        : await this.resolveCategory(tenantId, dto.categoryId ?? null);

    try {
      const row = await this.repo.updateDefinition(definitionId, {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.position === undefined ? {} : { position: dto.position }),
        ...(categoryId === undefined ? {} : { categoryId }),
      });
      const links = await this.repo.countLinks(definitionId);
      return this.toView(row, links.dimensions);
    } catch (err) {
      if (AttributeLibraryRepository.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'ATTRIBUTE_DEFINITION_EXISTS',
          message: `An attribute named "${dto.name?.trim()}" already exists for this tenant.`,
        });
      }
      throw err;
    }
  }

  /**
   * Delete a definition, refusing while any product still points at it.
   *
   * The database would allow this — every link is `ON DELETE SET NULL`, chosen
   * so that retiring a definition can never destroy a product's own dimension.
   * That protection is exactly why the service has to refuse here: without the
   * guard the operator gets a success and a catalogue that quietly forgot its
   * mapping.
   */
  async remove(tenantId: string, definitionId: string): Promise<void> {
    await this.requireDefinition(tenantId, definitionId);
    const links = await this.repo.countLinks(definitionId);
    if (links.dimensions > 0 || links.options > 0) {
      throw new ConflictException({
        code: 'ATTRIBUTE_DEFINITION_IN_USE',
        message: `This attribute is mapped to ${links.dimensions} product dimension(s) and ${links.options} product option(s). Unmap them before deleting it.`,
      });
    }
    await this.repo.deleteDefinition(definitionId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async requireDefinition(tenantId: string, definitionId: string) {
    const row = await this.repo.findDefinition(tenantId, definitionId);
    if (!row) {
      throw new NotFoundException({
        code: 'ATTRIBUTE_DEFINITION_NOT_FOUND',
        message: 'Attribute not found.',
      });
    }
    return row;
  }

  /** Refuse a category id from another tenant rather than storing it. */
  private async resolveCategory(tenantId: string, categoryId: string | null): Promise<string | null> {
    if (categoryId === null || categoryId === '') return null;
    const category = await this.repo.findCategoryForTenant(tenantId, categoryId);
    if (!category) {
      throw new BadRequestException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'That category does not belong to this tenant.',
      });
    }
    return category.id;
  }

  /**
   * Normalise and validate an incoming option set.
   *
   * Codes are normalised first and checked afterwards, so `black` and `BLACK`
   * are the same code rather than two rows that generate the same SKU segment.
   * Duplicates are caught here rather than left to the unique index, because a
   * `P2002` cannot say *which* pair collided.
   */
  private normaliseOptions(inputs: AttributeOptionInputDto[]): NormalisedOption[] {
    const seenCodes = new Map<string, string>();
    const seenNames = new Map<string, string>();

    return inputs.map((input, index) => {
      const code = normaliseAttributeCode(input.code);
      const issue = attributeCodeIssue(code);
      if (issue) {
        throw new BadRequestException({
          code: 'ATTRIBUTE_CODE_INVALID',
          message: `Code "${input.code}" is not usable: ${issue}`,
        });
      }

      const name = input.name.trim();
      if (name.length === 0) {
        throw new BadRequestException({
          code: 'ATTRIBUTE_OPTION_NAME_REQUIRED',
          message: 'Every option needs a name.',
        });
      }

      const priorCode = seenCodes.get(code);
      if (priorCode) {
        throw new BadRequestException({
          code: 'ATTRIBUTE_OPTION_DUPLICATE',
          message: `"${priorCode}" and "${name}" both normalise to the code ${code}.`,
        });
      }
      seenCodes.set(code, name);

      const nameKey = name.toLowerCase();
      const priorName = seenNames.get(nameKey);
      if (priorName) {
        throw new BadRequestException({
          code: 'ATTRIBUTE_OPTION_DUPLICATE',
          message: `"${name}" is listed twice.`,
        });
      }
      seenNames.set(nameKey, name);

      return {
        code,
        name,
        position: input.position ?? index,
        swatchHex: this.normaliseSwatch(input.swatchHex ?? null),
      };
    });
  }

  private normaliseSwatch(raw: string | null): string | null {
    if (raw === null || raw.trim() === '') return null;
    const normalised = normaliseSwatchHex(raw);
    if (normalised === null || !isValidSwatchHex(normalised)) {
      throw new BadRequestException({
        code: 'ATTRIBUTE_SWATCH_INVALID',
        message: `"${raw}" is not a colour. Use #RRGGBB, for example #1A1A1A.`,
      });
    }
    return normalised;
  }

  private toView(
    row: {
      id: string;
      name: string;
      position: number;
      categoryId: string | null;
      category: { id: string; name: string } | null;
      options: Array<{
        id: string;
        code: string;
        name: string;
        position: number;
        swatchHex: string | null;
      }>;
    },
    linkedDimensionCount: number,
  ): AttributeDefinitionView {
    return {
      id: row.id,
      name: row.name,
      position: row.position,
      categoryId: row.categoryId,
      categoryName: row.category?.name ?? null,
      options: row.options.map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        position: o.position,
        swatchHex: o.swatchHex,
      })),
      linkedDimensionCount,
    };
  }
}
