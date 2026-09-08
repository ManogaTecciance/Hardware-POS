import { Module } from '@nestjs/common';

import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';

/** Brands (D133). No provider dependency: a brand is catalogue data, not stock. */
@Module({
  controllers: [BrandsController],
  providers: [BrandsService],
  exports: [BrandsService],
})
export class BrandsModule {}
