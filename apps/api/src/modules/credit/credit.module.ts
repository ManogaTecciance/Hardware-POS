import { Module } from '@nestjs/common';

import { CreditService } from './credit.service';

/**
 * Customer credit position, shared by the sales guard, the customers list and the
 * dashboard so all three quote the same number.
 */
@Module({
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
