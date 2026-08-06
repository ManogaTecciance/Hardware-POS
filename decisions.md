# Autonomous-implementation decision log

**Started:** 2026-08-06
**Author:** Claude (Opus 4.7, 1M context)
**Branch:** `feature/restaurant-pos`

This file records decisions made autonomously during the continuation of the
programme documented in [`HANDOVER.md`](./HANDOVER.md). The user granted
authority to choose the option the assistant would recommend where the Product
Owner would ordinarily be asked, provided each such decision is recorded here.

Format: one entry per decision, most-recent first at the top of each phase
section. Every entry names the question, the choice, the alternatives that were
weighed, and the reasoning.

## Scope authority granted by the user

- Continue the implementation from the Phase 1.5.5 red state.
- Answer any question that would ordinarily be put to the Product Owner with
  the option the assistant would recommend.
- **Do not implement external integrations** — Uber Eats, PickMe Food, and any
  other real delivery-platform connector. The integration hub *infrastructure*
  and the Mock adapter are in scope; the specific external adapters are not.
- Implement every other phase in the roadmap through pilot hardening.

## Global working rules for this run

- **Every migration remains additive** (D15, D30, CLAUDE.md). No `DROP`, no
  destructive `ALTER`, no `UPDATE` of pre-existing columns without a decision.
- **Every new decision that would ordinarily be a `D`-numbered record** in
  `docs/restaurant-pos/00-decisions.md` is recorded here and cross-referenced.
  The decision log is not edited during autonomous work; the reasoning lives
  here and the reference is added when the Product Owner reviews.
- **Test-integrity standard (D30)** applies to every new spec — positive and
  negative assertions, exact sets, mutation proofs for high-risk tripwires.
- Where the roadmap or handover conflicts with observable code, the code wins,
  and the divergence is called out here.

---

## Phase 1.5.5 — closing the open slice

### AD-01 — Fix the migration tripwire literally, per §1 of the handover

**Choice.** Add the `20260806160000_add_role_lifecycle` entry to the pinned
migration set in `provider-contract.spec.ts`, rename the assertion, bump the
positive-control count, and loop the "no table created" check over both Phase
1.5 migrations. Verbatim per §1 of the handover — no relaxation of the
tripwire, no change to a count-only assertion.

**Alternatives rejected.**
- Widen the assertion to a `>= n` count check — this is precisely the failure
  mode D30 forbids (a green tripwire that asserts nothing).
- Prefix-match Phase 1.5 migrations — same defect, one level indirected.

**Reasoning.** The Product Owner has twice endorsed naming new state
explicitly rather than weakening the tripwire.

---

## Phase 1.5.6 — Branch context and `BranchScopeGuard`

### AD-02 — Multi-branch access uses a `BranchAccess` join table

**Question.** `User.branchId` is a single nullable column today. Multi-branch
access needs to associate several branches with one user.

**Choice.** Add a `BranchAccess` join table (`userId`, `branchId`,
`grantedAt`, `grantedByUserId?`) with `@@unique([userId, branchId])` and
`@@index([branchId])`. Leave `User.branchId` **in place** as the user's
default active branch and *do not* migrate data into or out of it.

**Alternatives rejected.**
- Replace `User.branchId` with an array — this is destructive on a live
  column and every existing reader has to be re-audited in one commit. D15
  and CLAUDE.md forbid this class of change without decision.
- Encode branch access on the role — collapses two orthogonal concepts
  (permission set, physical location) into one, and forces the seed to
  materialise branch-specific role rows, defeating D36.

**Reasoning.** Additive migration. Preserves the read path that uses
`User.branchId` for the default active branch, which is how the existing
seed and Phase 1 tests behave. Grants an audit trail (`grantedAt`,
`grantedByUserId`) at almost no schema cost. OWNER/ADMIN bypasses the table
by policy — the guard treats them as "all active branches of the tenant".

### AD-03 — `activeBranchId` claim is copied into the JWT at login and refresh

**Choice.** The claim is populated from `User.branchId` at login (when
present) or the first branch in `BranchAccess` (otherwise). `null` for
OWNER/ADMIN (they operate tenant-wide by default). Switch the active branch
with `POST /v1/auth/active-branch` which validates the branch, checks
access, and issues a fresh access token.

**Alternatives rejected.**
- Keep the active branch server-side in a session table — adds a stateful
  read to every request for no correctness benefit; D38 explicitly allows a
  short-lived claim as long as the server re-validates.

### AD-04 — `BranchScopeGuard` is a global guard with route metadata

**Choice.** Register `BranchScopeGuard` globally (after
`PermissionsGuard`). Routes declare their scope with
`@BranchScope(BranchScopeKind.BRANCH_SCOPED | REGISTER_SCOPED |
TENANT_SCOPED | GLOBAL_PLATFORM)`. Routes without metadata default to
`TENANT_SCOPED` and the guard is a no-op. `BRANCH_SCOPED` routes require
`activeBranchId` on the token and the caller must have access to that
branch; the guard fails **closed** on any deviation.

**Alternatives rejected.**
- Per-controller class guards — noisier, easier to forget, and doesn't
  give the route matrix a single classification field to enforce.

### AD-05 — Cross-tenant branch references answer **404** everywhere

**Choice.** Same rule as the Phase 1.5.5 role controller. Requesting a
branch that belongs to another tenant returns **404 branch not found**, not
403. Guard and controller both.

**Reasoning.** A 403 would confirm the branch id exists somewhere. The
handover documents this exact rule for roles.

---

## Phase 1.5.7 — Audit expansion

### AD-06 — Audit payload serialisation runs through `sanitizeAuditMetadata`

**Choice.** Introduce a pure helper `sanitizeAuditMetadata(input)` that
walks a value and replaces any key matching the forbidden list
(`password`, `passwordHash`, `pin`, `pinHash`, `token`, `accessToken`,
`refreshToken`, `authorization`, `cookie`, `secret`,
`tokenEncryptionKey`, `apiKey`, credentials) with the sentinel
`'[REDACTED]'` — recursively, case-insensitive, with a bounded depth. The
`AuditLogService` calls it before persisting.

**Alternatives rejected.**
- Trust callers to sanitise — the whole point of §1.5.7 is that they
  won't, always.
- A denylist on the raw JSON string — misses nested objects and leaves
  intact keys like `x-authorization-token` that don't match a literal
  substring exactly.

**Reasoning.** Central choke point, testable in isolation, and the
existing `AuditLogService.log()` already has one call site to wrap.

---

## Phase 1.5.8 — Settings two-tier consistency

### AD-07 — Security-sensitive state uses a per-tenant version number

**Choice.** Add a `SettingsVersion` model (`tenantId @unique`, `version
Int @default(1)`, `updatedAt`). Every mutation to a "security-sensitive"
setting increments the row's version inside the same transaction. Reads
that must be authoritative fetch the version and compare against the
cached copy — a mismatch invalidates and re-reads. Non-security settings
retain the existing 30-second window.

**Alternatives rejected.**
- Redis pub/sub — D39 forbids adding Redis in Phase 1.5.
- Postgres LISTEN/NOTIFY — works, but couples the read path to a
  connection-scoped subscription; harder to test.
- No caching at all — measurable latency regression on the settings
  read path; the PO's brief permits caching as long as invalidation is
  authoritative.

**Reasoning.** A single indexed `SELECT version FROM …` is cheap and
gives us the "invalidate on the next validated request" guarantee
without depending on inter-process transport.

---

## Phase 1.5.9 — Module and document guards

### AD-08 — Retail write path gets `@RequireModule(RETAIL_POS)` end-to-end

**Choice.** Sale draft/complete, payments, receipts, print jobs and
discounts all acquire `@RequireModule(ModuleKey.RETAIL_POS)`. The route
matrix moves those rows from `deferred-retail-pos` to `ENFORCED`.
Existing behavioural tests must remain green — the guard is a no-op for
`tnt_dev` because it resolves to legacy defaults which include the retail
module.

**Alternatives rejected.**
- Introduce a "restaurant billing" module split — premature; billing is
  shared-core once Phase 8 lands.

### AD-09 — `DocumentsController` splits into typed rendering endpoints

**Choice.** Keep the class, add per-document-kind route metadata so the
guard can evaluate `sale` / `quotation` / `return` / `exchange`
independently. `deferred-mixed-controller` disappears from the matrix.

---

## Phase 1.5.10 — Rate limiter and staging readiness

### AD-10 — Prebuild dev-server guard is a plain Node script

**Choice.** Ship `scripts/check-web-dev-running.mjs` invoked by the
`build` script of `apps/web`. It checks for a running Next dev server on
the configured port (default 3000) by looking for `.next/dev-server-lock`
or a listener on the port that responds to `/_next/webpack-hmr`. If
found, print a clear message and exit non-zero — never terminate the
process.

**Alternatives rejected.**
- Wrap `next build` in a Nest module — heavier, and only works from the
  monorepo root.
- Alter `distDir` — the PO's brief explicitly forbids this.

### AD-11 — `refuse to boot on multiple replicas without a distributed store`

**Choice.** `RateLimitStore` grows a `isDistributed` boolean; the bootstrap
inspects `APP_REPLICA_COUNT` (defaults `1`) and refuses to start when the
count is `> 1` and the store is not distributed. Logs the reason and
exits 78 (`EX_CONFIG`).

---

## Restaurant Phase 2

### AD-12 — All Phase 2 sub-slices land in `feature/restaurant-pos` on separate migrations

**Choice.** Each of 2A / 2B / 2C / 2D lands its own migration with an
ordered timestamp. No sub-slice shares a migration with another. Names
follow the existing style: `<timestamp>_add_restaurant_config`,
`_add_menu`, `_add_dining_areas`, `_add_table_sessions`.

**Reasoning.** The handover's exit gate for Phase 2 is "no sub-slice shares
a migration" — direct instruction.

### AD-13 — `MenuItem.productId` is nullable; menu ≠ catalog

**Choice.** `MenuItem` has `productId?` (optional) to allow menu items
that map to a `Product` (drinks bought as retail SKUs, ingredients that
consume stock) and menu items that do not (a kitchen dish that combines
ingredients tracked elsewhere). Menu prices are the source of truth for
what the customer pays; product prices remain the source of truth for
retail.

**Reasoning.** Retained engineering principle from the superseded plan
(D1): **menu ≠ catalog**. Enforced by the fact that MenuItem carries its
own price fields.

### AD-14 — Kitchen stations are per-branch and refer to zero-or-many printers

**Choice.** `KitchenStation` (id, tenantId, branchId, name, code) plus
`KitchenStationPrinter` (stationId, printerId, isPrimary) join. The
`KitchenPrinter` model is deferred to Phase 6; the join sits empty until
then.

**Alternatives rejected.**
- Denormalise printer references into the station row — collapses to one
  printer per station, contradicting the D6 requirement to route to
  several printers in a redundancy pair.

### AD-15 — RestaurantOrderItem prices are snapshotted at send-to-kitchen

**Choice.** When an order round is submitted, the item row records
`unitPrice`, `modifierTotal`, `menuItemName`, `menuItemCode` at that
instant. Subsequent price changes on the menu do not retroactively alter
the round. Matches the existing `SaleItem`, `QuotationItem`,
`ReturnItem` snapshot convention listed in the handover under "Schema
conventions".

---

## Phase 2.5 — Branch-scoped inventory

### AD-16 — Providers read `BranchInventory` behind a feature flag `INVENTORY_BRANCH_SCOPED`

**Choice.** Add the flag as an env var, default false. `LocalInventoryProvider`
dual-writes `Product.quantityOnHand` and `BranchInventory` regardless; the
read path switches only when the flag is on. The flag flips per environment
after the rollup check `BranchInventory sum == Product.quantityOnHand` is
proven for that environment.

**Alternatives rejected.**
- Flip cutover per tenant — tenants can migrate independently but the
  code path becomes conditional forever.

---

## Phases 3-9 (Restaurant operations)

*(Additional decisions will be added as each phase is implemented.)*

---

## Phase 10 — Online Orders Integration Hub (infrastructure only)

### AD-17 — Ship the abstraction, the mock adapter, and the webhook router

**Choice.** The abstraction is a `DeliveryPlatformAdapter` port with
`normalizeOrder(payload)`, `acceptOrder(id)`, `rejectOrder(id, reason)`,
`markReady(id)`, `markCompleted(id)`. The Mock adapter implements it end
to end and is the only production-registered adapter after this phase.
`ExternalOrder`, `ExternalOrderEvent`, `WebhookDeliveryLog` land as
data. No Uber Eats or PickMe adapter — per the user's stop condition.

**Reasoning.** Delivers the promise of `Phase 10` — a hub that Ordering
routes into and out of — without shipping any external integration.

---

## Phase 13 — Kitchen Display System

### AD-18 — KDS is a Next.js route in the existing web app

**Choice.** `/kitchen` (already the shell) becomes the KDS live board.
No separate app or bundle.

---

## Phase 14 — Pilot hardening (partial)

### AD-19 — No penetration-test claim; no production credentials

**Choice.** The phase brief includes "penetration test clean" as the exit
gate. This run cannot demonstrate that. The tasks that can be delivered
(rate-limit polish, token-storage improvements, performance sweep on the
hot routes, and a security review of the introduced Phase 2-9 surface)
are delivered; the exit gate is downgraded to "reviewed and documented".

**Reasoning.** Autonomous scope. The unclaimed exit gate is called out
in the final report.
