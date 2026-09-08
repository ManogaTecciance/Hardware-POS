import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { MenuItemImagesController } from './menu-item-images.controller';
import { MenuItemsController } from './menu-items.controller';
import { MenuItemsService } from './menu-items.service';
import { MenuSectionsController } from './menu-sections.controller';
import { MenuService } from './menu.service';
import { MenusController } from './menus.controller';
import { ModifiersController } from './modifiers.controller';
import { ModifiersService } from './modifiers.service';

@Module({
  imports: [AuditLogModule],
  controllers: [
    MenusController,
    MenuSectionsController,
    MenuItemsController,
    MenuItemImagesController,
    ModifiersController,
  ],
  providers: [MenuService, MenuItemsService, ModifiersService],
  exports: [MenuService, MenuItemsService, ModifiersService],
})
export class MenuModule {}
