import { Equals, IsBoolean } from 'class-validator';

/**
 * A grant carries an explicit boolean so a stray PUT with just the URL cannot
 * silently escalate a user. The body is small on purpose — the identifiers
 * are in the path, the intent is here.
 */
export class GrantBranchAccessDto {
  @IsBoolean()
  @Equals(true, { message: 'confirm must be true to grant branch access' })
  confirm!: boolean;
}
