import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * Hyphen-separated lower-case alphanumeric words: no leading, trailing or
 * doubled hyphen. The slug is a unique public identifier (`Tenant.slug` is
 * `@unique`), so the format is pinned here and the service turns the unique
 * constraint into a 409 — never a raw database error.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateWorkspaceDto {
  @IsString() @Length(2, 120) name!: string;
  @IsString()
  @Length(2, 64)
  @Matches(SLUG, {
    message:
      'slug must be lower-case letters, digits and single hyphens (no leading, trailing or doubled hyphen)',
  })
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

/*
 * D55.1: the role is a `Role` row belonging to THIS workspace, not a member of a
 * fixed list. Each template seeds a different set (2026-08-17: hardware gets
 * Owner + Cashier, food service Owner + Waiter + Cashier, hotel Owner + Waiter
 * + Receptionist), so a literal `@IsIn([...])` here could only ever be right
 * for one template — and would have rejected `WAITER`, which is precisely the
 * role a restaurant workspace exists to assign. The service validates the id
 * against the workspace's own rows, the only authority that knows the answer.
 */
export class CreateWorkspaceUserDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(3, 160) email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @Length(1, 64) roleId!: string;
}

export class UpdateWorkspaceUserDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(1, 64) roleId?: string;
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
