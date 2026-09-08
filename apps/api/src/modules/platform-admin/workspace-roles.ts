/**
 * D55.1 — the enum role that sits underneath a workspace role.
 *
 * The derivation itself lives in `@hardware-pos/shared` (`baseUserRoleFor`,
 * moved there by D108) so that the console, `RolesService.assignToUser` and
 * `provision-tenant.ts` cannot disagree about which row keys yield an
 * owner-level enum. This module stays as the API-side import path; the
 * reasoning — why a custom role's enum must fail closed to CASHIER — is on the
 * shared function.
 */
export { baseUserRoleFor } from '@hardware-pos/shared';
