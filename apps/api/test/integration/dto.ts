/**
 * DTO construction for integration specs.
 *
 * Services receive real DTO *instances* in production — the global ValidationPipe
 * runs `plainToInstance` first — and several DTOs expose derived getters
 * (`PaginationQueryDto.skip` / `.take`) that a plain object literal simply does not
 * have. Building them the same way the pipe does keeps the specs faithful and
 * avoids `as never` casts that would hide a genuine shape mismatch.
 */

import { plainToInstance } from 'class-transformer';

export function dto<T>(cls: new () => T, plain: Record<string, unknown> = {}): T {
  return plainToInstance(cls, plain, { enableImplicitConversion: true });
}
