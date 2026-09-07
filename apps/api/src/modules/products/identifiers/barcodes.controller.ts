import { Body, Controller, Get, Post } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../../auth/auth.types';
import { Permission } from '../../auth/permissions';
import {
  BarcodeAuditReport,
  BarcodeAuditRow,
  BarcodeAuditService,
} from './barcode-audit.service';

export class ReissueBarcodesDto {
  /**
   * Explicit, always. There is deliberately no "reissue everything invalid"
   * call — this rewrites identifiers that may already be printed on something,
   * and the operator has to name the rows.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  variantIds!: string[];
}

/**
 * `/barcodes` — D104 Part 3, the audit and reissue pass (`5.9`).
 *
 * Sequenced BEFORE label rendering (`5.7`): an EAN-13 symbol cannot be produced
 * from a payload with a wrong check digit, so 18 of the pilot's 20 codes would
 * have failed at render time looking like a rendering bug.
 *
 * The read is `PRODUCT_READ` — anyone who can browse the catalogue may see that
 * it has a problem. The reissue is `PRODUCT_MANAGE`, because it rewrites
 * identifiers.
 */
@Controller('barcodes')
export class BarcodesController {
  constructor(private readonly audit: BarcodeAuditService) {}

  @Get('audit')
  @RequirePermissions(Permission.PRODUCT_READ)
  report(@TenantId() tenantId: string): Promise<BarcodeAuditReport> {
    return this.audit.report(tenantId);
  }

  @Post('reissue')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  reissue(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReissueBarcodesDto,
  ): Promise<{ reissued: BarcodeAuditRow[] }> {
    return this.audit
      .reissue(tenantId, dto.variantIds, user.id)
      .then((reissued) => ({ reissued }));
  }
}
