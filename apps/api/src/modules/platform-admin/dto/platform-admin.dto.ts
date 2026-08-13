import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'ACCOUNTANT'] as const;

export class CreateWorkspaceDto {
  @IsString() @Length(2, 120) name!: string;
  @IsString()
  @Length(2, 64)
  @Matches(SLUG, { message: 'slug must be lower-case alphanumeric with hyphens' })
  slug!: string;
  /** One of `WORKSPACE_TEMPLATES` — validated against the list in the service. */
  @IsString() templateKey!: string;

  // The first owner. A workspace with no way in is not a workspace.
  @IsString() @Length(1, 120) ownerName!: string;
  @IsString() @Length(3, 160) ownerEmail!: string;
  @IsString() @MinLength(8) ownerPassword!: string;
}

export class UpdateWorkspaceDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateWorkspaceUserDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(3, 160) email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsIn(ROLES) role!: (typeof ROLES)[number];
}

export class UpdateWorkspaceUserDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsIn(ROLES) role?: (typeof ROLES)[number];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * D55 — the one endpoint in the console that touches credentials. Every use is
 * audited: a platform admin who resets an owner's password can sign in as
 * them, which reaches the workspace data the boundary guard otherwise refuses.
 */
export class ResetUserPasswordDto {
  @IsString() @MinLength(8) password!: string;
}

export class PlatformQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) page?: number;
  @IsOptional() @Type(() => Number) pageSize?: number;
}
