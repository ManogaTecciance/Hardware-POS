import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PrintLabelsDto } from './dto/print-labels.dto';
import {
  DEFAULT_DPI,
  getRollProfile,
  MAX_PRINT_WIDTH_MM,
  ROLL_PROFILES,
  webWidthMm,
  type RollProfile,
} from './roll-profiles';
import { buildZpl, type BuildZplResult, type LabelItem } from './zpl.builder';

@Injectable()
export class LabelsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Roll geometry the client needs to render its preview. */
  listProfiles(): Array<RollProfile & { webWidthMm: number }> {
    return Object.values(ROLL_PROFILES).map((profile) => ({
      ...profile,
      webWidthMm: webWidthMm(profile),
    }));
  }

  async buildLabelZpl(tenantId: string, dto: PrintLabelsDto): Promise<BuildZplResult> {
    const profile = getRollProfile(dto.roll);
    const dpi = dto.dpi ?? DEFAULT_DPI;

    // Catch impossible geometry before it silently prints off the edge.
    const width = webWidthMm(profile);
    if (width > MAX_PRINT_WIDTH_MM) {
      throw new BadRequestException(
        `The ${profile.label} roll needs ${width.toFixed(1)}mm of media, which exceeds the ` +
          `printer's ${MAX_PRINT_WIDTH_MM}mm maximum print width.`,
      );
    }

    const ids = [...new Set(dto.lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, tenantId },
      select: { id: true, name: true, sku: true, unitPrice: true },
    });
    if (products.length === 0) {
      throw new BadRequestException('None of the selected products exist');
    }
    const byId = new Map(products.map((p) => [p.id, p]));

    const items: LabelItem[] = [];
    for (const line of dto.lines) {
      const product = byId.get(line.productId);
      if (!product) continue; // tenant-scoped lookup already filtered it out
      items.push({
        name: product.name,
        sku: product.sku,
        price: product.unitPrice == null ? null : Number(product.unitPrice),
        copies: line.copies,
      });
    }

    const result = buildZpl(items, {
      profile,
      dpi,
      darkness: dto.darkness,
      qr: dto.qr,
      startOffset: dto.startOffset,
    });

    if (result.stickerCount === 0) {
      throw new BadRequestException(
        'Nothing to print — the selected products have no SKU to encode as a barcode.',
      );
    }
    return result;
  }
}
