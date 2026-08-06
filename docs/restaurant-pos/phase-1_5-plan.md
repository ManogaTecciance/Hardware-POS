# Phase 1.5 — Platform and Branch Security Hardening

**Status: not started.** Scope approved by the Product Owner at the Phase 1
checkpoint. This document is the plan; nothing in it is implemented.

## Why this phase exists, and why it is not called Restaurant Phase 2

Phase 1 made the platform *modular*. It did not make it *safe for more than one
branch or more than one replica*. The gaps are concrete and are recorded as
limitations in [`09-phase-1-acceptance.md`](./09-phase-1-acceptance.md): a
user assigned to one branch can read another branch's data, role permissions live
in a shared constant rather than in the database, the rate limiter protects a
single process, module gating stops short of the retail write path, and
`DocumentsController` serves documents by id with no module or branch check.

This work was first drafted as "Restaurant Phase 2". The Product Owner renamed it
because it contains **no restaurant domain entity and no restaurant operational
workflow** — calling it Restaurant Phase 2 would have implied restaurant
capability it does not deliver. Restaurant Phase 2, the domain foundation, begins
only when this phase is complete.

## Sequencing

The same rule that governed Phase 1 applies: **land the authority inert, prove
parity, then switch the call sites.** A permission system rewired in one commit is
not reviewable, and the failure mode is silent over-permission.

| # | Slice | Depends on | Migration | Reviewable claim |
|---|---|---|---|---|
| 1.5.1 | Decision records + schema design | — | none | The Product Owner has approved a schema before any migration exists |
| 1.5.2 | Role/permission tables, seeded, **unused by authorization** | 1.5.1 | additive | Every route behaves exactly as before |
| 1.5.3 | Parity proof: DB authority vs shared constant, for all five built-in roles | 1.5.2 | none | The two authorities agree on every (role, permission) pair |
| 1.5.4 | Authorization resolves from the database, shared constant as fallback | 1.5.3 | none | Behaviour unchanged; the fallback path is exercised by a test |
| 1.5.5 | Restaurant roles as data + reserved permissions | 1.5.4 | none | Reserved permissions exist and grant nothing |
| 1.5.6 | Active branch context + `BranchScopeGuard`, applied per classified route | 1.5.4 | additive | Cross-branch access denied; tenant-wide routes not branch-gated |
| 1.5.7 | Audit expansion | 1.5.6 | additive | Every listed event writes an entry, and no entry carries a secret |
| 1.5.8 | Settings/profile consistency across replicas | 1.5.2 | none | A second instance observes a change within a documented window |
| 1.5.9 | Remaining module-guard rollout + `DocumentsController` | — | none | The matrix has no `deferred-*` rows left |
| 1.5.10 | Rate-limiter production contract + staging readiness document | — | none | No mandatory new infrastructure without approval |

Slices 1.5.9 and 1.5.10 have no dependency on the rest and can land first — they
are the lowest-risk items and they close two production blockers.

## Decisions required before any migration

Repository rule: **no Prisma migration without an explicit decision record.** Each
of these becomes an entry in [`00-decisions.md`](./00-decisions.md) before the
migration it governs is generated.

| Ref | Question | Why it cannot be inferred |
|---|---|---|
| D-A | Are roles **per tenant** or **global templates cloned per tenant**? | Determines whether `Role.tenantId` is nullable. A global row shared by tenants is a cross-tenant write surface; a per-tenant clone costs a seeding step per new tenant. |
| D-B | Does `UserRole` stay on `User` as the built-in fallback, or does `User` gain `roleId`? | The enum is persisted. Additive means both exist during the transition; the decision is which one authorization reads *after* parity, and when the enum is retired. |
| D-C | Is a permission a **row** or a **string constant checked against a row**? | A `Permission` table admits tenant-invented permissions, which nothing can enforce. The safer shape is a fixed catalogue in code, with rows only for *assignments*. |
| D-D | Does the access token carry `activeBranchId`? | A claim is fast but goes stale; a per-request lookup is always current but costs a query on every branch-scoped route. The Product Owner asked that a stale claim must not stay valid — that constrains, but does not settle, the token lifetime. |
| D-E | What is the settings-consistency window? | "Eventually" is not a specification. A number (e.g. ≤ 30 s) is what a test can assert and an operator can rely on. |
| D-F | Redis: yes or no? | Open question O2, unchanged since Phase 1. Required for a distributed rate limiter and for cross-replica cache invalidation. **The Product Owner asked to be stopped before any mandatory new infrastructure dependency.** |

## What must not happen

- **No destructive enum change.** `UserRole` values are persisted on real rows.
- **No restaurant operational model.** Reserved permissions are strings with no
  controller behind them; that is the point of calling them reserved.
- **No role name in an authorization decision.** Permissions are the authority.
  A role is a bag of permissions and nothing more.
- **No blanket branch guard.** Tenant-wide administration routes must be
  classified before anything is applied to them, and the classification belongs in
  [`route-module-matrix.md`](./route-module-matrix.md).
- **No claim of multi-replica protection** while the limiter is process-local.

## Test requirements

Thirty-five, as given by the Product Owner, recorded verbatim in the checkpoint
brief. The ones that constrain the *design* rather than the implementation:

- A stale branch claim must be rejected **after access removal** (13) — so
  whatever D-D decides, revocation cannot wait for token expiry.
- Tenant A cannot assign Tenant B's permissions (10) — so permission assignment is
  tenant-scoped at the query level, not merely at the API boundary.
- Shared tenant routes must **not** be branch-gated (17) — a negative that fails if
  the guard is applied blindly.
- Independent service instances observe profile changes within the documented
  window (28) — requires a test harness with two service instances, not one.
- High-risk guard boundaries are **mutation-proven** (32), per D30.

Every structural test carries a positive control. The Slice 9 lesson stands: an
"X is denied" assertion passes against a screen that rendered nothing and against a
guard that denies everyone, so each denial is paired with the same route
succeeding for the identity that should have it.
