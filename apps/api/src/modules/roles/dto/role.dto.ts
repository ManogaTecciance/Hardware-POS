import { IsArray, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

/**
 * Role DTOs (Phase 1.5.5).
 *
 * No DTO carries a `tenantId`. The tenant comes from the authenticated session,
 * and the global `ValidationPipe` runs with `forbidNonWhitelisted`, so a body that
 * tries to name one is a 400 rather than a silently ignored field.
 */
export class CreateRoleDto {
  /**
   * Stable identifier. Immutable after creation and never reused, so an audit
   * entry naming a key always names the same role.
   */
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'key must be upper snake case, e.g. FLOOR_SUPERVISOR',
  })
  key!: string;

  @IsString()
  @Length(1, 80)
  name!: string;

  @IsString()
  @IsOptional()
  @Length(0, 500)
  description?: string;

  /** Validated against the code catalogue by the service; unknown keys fail closed. */
  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsString()
  @IsOptional()
  @Length(1, 80)
  name?: string;

  @IsString()
  @IsOptional()
  @Length(0, 500)
  description?: string;

  /** Optimistic concurrency. Omit to overwrite regardless; supply to be safe. */
  @IsInt()
  @IsOptional()
  @Min(1)
  expectedVersion?: number;
}

export class ReplaceRolePermissionsDto {
  @IsArray()
  @IsString({ each: true })
  permissions!: string[];

  @IsInt()
  @IsOptional()
  @Min(1)
  expectedVersion?: number;
}

export class ArchiveRoleDto {
  @IsInt()
  @IsOptional()
  @Min(1)
  expectedVersion?: number;
}

export class AssignRoleDto {
  @IsString()
  roleId!: string;
}
