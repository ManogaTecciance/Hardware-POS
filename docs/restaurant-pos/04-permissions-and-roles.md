# Permissions and roles

## Today (audited 2026-08-04)

```
JWT: { sub, tenantId, role }                    ← no branchId, no permissions
  ↓ JwtAuthGuard        → request.user = { id, tenantId, role }
  ↓ RolesGuard          @Roles(UserRole[])
  ↓ PermissionsGuard    @RequirePermissions(Permission[]) → roleHasPermission(role, p)
                                                          → static ROLE_PERMISSIONS map
```

- 5 roles (`CASHIER` `MANAGER` `ADMIN` `OWNER` `ACCOUNTANT`), 30 permission keys.
  `OWNER` and `ADMIN` hold everything.
- **The `Role` and `Permission` database tables are never read by any guard.**
  Custom per-tenant roles are currently unreachable.
- The permission model is **duplicated by hand** in
  `apps/api/src/modules/auth/permissions.ts` and
  `apps/web/src/lib/permissions.ts` — 30 keys and 5 role mappings, twice.
- Role discount limits live separately in `discounts/discount-limits.ts`, mirrored
  again in the web `permissions.ts`.
- **No branch scoping.** `AuthenticatedUser` has no `branchId`, and every list
  query is tenant-scoped only, so nothing prevents a user acting on another
  branch of the same tenant.
- `packages/shared` `UserRole` has 3 of the database's 5 values (decision D13).

## Phase 1 — consolidate (Slice 7, not yet authorised)

Move `Permission`, `ROLE_PERMISSIONS`, `roleHasPermission`, and
`ROLE_DISCOUNT_LIMIT_PERCENT` into `packages/shared/src/permissions.ts`. Both
former locations re-export. **A move, not an edit** — all 30 keys and all 5 role
mappings stay identical, asserted by a parity test.

Add `PLATFORM_PROFILE_MANAGE`.

Align the shared `UserRole` **additively** (add `Owner`, `Accountant`; rename
nothing; no database enum change) and add a parity test asserting
`Object.values(shared.UserRole)` ≡ `Object.values(Prisma.UserRole)`, so future
drift fails loudly.

## Phase 2 — activate the database path

`PermissionsGuard` resolves effective permissions as
`ROLE_PERMISSIONS[user.role] ∪ user.customRole.permissions`, seeding `Permission`
rows from the shared enum via a migration plus seed.

**This is what makes restaurant roles expressible without a PostgreSQL enum
migration on the live `User` table** — the safer path, and the reason it is
preferred over extending `UserRole`.

Restaurant roles: Owner · Tenant Admin · Branch Manager · Restaurant Manager ·
Cashier · Waiter · Kitchen Manager · Kitchen Staff · Bar Staff · Accountant ·
Auditor.

## Phase 2 — tenant and branch isolation (decision D17)

A repeated (100/100) isolation test is useful but not sufficient. Also required:

1. **Deterministic service/repository tenant scoping** — every query filters on
   `tenantId`; no `findFirst` without it. The audited defect
   `AuthRepository.findActiveByEmail` (`findFirst({ email, isActive })` against a
   table that is only `@@unique([tenantId, email])`) is fixed in Slice 7.
2. **Cross-tenant negative integration tests** — Tenant A's token must fail to
   read or write every Tenant B resource, asserted per module.
3. **Backend permission enforcement** — never UI-only gating.
4. **Branch isolation where applicable** — `branchId` added to `JwtPayload` and
   `AuthenticatedUser`; a `BranchScopeGuard`; branch-bound actors filtered on
   every list query and validated on every write.
5. **No trust in a request-supplied `tenantId`.** The `@TenantId()` decorator
   currently falls back to the `x-tenant-id` header when there is no session.
   That fallback exists for pre-auth PIN login and **must be restricted to
   explicitly `@Public()` routes only**; on an authenticated route the tenant must
   come from the verified JWT and nothing else.
6. **Tenant identity derived from authenticated server-side context** — the JWT
   claim, verified per request.
7. **Database constraints and indexes** — every tenant-scoped table carries
   `@@index([tenantId])` and a tenant-inclusive `@@unique` on natural keys.

## Phases 4-12 — restaurant permission keys

All enforced server-side via `@RequirePermissions`, never UI-only:

`RESTAURANT_SETTINGS_MANAGE` · `DINING_AREA_VIEW` · `DINING_AREA_MANAGE` ·
`TABLE_VIEW` · `TABLE_MANAGE` · `TABLE_OPEN` · `TABLE_TRANSFER` · `TABLE_MERGE` ·
`TABLE_CLOSE` · `TABLE_REOPEN` · `ORDER_CREATE` · `ORDER_EDIT_DRAFT` ·
`ORDER_SEND_TO_KITCHEN` · `ORDER_CANCEL_UNSENT` · `ORDER_VOID_SENT` ·
`ORDER_DISCOUNT` · `COMPLIMENTARY_ITEM_APPROVE` · `KOT_VIEW` · `KOT_PRINT` ·
`KOT_REPRINT` · `KITCHEN_STATUS_UPDATE` · `TAKEAWAY_VIEW` · `TAKEAWAY_CREATE` ·
`TAKEAWAY_CANCEL` · `BILL_VIEW` · `BILL_SPLIT` · `BILL_DISCOUNT` ·
`PAYMENT_COLLECT` · `PAYMENT_REFUND` · `BILL_REOPEN` · `ONLINE_ORDER_VIEW` ·
`ONLINE_ORDER_ACCEPT` · `ONLINE_ORDER_REJECT` · `ONLINE_ORDER_RETRY` ·
`DELIVERY_INTEGRATION_MANAGE` · `RESTAURANT_REPORT_VIEW`

## Audit requirements

`AuditLog` exists and is applied to quotations, categories, settings, documents,
sharing, and `return.completed`. It is **not** applied to sales, payments, discount
approvals, or logins — a gap to close alongside the restaurant work.

Every audit record carries `tenantId`, `branchId`, `userId`, entity type, entity id,
action, previous state, new state, reason, device, and timestamp.
