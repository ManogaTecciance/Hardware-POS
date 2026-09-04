import { Module } from '@nestjs/common';

import { CreditModule } from '../credit/credit.module';
import { QuickBooksModule } from '../quickbooks/quickbooks.module';
import { CustomersController } from './customers.controller';
import { CustomersImportService } from './customers-import.service';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  imports: [QuickBooksModule, CreditModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersRepository, CustomersImportService],
  exports: [CustomersService],
})
export class CustomersModule {}
