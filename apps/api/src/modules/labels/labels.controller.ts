import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { PrintLabelsDto } from './dto/print-labels.dto';
import { LabelsService } from './labels.service';
import type { RollProfile } from './roll-profiles';
import type { BuildZplResult } from './zpl.builder';

@Controller('labels')
export class LabelsController {
  constructor(private readonly labelsService: LabelsService) {}

  /** Roll geometry, so the client can draw a true-to-scale preview. */
  @Get('profiles')
  @RequirePermissions(Permission.PRODUCT_READ)
  profiles(): Array<RollProfile & { webWidthMm: number }> {
    return this.labelsService.listProfiles();
  }

  /**
   * Build the ZPL for a label batch. The browser relays the returned string to
   * Zebra Browser Print on the workstation — the API never talks to the printer
   * (it lives on the shop's LAN, not the internet).
   */
  @Post('zpl')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRODUCT_READ)
  zpl(@TenantId() tenantId: string, @Body() dto: PrintLabelsDto): Promise<BuildZplResult> {
    return this.labelsService.buildLabelZpl(tenantId, dto);
  }
}
