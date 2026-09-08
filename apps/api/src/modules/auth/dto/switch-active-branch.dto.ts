import { IsString, Length } from 'class-validator';

/**
 * Switch the caller's active branch.
 *
 * The server re-validates access every time — a stale token or a branch the
 * user was removed from is refused here just as it would be on any
 * branch-scoped request. A cross-tenant id is refused as 404 (no existence
 * oracle).
 */
export class SwitchActiveBranchDto {
  @IsString()
  @Length(1, 128)
  branchId!: string;
}
