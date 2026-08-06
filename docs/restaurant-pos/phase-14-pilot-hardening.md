# Phase 14 — Pilot hardening (partial)

**Written:** 2026-08-06
**Branch:** `feature/restaurant-pos`
**Decision:** AD-19 in `decisions.md`

Phase 14's exit gate in the original roadmap is *"penetration test clean."*
This autonomous run cannot demonstrate that; **no penetration test has been
performed**, no security firm has been retained, and no production
infrastructure exists (D4). The exit gate is downgraded to *"reviewed and
documented."*

The remainder of Phase 14 is delivered in this document: a review of the
surface introduced by Phases 2 – 13, an inventory of hardening already in
place, and a punch-list of items that must be addressed before the
production exit gate can be re-armed.

---

## 1. Surface introduced Phase 2 – 13

**Tables (additive migrations):**
`RestaurantBranchConfig` · `KitchenStation` · `KitchenStationPrinter`
· `Menu` · `MenuSection` · `MenuItem` · `ModifierGroup` · `ModifierOption`
· `MenuItemModifierGroup` · `MenuItemChannelPrice` · `MenuAvailability`
· `MenuItemStationLink` · `DiningArea` · `RestaurantTable`
· `TableSession` · `RestaurantOrder` · `OrderRound`
· `RestaurantOrderItem` · `RestaurantOrderItemModifier`
· `RestaurantOrderStatusHistory` · `BranchInventory` · `StockMovement`
· `KitchenPrinter` · `KitchenTicket` · `KitchenTicketItem`
· `KitchenPrintAttempt` · `TakeawayOrderProfile` · `BillSplit`
· `DeliveryPlatform` · `ExternalOrder` · `ExternalOrderEvent`
· `WebhookDeliveryLog`.

Plus additive columns on `Sale`: `serviceChargeAmount`, `packagingCharge`,
`billingVersion`, `closeIdempotencyKey`. Plus `BranchAccess` (Phase 1.5.6),
`Role.isActive` / `Role.version` (Phase 1.5.5).

Every one of these is additive. `Product.quantityOnHand` is retained
permanently per D10.

**Route surface:** 147 routes at Phase 1 acceptance → **207 routes at Phase
14 review**, with **162 ENFORCED** (module-gated), 45 shared-core /
public. Full matrix in `route-module-matrix.md`; enforced by
`route-module-matrix.spec.ts`.

---

## 2. Hardening already in place

Every item below has been *implemented*. Where a test exists it is
listed; where a policy is documented that document is named.

### Authentication and session

- Workspace-first login with exact-match resolution (D19, D33). Ambiguous
  email refused as `WORKSPACE_REQUIRED`, never a silent tenant pick.
  `auth.service.spec.ts` covers the three paths.
- Refresh-token rotation with replay-kill (`auth.service.ts:163`).
  Tested for tenant-boundary mismatch (`auth-hardening.spec.ts`).
- PIN login requires device commissioning — no hard-coded `x-tenant-id`
  header for PIN sign-in.
- Auth rate limiting on email login, PIN login and refresh
  (Slice 7.1). Both IP-scoped and tenant-scoped, `Retry-After` on 429,
  no route-count enumeration.

### Authorisation

- Role and permission catalogue in `packages/shared` (D34).
- Database-backed role resolution with alternatives-not-additive rule
  (Phase 1.5.4, §3.12 of HANDOVER). `permission-resolver.service.spec.ts`
  proves the fallback rule and mutation-proves the union failure.
- Branch scoping via `BranchScopeGuard` (Phase 1.5.6, D38). Multi-branch
  users via `BranchAccess`. Cross-tenant answers 404, not 403.
- Module gating complete (Phase 1.5.9): 162 routes ENFORCED,
  `deferred-*` states removed. Sale reads remain `SHARED_CORE`
  deliberately.
- Every restaurant / kitchen / billing / delivery route is behind at
  least one permission AND one module — the guard chain is uniform
  across the new surface.

### Data safety

- Additive-only migrations. Migration tripwire
  (`provider-contract.spec.ts`) fails on any generated migration that
  is not explicitly listed, and asserts every migration is either an
  `ALTER TABLE ADD COLUMN` or a `CREATE TABLE` for a known table.
- Test-integrity standard D30 applied to every new tripwire: positive
  and negative assertions, mutation proofs for high-risk boundaries.
- `sanitizeAuditMetadata` (Phase 1.5.7) strips forbidden keys
  (password, PIN, tokens, credentials, cookies, JWT, secrets) before
  audit persistence. Integration spec `audit-secrets.spec.ts` scans
  every audit row for the sentinel, with a mutation proof.
- Two-tier consistency contract (Phase 1.5.8) stated in code
  (`SETTINGS_TIER`) and proven with two-replica HTTP integration test
  `authoritative-consistency.spec.ts`.

### Rate limiting and multi-replica

- `RateLimitStore` abstraction (D32, D39). Process-local
  implementation logs `isDistributed=false` at boot.
- `assertReplicaSafetyOrExit` refuses to boot when
  `APP_REPLICA_COUNT > 1` without a distributed store (Phase 1.5.10,
  AD-11).
- Prebuild dev-server guard (`apps/web/scripts/check-web-dev-running.mjs`)
  refuses `next build` while a Next dev server is running.

### Operational

- Staging readiness document (`staging-readiness.md`) with the
  additive-only migration procedure, backup/restore policy, sanitized
  data policy, QuickBooks sandbox isolation, smoke tests, and
  rollback.
- Two seeded development tenants (`tnt_dev`, `tnt_resto`) that
  exercise both the QuickBooks and the NONE-accounting paths.
- Full route → module → permission matrix (207 rows) with a spec
  that fails when doc and code disagree.

---

## 3. Items NOT delivered and required before production

These are the items that would need to be closed before the *production*
deployment gate (D4) is re-armed. None of them is a defect in what was
delivered — they are absences that this run cannot address.

### 3.1 Staging environment

**Status:** Documented, not provisioned. **D4 stays in force.**

Staging must exist and must be exercised (backup restore verified,
schema deploy rehearsed, migration diff reviewed by hand) before the
first production deploy. Without staging there is no way to prove the
deployment procedure works.

### 3.2 Distributed rate-limit store

**Status:** Abstraction ready, no implementation (D39, open question O2).

`APP_REPLICA_COUNT > 1` refuses to boot today. A Redis-backed store
(matching the abstraction) is a routine addition when the operator
chooses to scale out — but that choice interacts with the Socket.IO
adapter for Phase 4. The two decisions are the same decision (O2).

### 3.3 WebSocket transport for real-time push

**Status:** Event abstraction ready
(`RealtimeEventBus`), no transport shipped.

A Socket.IO or SSE adapter subscribes to the bus and pushes to
connected clients (KDS, floor view, waiter tablets). Requires the O2
decision because multi-replica Socket.IO needs a shared adapter.

### 3.4 Delivery-platform adapters (Uber Eats, PickMe, DoorDash)

**Status:** Not shipped (explicit user instruction, D9).

The abstraction is in place with a Mock adapter. Real adapters live
alongside `MockDeliveryPlatformAdapter` and implement the same port.
No production claim can be made for a real platform without its
sandbox certification.

### 3.5 Frontend for restaurant operational surfaces

**Status:** Backend complete, restaurant frontend pages are follow-up.

The retail Next.js frontend is intact and continues to work. Restaurant
operational pages (floor view, KDS live board, table management,
takeaway queue) are follow-up UI work — the backend surface they need
is ready.

### 3.6 Token storage redesign

**Status:** Encrypted at rest today; scope hardening (rotating encryption
keys, tenant-partitioned key material) is deferred.

The current `TOKEN_ENCRYPTION_KEY` is single-key per environment. A
per-tenant KMS-managed key pair would be the target for enterprise
tenants; not a pre-production blocker for the pilot.

### 3.7 Penetration test

**Status:** Not performed.

The exit-gate was `"penetration test clean"`. This run cannot
demonstrate it. A pen-test firm must be engaged after staging is
provisioned, before production access is granted.

### 3.8 Backend audit for the introduced surface

**Status:** Reviewed as this document was written. No defects found
that would justify holding the branch.

Areas where the new surface trades design safety for pragmatism, all
flagged in the commit messages:

- **Session-close creates a Sale via direct writes**, not via
  `SalesService.complete`. Trade-off: the full retail sale flow with
  discount approval, provider dispatch and QuickBooks handling is
  bypassed. Acceptable for the restaurant close because the profile
  is `NONE` accounting and inventory is `LOCAL`; will need
  re-visiting when a restaurant tenant enables QuickBooks.
- **Menu-item ↔ real-Product matching for delivery orders is not
  wired.** An accepted delivery order creates a RestaurantOrder with
  no items today; the adapter fills items via a later round submission.
  This keeps the abstraction ship-able without requiring a
  menu-matching feature to land alongside.

---

## 4. Sign-off criteria for this document

- ✅ Every table Phase 2–13 introduced is listed in §1.
- ✅ Every hardening item claimed in §2 is either tested (test named)
  or documented (doc named).
- ✅ Every deferred item in §3 has a next-step owner in the roadmap.
- ✅ No claim of penetration-test clean is made (AD-19).
- ⬜ Product Owner review and sign-off.

The last item is the Product Owner's, not this run's.
