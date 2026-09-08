import { Body, Controller, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../../auth/auth.types';
import { Permission } from '../../auth/permissions';
import { LabelPrintService, type LabelSheet } from './label-print.service';

export class LabelRequestDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  /** Copies of THIS variant's label — twelve mediums, three extra-larges. */
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  quantity?: number;
}

export class PrintLabelsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => LabelRequestDto)
  labels!: LabelRequestDto[];

  /** Copies of the whole SHEET, distinct from per-variant quantity. */
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  copies?: number;
}

/**
 * `/labels` — Phase 5 `5.7`.
 *
 * Two endpoints rather than one: `preview` returns the HTML for the operator to
 * look at, `print` queues it. Printing is the irreversible half — paper comes
 * out of a machine — so it is a deliberate second action, and both report which
 * variants could not be drawn rather than quietly omitting them.
 *
 * Both require `PRODUCT_MANAGE`: a label sheet is a catalogue operation, and
 * the barcode it carries is an identifier the shop is committing to.
 */
@Controller('labels')
export class LabelsController {
  constructor(private readonly labels: LabelPrintService) {}

  @Post('preview')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  preview(@TenantId() tenantId: string, @Body() dto: PrintLabelsDto): Promise<LabelSheet> {
    return this.labels.renderSheet(
      tenantId,
      dto.labels.map((l) => ({ variantId: l.variantId, quantity: l.quantity ?? 1 })),
    );
  }

  @Post('print')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  print(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PrintLabelsDto,
  ) {
    return this.labels.queueSheet(
      tenantId,
      dto.labels.map((l) => ({ variantId: l.variantId, quantity: l.quantity ?? 1 })),
      user.id,
      dto.copies ?? 1,
    );
  }
}
