import { Module } from '@nestjs/common';

import { CustomersController } from './customers.controller';
import { CustomersImportService } from './customers-import.service';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomersRepository, CustomersImportService],
  exports: [CustomersService],
})
export class CustomersModule {}
