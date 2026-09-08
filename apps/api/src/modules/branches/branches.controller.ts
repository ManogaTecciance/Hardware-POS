import { ModuleKey } from '@hardware-pos/database';
import { Controller, Get } from '@nestjs/common';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { BranchesService, BranchView } from './branches.service';

@Controller('branches')
// Slice 7.6 — enabled for every business profile; inert today, meaningful once switched off.
@RequireModule(ModuleKey.BRANCHES)
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  /** The tenant's active selling locations (any authenticated role). */
  @Get()
  list(@TenantId() tenantId: string): Promise<BranchView[]> {
    return this.branchesService.list(tenantId);
  }
}
