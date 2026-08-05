/**
 * The API's view of the role/permission vocabulary.
 *
 * **This file defines nothing.** Since Slice 7.3 the single authority is
 * `@hardware-pos/shared`, and this module only re-exports it so the ~40 existing
 * `from './permissions'` / `from '../auth/permissions'` imports across the API keep
 * working unchanged.
 *
 * It used to hold its own `enum Permission` and `ROLE_PERMISSIONS`, with the web app
 * holding a hand-maintained copy. They drifted: the web copy never gained the two
 * `PLATFORM_PROFILE_*` permissions added in Slice 4, and nothing compared them.
 *
 * `Permission` is now a `const` object rather than a TypeScript `enum`. Every
 * existing use survives that change — `Permission.SALE_CREATE` as a decorator
 * argument, `Permission` as a type annotation, `Object.values(Permission)` at
 * runtime — because the shared module exports a value and a same-named union type.
 *
 * The shared `ROLE_PERMISSIONS` is keyed by the shared `UserRole`, which
 * `authorization.parity.spec.ts` proves equals the Prisma `UserRole` exactly. So
 * indexing it with a `UserRole` read from the database is total, not a lookup that
 * might return `undefined`.
 */

export {
  ALL_PERMISSIONS,
  ALL_USER_ROLES,
  Permission,
  ROLE_PERMISSIONS,
  roleHasPermission,
} from '@hardware-pos/shared';
