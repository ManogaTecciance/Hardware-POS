import { ModuleKey } from '@hardware-pos/database';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { StorageService } from '../../common/storage/storage.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { AppSettings } from './settings.interfaces';
import { SettingsService } from './settings.service';

/** Multer memory-storage file shape. */
interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
}

/** Document branding image slots that map to a `documents.*Url` field. */
type BrandingAsset = 'logo' | 'signature' | 'stamp';
const ASSET_FIELD: Record<BrandingAsset, 'logoUrl' | 'signatureUrl' | 'stampUrl'> = {
  logo: 'logoUrl',
  signature: 'signatureUrl',
  stamp: 'stampUrl',
};

@Controller('settings')
// Slice 7.6 — enabled for every business profile; inert today, meaningful once switched off.
@RequireModule(ModuleKey.SETTINGS)
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  getSettings(@TenantId() tenantId: string): AppSettings {
    return this.settingsService.getSettings(tenantId);
  }

  @Put()
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  async updateSettings(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateSettingsDto,
  ): Promise<AppSettings> {
    const next = await this.settingsService.updateSettings(tenantId, dto);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'settings.updated',
      entityType: 'TenantSettings',
      entityId: tenantId,
      metadata: { groups: Object.keys(dto) },
    });
    return next;
  }

  @Post('reset')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  async reset(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppSettings> {
    const next = await this.settingsService.resetSettings(tenantId);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'settings.reset',
      entityType: 'TenantSettings',
      entityId: tenantId,
    });
    return next;
  }

  // ── Document branding images (logo / signature / stamp) ─────────

  @Post('document-profile/logo')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadLogo(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<AppSettings> {
    return this.setAsset(tenantId, user, 'logo', file);
  }

  @Delete('document-profile/logo')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  removeLogo(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppSettings> {
    return this.clearAsset(tenantId, user, 'logo');
  }

  @Post('document-profile/signature')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadSignature(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<AppSettings> {
    return this.setAsset(tenantId, user, 'signature', file);
  }

  @Delete('document-profile/signature')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  removeSignature(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppSettings> {
    return this.clearAsset(tenantId, user, 'signature');
  }

  @Post('document-profile/stamp')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadStamp(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<AppSettings> {
    return this.setAsset(tenantId, user, 'stamp', file);
  }

  @Delete('document-profile/stamp')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  removeStamp(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppSettings> {
    return this.clearAsset(tenantId, user, 'stamp');
  }

  // ── shared upload/clear ─────────────────────────────────────────

  private async setAsset(
    tenantId: string,
    user: AuthenticatedUser,
    asset: BrandingAsset,
    file: UploadedImage | undefined,
  ): Promise<AppSettings> {
    if (!file?.buffer) throw new BadRequestException('No image file uploaded');
    const field = ASSET_FIELD[asset];
    const previous = this.settingsService.getSettings(tenantId).documents[field];
    const url = await this.storage.saveImage(file);
    const next = await this.settingsService.updateSettings(tenantId, {
      documents: { [field]: url },
    });
    // Best-effort cleanup of the replaced image (ignored if external/missing).
    if (previous && previous !== url) await this.storage.remove(previous);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: `document_profile.${asset}_uploaded`,
      entityType: 'TenantSettings',
      entityId: tenantId,
      metadata: { url },
    });
    return next;
  }

  private async clearAsset(
    tenantId: string,
    user: AuthenticatedUser,
    asset: BrandingAsset,
  ): Promise<AppSettings> {
    const field = ASSET_FIELD[asset];
    const previous = this.settingsService.getSettings(tenantId).documents[field];
    const next = await this.settingsService.updateSettings(tenantId, {
      documents: { [field]: '' },
    });
    if (previous) await this.storage.remove(previous);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: `document_profile.${asset}_removed`,
      entityType: 'TenantSettings',
      entityId: tenantId,
    });
    return next;
  }
}
