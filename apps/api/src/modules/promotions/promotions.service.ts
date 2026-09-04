import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BusinessProfileService } from '../platform/business-profile.service';
import {
  CreatePromotionDto,
  PROMOTION_TYPES,
  PromotionItemInputDto,
  PromotionTypeValue,
} from './dto/create-promotion.dto';
import { QueryPromotionsDto } from './dto/query-promotions.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { isPromotionActive } from './promotions.evaluator';
import { PromotionWithItems, PromotionsRepository } from './promotions.repository';

/** The vocabularies the DTO defers to the service. */
const VALID_DAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
/*
 * D56 — channels are NOT a fixed list here. This constant used to be
 * `['DINE_IN','TAKEAWAY','ONLINE']`, which made a retail promotion unsaveable:
 * 4.9 taught the editor to offer the channels the tenant actually sells on
 * (`COUNTER` for retail), and the server then rejected the only chip on screen
 * with "Unknown channel 'COUNTER'". The allowed set is the tenant's
 * `capabilities.fulfilment.channels`, read from the same resolver the chips use,
 * so the screen and the server can no longer disagree.
 *
 * This is strictly TIGHTER than a blanket four-value list: food service still
 * accepts exactly its three and nothing else, unchanged.
 */

/** Shape returned to controllers (JSON-friendly — Decimals stringified). */
export interface PromotionView {
  id: string;
  name: string;
  description: string | null;
  type: string;
  fixedPrice: string | null;
  percentageOff: string | null;
  amountOff: string | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  startsOn: string | null;
  endsOn: string | null;
  daysOfWeek: string[];
  startTime: string | null;
  endTime: string | null;
  branchScope: string[];
  channelScope: string[];
  stackable: boolean;
  isActive: boolean;
  items: { id: string; productId: string; productName: string | null; role: string; quantity: number }[];
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: PromotionsRepository,
    private readonly audit: AuditLogService,
    private readonly profiles: BusinessProfileService,
  ) {}

  async list(
    tenantId: string,
    query: QueryPromotionsDto,
    tenantTimeZone?: string,
  ): Promise<{ items: PromotionView[]; total: number }> {
    const isActive =
      query.isActive === undefined ? undefined : query.isActive === 'true';
    const onlyValid = query.onlyCurrentlyValid === 'true';

    // We fetch the repository slice unfiltered by validity (the evaluator
    // needs the row to decide), then narrow client-side. `limit`/`offset` are
    // applied by the repository so a caller browsing hundreds of promotions
    // pages correctly; total counts include what the DB filter matched, not
    // the additional evaluator cut, since validity is transient.
    const items = await this.repository.list(tenantId, {
      isActive,
      productId: query.productId,
      branchId: query.branchId,
      channel: query.channel,
      limit: query.limit,
      offset: query.offset,
    });

    const now = new Date();
    const filtered = onlyValid
      ? items.filter((p) =>
          isPromotionActive(p, {
            now,
            branchId: query.branchId,
            channel: query.channel,
            tenantTimeZone,
          }),
        )
      : items;

    return { items: filtered.map(toView), total: filtered.length };
  }

  async getById(tenantId: string, id: string): Promise<PromotionView> {
    const row = await this.repository.findById(tenantId, id);
    if (!row) throw new NotFoundException(`Promotion ${id} not found`);
    return toView(row);
  }

  async create(
    tenantId: string,
    actorId: string | undefined,
    dto: CreatePromotionDto,
  ): Promise<PromotionView> {
    this.validateTypeShape(dto.type, dto, dto.items);
    this.validateScheduleVocabulary(dto);
    await this.assertChannelsSellable(tenantId, dto.channelScope);
    await this.assertScope(tenantId, dto.branchScope);
    await this.assertProductsInTenant(tenantId, dto.items.map((i) => i.productId));

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const promo = await tx.promotion.create({
          data: {
            tenantId,
            name: dto.name,
            description: dto.description ?? null,
            type: dto.type,
            fixedPrice: dto.fixedPrice != null ? new Prisma.Decimal(dto.fixedPrice) : null,
            percentageOff:
              dto.percentageOff != null ? new Prisma.Decimal(dto.percentageOff) : null,
            amountOff: dto.amountOff != null ? new Prisma.Decimal(dto.amountOff) : null,
            buyQuantity: dto.buyQuantity ?? null,
            getQuantity: dto.getQuantity ?? null,
            startsOn: dto.startsOn ? new Date(dto.startsOn) : null,
            endsOn: dto.endsOn ? new Date(dto.endsOn) : null,
            daysOfWeek: dto.daysOfWeek ?? [],
            startTime: dto.startTime ?? null,
            endTime: dto.endTime ?? null,
            branchScope: dto.branchScope ?? [],
            channelScope: dto.channelScope ?? [],
            stackable: dto.stackable ?? false,
          },
        });
        await tx.promotionItem.createMany({
          data: dto.items.map((item) => ({
            promotionId: promo.id,
            productId: item.productId,
            role: item.role,
            quantity: item.quantity ?? 1,
          })),
        });
        return promo.id;
      });

      const view = await this.getById(tenantId, created);
      await this.audit.record(tenantId, {
        userId: actorId,
        action: 'PROMOTION_CREATED',
        entityType: 'Promotion',
        entityId: view.id,
        metadata: { name: view.name, type: view.type, itemCount: view.items.length },
      });
      return view;
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async update(
    tenantId: string,
    actorId: string | undefined,
    id: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionView> {
    const existing = await this.repository.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Promotion ${id} not found`);

    // A caller cannot silently swap type via update — the DTO does not carry
    // it, but a hand-crafted body could. Reject any attempt loudly so the
    // client sees the reason and switches to the delete + recreate flow.
    if ((dto as unknown as { type?: string }).type !== undefined) {
      throw new BadRequestException(
        'Promotion type cannot be changed; delete and recreate to change type.',
      );
    }

    // Re-run all cross-field checks against the MERGED state so a partial
    // update cannot leave the row in an incoherent shape (e.g. patching only
    // `getQuantity` on a BUY_X_GET_Y and leaving `buyQuantity` NULL).
    const merged = mergeForValidation(existing, dto);
    this.validateTypeShape(existing.type as PromotionTypeValue, merged.data, merged.items);
    this.validateScheduleVocabulary(dto);
    await this.assertChannelsSellable(tenantId, dto.channelScope);
    if (dto.branchScope) await this.assertScope(tenantId, dto.branchScope);
    if (dto.items) {
      await this.assertProductsInTenant(
        tenantId,
        dto.items.map((i) => i.productId),
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.promotion.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            fixedPrice: dto.fixedPrice != null ? new Prisma.Decimal(dto.fixedPrice) : dto.fixedPrice,
            percentageOff:
              dto.percentageOff != null
                ? new Prisma.Decimal(dto.percentageOff)
                : dto.percentageOff,
            amountOff: dto.amountOff != null ? new Prisma.Decimal(dto.amountOff) : dto.amountOff,
            buyQuantity: dto.buyQuantity,
            getQuantity: dto.getQuantity,
            startsOn: dto.startsOn === undefined ? undefined : dto.startsOn ? new Date(dto.startsOn) : null,
            endsOn: dto.endsOn === undefined ? undefined : dto.endsOn ? new Date(dto.endsOn) : null,
            daysOfWeek: dto.daysOfWeek,
            startTime: dto.startTime,
            endTime: dto.endTime,
            branchScope: dto.branchScope,
            channelScope: dto.channelScope,
            stackable: dto.stackable,
            isActive: dto.isActive,
          },
        });

        if (dto.items) {
          // Replace-semantics for the item set — the `@@unique([promotionId,
          // productId, role])` index makes an in-place merge fragile, and the
          // wizard sends the desired final shape anyway.
          await tx.promotionItem.deleteMany({ where: { promotionId: id } });
          await tx.promotionItem.createMany({
            data: dto.items.map((item) => ({
              promotionId: id,
              productId: item.productId,
              role: item.role,
              quantity: item.quantity ?? 1,
            })),
          });
        }
      });

      const view = await this.getById(tenantId, id);
      await this.audit.record(tenantId, {
        userId: actorId,
        action: 'PROMOTION_UPDATED',
        entityType: 'Promotion',
        entityId: id,
        metadata: { name: view.name, isActive: view.isActive },
      });
      return view;
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async setActive(
    tenantId: string,
    actorId: string | undefined,
    id: string,
    isActive: boolean,
  ): Promise<PromotionView> {
    await this.getById(tenantId, id);
    await this.prisma.promotion.update({ where: { id }, data: { isActive } });
    const view = await this.getById(tenantId, id);
    await this.audit.record(tenantId, {
      userId: actorId,
      action: isActive ? 'PROMOTION_ACTIVATED' : 'PROMOTION_DEACTIVATED',
      entityType: 'Promotion',
      entityId: id,
      metadata: { name: view.name },
    });
    return view;
  }

  async delete(
    tenantId: string,
    actorId: string | undefined,
    id: string,
  ): Promise<{ id: string }> {
    const existing = await this.getById(tenantId, id);
    // PromotionItem carries `onDelete: Cascade`; a single row delete is fine.
    await this.prisma.promotion.delete({ where: { id } });
    await this.audit.record(tenantId, {
      userId: actorId,
      action: 'PROMOTION_DELETED',
      entityType: 'Promotion',
      entityId: id,
      metadata: { name: existing.name, type: existing.type },
    });
    return { id };
  }

  // ── Shared validation helpers ────────────────────────────────────────────

  private validateTypeShape(
    type: PromotionTypeValue,
    data: {
      fixedPrice?: number | null;
      percentageOff?: number | null;
      amountOff?: number | null;
      buyQuantity?: number | null;
      getQuantity?: number | null;
    },
    items: PromotionItemInputDto[] | { role: string; quantity?: number }[],
  ): void {
    if (!PROMOTION_TYPES.includes(type as PromotionTypeValue)) {
      throw new BadRequestException(`Unknown promotion type: ${type}`);
    }

    const roles = items.map((i) => i.role);
    const buys = roles.filter((r) => r === 'BUY').length;
    const gets = roles.filter((r) => r === 'GET').length;
    const bundles = roles.filter((r) => r === 'BUNDLE').length;

    switch (type) {
      case 'BUNDLE_FIXED_PRICE': {
        if (data.fixedPrice == null || data.fixedPrice <= 0) {
          throw new BadRequestException(
            'BUNDLE_FIXED_PRICE requires a positive fixedPrice.',
          );
        }
        if (bundles < 2) {
          throw new BadRequestException(
            'BUNDLE_FIXED_PRICE requires at least two BUNDLE items.',
          );
        }
        break;
      }
      case 'BUY_X_GET_Y': {
        if (data.buyQuantity == null || data.buyQuantity < 1) {
          throw new BadRequestException('BUY_X_GET_Y requires buyQuantity ≥ 1.');
        }
        if (data.getQuantity == null || data.getQuantity < 1) {
          throw new BadRequestException('BUY_X_GET_Y requires getQuantity ≥ 1.');
        }
        if (buys !== 1) {
          throw new BadRequestException('BUY_X_GET_Y requires exactly one BUY item.');
        }
        if (gets < 1) {
          throw new BadRequestException('BUY_X_GET_Y requires at least one GET item.');
        }
        if (data.percentageOff == null) {
          throw new BadRequestException(
            'BUY_X_GET_Y requires percentageOff between 0 and 100 (100 = free reward).',
          );
        }
        if (data.percentageOff < 0 || data.percentageOff > 100) {
          throw new BadRequestException('BUY_X_GET_Y percentageOff must be between 0 and 100.');
        }
        break;
      }
      case 'PERCENTAGE_DISCOUNT': {
        if (data.percentageOff == null || data.percentageOff <= 0 || data.percentageOff > 100) {
          throw new BadRequestException(
            'PERCENTAGE_DISCOUNT requires percentageOff in the (0, 100] range.',
          );
        }
        if (buys < 1) {
          throw new BadRequestException(
            'PERCENTAGE_DISCOUNT requires at least one BUY item.',
          );
        }
        break;
      }
      case 'FIXED_AMOUNT_DISCOUNT': {
        if (data.amountOff == null || data.amountOff <= 0) {
          throw new BadRequestException(
            'FIXED_AMOUNT_DISCOUNT requires a positive amountOff.',
          );
        }
        if (buys < 1) {
          throw new BadRequestException(
            'FIXED_AMOUNT_DISCOUNT requires at least one BUY item.',
          );
        }
        break;
      }
    }
  }

  /**
   * D56 — a promotion may only be scoped to a channel this tenant sells on.
   *
   * Async, and therefore separate from `validateScheduleVocabulary` (which stays
   * sync for days and times): the allowed set comes from the effective business
   * profile, not from a constant.
   */
  private async assertChannelsSellable(
    tenantId: string,
    channelScope: string[] | undefined,
  ): Promise<void> {
    if (!channelScope || channelScope.length === 0) return;
    const profile = await this.profiles.getEffectiveProfile(tenantId);
    const allowed = profile.capabilities.fulfilment.channels as readonly string[];
    for (const c of channelScope) {
      if (!allowed.includes(c)) {
        throw new BadRequestException(
          `Unknown channel '${c}'; expected one of ${allowed.join(', ')}.`,
        );
      }
    }
  }

  private validateScheduleVocabulary(
    dto: Partial<Pick<CreatePromotionDto, 'daysOfWeek' | 'channelScope' | 'startTime' | 'endTime'>>,
  ): void {
    if (dto.daysOfWeek) {
      for (const d of dto.daysOfWeek) {
        if (!VALID_DAYS.has(d)) {
          throw new BadRequestException(
            `Unknown day-of-week '${d}'; expected one of ${[...VALID_DAYS].join(', ')}.`,
          );
        }
      }
    }
    // both-null-or-both-set for the time-of-day pair. Half-open is nonsensical
    // for scheduling ("open until 22:00 with no lower bound" is legal per the
    // evaluator, but the wizard shouldn't be able to save that shape).
    const timeGiven = (v: string | undefined) => v !== undefined && v !== null && v !== '';
    if (timeGiven(dto.startTime) !== timeGiven(dto.endTime)) {
      throw new BadRequestException(
        'startTime and endTime must both be provided or both omitted.',
      );
    }
  }

  private async assertScope(tenantId: string, branchScope: string[] | undefined): Promise<void> {
    if (!branchScope || branchScope.length === 0) return;
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: branchScope }, tenantId },
      select: { id: true },
    });
    if (branches.length !== branchScope.length) {
      const missing = branchScope.filter((id) => !branches.find((b) => b.id === id));
      throw new BadRequestException(
        `Branch scope references branches outside this tenant: ${missing.join(', ')}`,
      );
    }
  }

  private async assertProductsInTenant(
    tenantId: string,
    productIds: string[],
  ): Promise<void> {
    if (productIds.length === 0) return;
    const rows = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true },
    });
    if (rows.length !== new Set(productIds).size) {
      const missing = [...new Set(productIds)].filter((id) => !rows.find((r) => r.id === id));
      // 404 rather than 400 — the caller's ProductId is unknown to this tenant.
      throw new NotFoundException(
        `Product(s) not found in this tenant: ${missing.join(', ')}`,
      );
    }
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      if (target.includes('name')) {
        return new BadRequestException('A promotion with this name already exists');
      }
      if (target.includes('promotionId')) {
        return new BadRequestException(
          'The same product cannot appear twice in the same role on one promotion.',
        );
      }
    }
    return err instanceof Error ? err : new BadRequestException('Could not save promotion');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toView(row: PromotionWithItems): PromotionView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    fixedPrice: row.fixedPrice ? row.fixedPrice.toFixed(2) : null,
    percentageOff: row.percentageOff ? row.percentageOff.toFixed(2) : null,
    amountOff: row.amountOff ? row.amountOff.toFixed(2) : null,
    buyQuantity: row.buyQuantity,
    getQuantity: row.getQuantity,
    startsOn: row.startsOn ? row.startsOn.toISOString() : null,
    endsOn: row.endsOn ? row.endsOn.toISOString() : null,
    daysOfWeek: row.daysOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    branchScope: row.branchScope,
    channelScope: row.channelScope,
    stackable: row.stackable,
    isActive: row.isActive,
    // D45 (4.10) — flatten the joined name so the editor never has to render a
    // cuid. Null when the product was deleted; the client falls back to the id.
    items: row.items.map((it) => ({
      id: it.id,
      productId: it.productId,
      productName: it.product?.name ?? null,
      role: it.role,
      quantity: it.quantity,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Merge the existing row with a PATCH payload for validation. The service
 * only ever needs the fields that participate in type-shape checks; anything
 * beyond that stays on the row and isn't re-verified.
 */
function mergeForValidation(
  existing: PromotionWithItems,
  dto: UpdatePromotionDto,
): {
  data: {
    fixedPrice: number | null;
    percentageOff: number | null;
    amountOff: number | null;
    buyQuantity: number | null;
    getQuantity: number | null;
  };
  items: { role: string; quantity: number; productId: string }[];
} {
  const num = (v: Prisma.Decimal | null | undefined): number | null =>
    v == null ? null : Number(v);
  return {
    data: {
      fixedPrice: dto.fixedPrice ?? num(existing.fixedPrice),
      percentageOff: dto.percentageOff ?? num(existing.percentageOff),
      amountOff: dto.amountOff ?? num(existing.amountOff),
      buyQuantity: dto.buyQuantity ?? existing.buyQuantity,
      getQuantity: dto.getQuantity ?? existing.getQuantity,
    },
    items: dto.items
      ? dto.items.map((i) => ({
          role: i.role,
          quantity: i.quantity ?? 1,
          productId: i.productId,
        }))
      : existing.items,
  };
}
