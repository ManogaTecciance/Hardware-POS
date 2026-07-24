import { Module } from '@nestjs/common';

import { QuickBooksModule } from '../quickbooks/quickbooks.module';
import { SuppliersController } from './suppliers.controller';
import { SuppliersImportService } from './suppliers-import.service';
import { SuppliersRepository } from './suppliers.repository';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [QuickBooksModule],
  controllers: [SuppliersController],
  providers: [SuppliersService, SuppliersRepository, SuppliersImportService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
