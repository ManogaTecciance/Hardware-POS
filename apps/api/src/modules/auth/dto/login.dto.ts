import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Owner / admin / accountant email + password login.
 *
 * `workspace` is the tenant slug (Slice 7.2). It is optional for backward
 * compatibility: an email that exists in exactly one tenant still logs in without
 * it, which is every existing client and the dev seed. It becomes *required* the
 * moment the same address exists in more than one tenant, because there is no
 * safe way to guess which one the caller meant.
 *
 * The slug is client-supplied and unverified at this point. It only ever NARROWS
 * the lookup — the password is still checked against the resolved user's own hash —
 * so an invented workspace can only make a login fail, never succeed.
 */
export class LoginDto {
  /**
   * Tenant slug, e.g. `restaurant-demo`.
   *
   * Constrained to the slug alphabet rather than accepted as free text: it is used
   * as a lookup key and as part of a rate-limit bucket, and an unbounded string in
   * either is an avoidable liability.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-]*$/i, {
    message: 'workspace must contain only letters, numbers and hyphens',
  })
  workspace?: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
