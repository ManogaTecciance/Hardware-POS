# Product Owner decision log

Authoritative record of decisions governing the Restaurant POS programme.
Nothing elsewhere in this directory overrides an entry here. Append new
decisions; do not rewrite historical ones — supersede them with a new row and
mark the old one.

---

## 2026-08-04 — Phase 0 review

### D1 — `docs/restaurant-backend-plan.md` is superseded
Superseded as the implementation authority by the approved AxloPOS Restaurant POS
requirements. **Not deleted.** It carries a superseded notice and is retained as
historical documentation. Canonical documentation lives in `docs/restaurant-pos/`.

Its *engineering principles* were explicitly retained (additive-only migrations,
no vertical branching in shared modules, server-authoritative state, optimistic
concurrency, one junction point at "closing a session produces a `Sale`",
menu ≠ catalog). Its *data model* and *gating model* were not.

### D2 — Exchanges
The audit confirmed the repository contains an Exchange **A4 document renderer**
but **no** Exchange transaction, Prisma model, migration, API module, route,
permission key, or E2E spec.

Therefore:
- Preserve the existing Exchange document renderer and its current rendering output.
- Keep regression coverage for that renderer.
- Reserve the `EXCHANGES` module key.
- Hide `EXCHANGES` for Restaurant tenants.
- **Do not represent Exchanges as a fully implemented transaction feature.**
- Mark future Exchange transaction test cases `Blocked — feature not implemented`.
- Do not create an Exchange transaction workflow during Phase 1.
- Exchanges remain part of the shared platform for Tile Shop and Hardware tenants;
  Exchange code, structures, permissions, and tests must not be removed.

### D3 — `ModuleKey` enum values are stable database identifiers
The persisted values are fixed as listed in
[`01-platform-architecture.md`](./01-platform-architecture.md). They must not be
renamed without an explicit, approved data-migration strategy.

### D4 — Production database and staging
There is **no approval to run migrations against the live Tile Shop production
database.**

Phase 1 development may use a local disposable PostgreSQL, a seeded test
database, or an isolated integration-test database.

Required before any production migration or deployment:
- a production backup;
- a tested restore process;
- a staging environment or sanitized restorable production snapshot;
- a migration dry run;
- regression tests;
- a rollback or forward-fix plan.

The absence of staging **must not** block local implementation. It **must** block
production migration and deployment. Additive migrations only.

### D5 — Integration-test harness: approved
Requirements: tests must never connect to production; add protection against
production-like database URLs; tests must be repeatable; test data isolated and
cleaned; reuse existing test architecture where practical; keep the local
developer workflow understandable.

### D6 — Printing
Initial physical target: **80 mm network ESC/POS thermal printer.** The
architecture must also support a mock printer adapter, browser/system print
fallback, multiple station printers, and future USB or Bluetooth adapters.

**Printer-specific code must not live inside restaurant order-domain services.**

### D7 — Real-time transport
Use **WebSockets** via a NestJS-compatible architecture, preferably **Socket.IO**
unless repository analysis identifies a strong reason otherwise.

REST/database state is the source of truth. Every real-time screen must
resynchronise after reconnecting.

> Engineering note: Socket.IO across multiple API replicas requires a shared
> adapter (e.g. `@socket.io/redis-adapter`), because rooms and broadcasts are
> per-process. If replicas and WebSockets are both intended, Redis becomes a hard
> dependency at Phase 4. Decide "Redis: yes or no" before Phase 4, not during it.

### D8 — Service charge and tax
Service-charge tax treatment must be **tenant-configurable**. Do not hard-code one
tax interpretation. **Default service charge to disabled until configured.** Final
restaurant-specific tax configuration will be confirmed with an accountant before
production deployment.

### D9 — Uber Eats and PickMe Food
No production partner accounts, sandbox credentials, or final private API
documentation are assumed. Build the generic Online Orders Integration Hub and the
Mock Delivery Adapter first. **Do not claim production Uber Eats or PickMe support**
until official access, documentation, testing, and certification are complete.

### D10 — Multi-branch stock
`Product.quantityOnHand` not being branch-scoped is a **known architectural defect**
for local multi-branch inventory, and is **not an acceptable permanent limitation.**

Introduce a branch-scoped model (`BranchInventory` / `InventoryBalance`).
**Preserve `Product.quantityOnHand`** initially for backward compatibility and
QuickBooks caching. Do not destructively remove or repurpose it.

Scheduled as **Phase 2.5** — after branch scoping (Phase 2), before table sessions
(Phase 5). Rationale in [`phase-01-plan.md`](./phase-01-plan.md).

### D11 — Multiple API replicas
Assume the system may run with more than one API replica. **Do not depend on
process-local cache state for correctness.**

### D12 — README
Approved to correct the materially false project-status line. Factual and concise.

### D13 — Shared `UserRole` enum drift
The shared package's `UserRole` had 3 values against the database's 5. Align
**additively** (add missing keys, rename nothing, no database enum change) and add
a parity test that fails on future drift.

### D14 — `package-lock.json`
The repository is pnpm-based. The stray `package-lock.json` may be removed only
after confirming no CI, deployment, or tooling process depends on it.

> Verified 2026-08-04: no `.github/` directory exists (there is no CI);
> `amplify.yml` uses `npm install -g pnpm@10.33.0` then `pnpm install
> --frozen-lockfile` (a global install ignores the lockfile);
> `apps/api/Dockerfile` copies only `pnpm-lock.yaml`; no reference in
> `docker-compose*.yml`, `.dockerignore`, or `Caddyfile`. Removed in Slice 0 and
> added to `.gitignore` so it cannot return.

### D15 — Production migration gate: approved
The production API container **must not** automatically run Prisma migrations on
every startup.

- Development migrations use an explicit developer command.
- Integration tests may migrate a disposable test database.
- `RUN_MIGRATIONS_ON_BOOT` defaults to **false** in production.
- Production deployment runs migrations as a **separate one-off step before**
  starting or updating application replicas.
- The explicit migration command is documented in the deployment runbook.
- **Do not execute any migration against the live production database.**

### D16 — Test clarification
Existing behavioural assertions and production regression scenarios must remain
**unchanged**. Test infrastructure, configuration, fixtures, and shared utilities
may be extended as required for the integration-test harness. **Do not weaken or
remove existing coverage.**

### D17 — Tenant isolation
A repeated (100/100) isolation test is useful but **not sufficient alone**. Also
required:

- deterministic service/repository tenant scoping;
- cross-tenant negative integration tests;
- backend permission enforcement;
- branch isolation where applicable;
- **no trust in a request-supplied `tenantId`**;
- tenant identity derived from authenticated server-side context;
- database constraints and indexes where appropriate.

### D18 — Phase 1 implementation authorisation
Slices 0-3 approved for implementation. Slice 4 and later require separate
approval. Explicitly not authorised yet: provider ports; refactoring sales,
returns, or product logic; any restaurant domain feature (tables, menus, KOT,
takeaway, billing, integrations).

---

## 2026-08-04 — Slice 3.5 review

### D19 — Workspace-first authentication (resolves Risk J)
`Tenant.slug` is the **canonical public workspace identifier**.

Browser login will support either a `workspace` field on the login form, or a
tenant-specific URL such as `/login?workspace=<tenant-slug>`. A tenant subdomain
may be supported later. Full rationale and the target contract are in
[`08-authentication-and-workspace-identity.md`](./08-authentication-and-workspace-identity.md).

Target email/password contract:

```json
{ "workspace": "restaurant-name", "email": "user@example.com", "password": "..." }
```

Backward-compatibility rule:
- `workspace` supplied → authenticate **only** inside that tenant.
- `workspace` omitted **and exactly one** active tenant account matches → the
  existing login may continue **temporarily**.
- `workspace` omitted **and several** match → reject with a generic
  `WORKSPACE_REQUIRED` response.

Prohibited:
- **No searchable tenant dropdown.**
- **Do not reveal tenant names from an email address.**
- **Do not return the matching tenant names.**
- **Do not indicate how many tenants matched.**
- **Do not expose whether the email exists in another tenant.**
- No tenant enumeration through login error responses.

PIN authentication remains explicitly scoped through the appropriate tenant,
branch, and register context.

The browser workspace-login **user interface** belongs to the frontend
modularisation phase (Slice 8). Slice 4 must not become an authentication UI
redesign.

### D20 — Authentication throttling is a release gate (Risk K)
Throttling stays in **Slice 7** and is now a **mandatory gate** before public
staging, internet-accessible demonstrations, pilot deployment, and production
deployment.

Slice 7 must protect at least `POST /auth/login`, `POST /auth/pin-login`, and
refresh-token abuse where appropriate. The design must consider: source IP;
tenant/workspace; normalised email or login identifier; branch/register context
for PIN login; a generic HTTP 429; `Retry-After`; account-enumeration safety;
proxy-aware client IP handling; multiple API replicas; and a
distributed-compatible limiter or infrastructure-level rate limiting with an
application backstop.

**Do not implement throttling during Slice 4.** Do not make unrelated
authentication changes during Slice 4.

### D21 — Slice 4 authorisation
Slice 4 (platform data model and tenant module foundation) approved. Slice 5 and
later still require separate approval.

Authorised: `TenantBusinessProfile`, `TenantModule`, the business-profile enums,
effective legacy defaults, the platform profile service and API, the module-access
guard, permissions, one additive migration, and tests.

Not authorised: provider ports, inventory providers, accounting providers,
restaurant domain models, restaurant UI, and any refactor of sales, returns, or
product logic.

Database constraints for this slice:
- The migration may create `TenantBusinessProfile` and `TenantModule` only.
- No `DROP`, no column rename, no data deletion, no `UPDATE` of existing tenant
  data, **no backfill of existing tenants**.
- `Product.quantityOnHand` is not repurposed.
- No restaurant operational tables.
- **A tenant with no `TenantBusinessProfile` row is a first-class supported
  state** that resolves to the legacy Tile Shop behaviour. Existing tenants must
  not be made to run a setup wizard or reconnect QuickBooks.

---

## 2026-08-04 — Slice 4 review

### D22 — Route and module guard strategy (resolves Risk Q)
The single-controller module guard delivered in Slice 4 is **accepted as
architectural proof**. **Do not add `@RequireModule` blindly to every existing
controller.**

Rules, recorded in full in
[`01-platform-architecture.md`](./01-platform-architecture.md#route-classification-decision-d22):

1. Shared AxloPOS core routes are controlled by authentication, tenant isolation,
   and permissions — **not** by optional business-module flags.
2. Business-specific workflow routes must require the relevant `ModuleKey`.
3. A controller containing both shared and business-specific operations must be
   mapped at route level, or split, **before** any controller-level guard.
4. Every future Restaurant-specific controller must fail closed and declare its
   required module explicitly.
5. **No new Restaurant route may exist without backend module enforcement.**
6. A complete route-to-module matrix must be produced and **approved before the
   first real Restaurant tenant is onboarded**.
7. **Do not perform the comprehensive guard rollout during Slice 5.**

The matrix must inspect the actual repository and classify every controller and
route as one of `SHARED_CORE` or a specific `ModuleKey`. **Route classifications
must not be guessed without reading the route's business responsibility.**

### D23 — Platform profile read access
Effective-profile read access is **kept for CASHIER and every other authenticated
role**. The front-end needs it for module-aware navigation and capability
decisions. `GET /v1/platform/profile` may be used by any authenticated user.

The user-safe response may contain `businessType`, `inventoryMode`,
`accountingProvider`, `enabledModules`, the profile source, `version`, and safe
presentation metadata where required.

It must **not** expose QuickBooks access or refresh tokens, delivery-platform
credentials, API secrets, encrypted credential values, internal infrastructure
configuration, or any other tenant's data.

`PATCH /v1/platform/profile` remains restricted to **OWNER** and **ADMIN**.
CASHIER, MANAGER, and ACCOUNTANT must not update the profile. Backend permission
enforcement is preserved.

### D24 — Slice 5 authorisation
Slice 5 (provider ports, implementations, and factories) approved. Slice 6 requires
separate approval.

Slice 5 is **structural and inert**: it must not change call sites in sales,
returns, products, quotations, payments, the QuickBooks workers, or existing sync
orchestration. The existing Tile Shop continues to use the exact current code paths.

Required:
- Contracts derived from **characterised existing behaviour**, not speculation.
- No QuickBooks SDK types and no REST DTOs in provider interfaces — AxloPOS-owned
  input and result types only.
- Every mutating provider method accepts a caller-supplied
  `Prisma.TransactionClient`; providers never open a nested transaction; the caller
  keeps transaction boundaries; a failed provider mutation participates in the
  caller's rollback.
- `LocalInventoryProvider` must **not** claim multi-branch correctness using the
  global `Product.quantityOnHand`; it fails closed with a typed error for
  multi-branch tenants. `Product.quantityOnHand` stays preserved.
- `NoInventoryProvider` / `NoAccountingProvider` write no `SyncJob` or `SyncLog`,
  create no QuickBooks document ids, never call QuickBooks, and never pretend an
  external sync occurred.
- `EXTERNAL` inventory and `FUTURE_EXTERNAL` accounting **fail closed** with typed
  unsupported-provider errors. **No silent fallback** to QuickBooks, Local, or None.
- No Prisma migration. No `BranchInventory`. No restaurant domain models or UI.

---

## 2026-08-04 — Slice 5 review

### D25 — No-accounting result model
**Do not represent `NoAccountingProvider` with an ambiguous combination** such as
`markSynced: true` together with `quickbooksDocumentType: null`.

A tenant on `AccountingProviderKind.NONE` has completed the transaction **locally
and completely** but has synchronised nothing to an external system. Use a
provider-neutral discriminated union:

```ts
type AccountingSubmissionResult =
  | { disposition: 'QUEUED';       provider: 'QUICKBOOKS'; externalDocumentType: 'SALES_RECEIPT' | 'INVOICE' }
  | { disposition: 'NOT_REQUIRED'; provider: 'NONE';       externalDocumentType: null };
```

For `NONE`: no QuickBooks API call, no `SyncJob`, no `SyncLog`, no QuickBooks
document id, no claim that an external synchronisation occurred, a clear
`NOT_REQUIRED` result, and no secret or provider-specific detail exposed.

**No new Prisma enum and no migration.** The result stays an application-level union.

### D26 — Customer documents must not depend on `quickbooksDocumentType`
`quickbooksDocumentType` is **external-integration metadata only.** It must not be
the authoritative source for receipt-versus-invoice selection, receipt title, A4
template selection, print eligibility, or any customer-facing document label.

Document selection uses local AxloPOS financial semantics: a fully paid local sale
is a receipt, a partial or credit sale is an invoice/credit document, a return is a
return document. The Exchange renderer is unchanged.

A null external document type must never cause a runtime exception, a blank document
title, the wrong template, "Synced to QuickBooks" wording, a missing print action, or
an invalid API response.

`postPayment()` must **not** be added to `AccountingProvider` during Slice 5 or 5.5.
`PaymentsService.create` is unimplemented and there is no characterised standalone
payment workflow. Restaurant split and mixed payments will initially be local
`Payment` records inside an order/sale completion transaction. Add a separate
accounting payment operation only when an approved, implemented workflow exists —
paying an existing credit invoice later, posting a payment separately from sale
creation, or applying a settlement against a previously created invoice. **Do not
design speculative provider operations.** Recorded in
[`02-provider-abstractions.md`](./02-provider-abstractions.md).

---

## 2026-08-05 — Slice 6B review

### D27 — Local customer return-document kind (resolves Risk AG)

`CustomerReturnDocumentKind` is decided from **local financial facts**, never from
`Return.quickbooksDocumentType`. For a return whose original sale was filed under
`AccountingProviderKind.NONE`:

* a positive monetary refund actually issued → **`REFUND_RECEIPT`**;
* no money refunded, but store credit issued or an unpaid balance reduced →
  **`CREDIT_NOTE`**.

**Mixed results.** A return that contains both a monetary refund *and* a credit or
balance adjustment uses **`REFUND_RECEIPT`** as the primary document kind, and must
show three separate values — monetary refund, store credit issued, and
outstanding-balance reduction. **These must never be combined into a single
"refund" amount**, which would overstate the cash returned.

Not yet reachable: `Return.refundMethod` is a single method and `createCompleted`
writes exactly one `RefundPayment`, so no mixed return can currently exist. This
decision governs whichever slice introduces multi-method refunds; a
`CustomerReturnDocumentKind` of `REFUND_RECEIPT` must not be taken as a licence to
print one combined figure.

**QuickBooks tenants are unchanged.** Wherever an external document type exists it
stays authoritative for the printed label, so a QuickBooks tenant's documents are
byte-identical. The local kind and the external `QuickBooksReturnDocumentType`
remain two separate decisions with two separate resolvers, deliberately: the
implemented rules diverge for a **partially-paid sale refunded in money**, where
local semantics say refund receipt (cash left the drawer, and the return does not
reduce the sale balance) and QuickBooks says credit memo. That divergence is pinned
by test rather than reconciled.

### D28 — Product QuickBooks treatment routes on `InventoryMode` (resolves Risk AF)

Product QuickBooks treatment must be removed for tenants that do not use QuickBooks
inventory, and the routing key is **`InventoryMode`, not `AccountingProviderKind`**:

| Mode | Product behaviour |
|---|---|
| `QUICKBOOKS` | Preserve today's pull/push, QuickBooks item ids, and sync statuses. Existing Tile Shop behaviour is unchanged. |
| `LOCAL` | Locally managed. Create/update/deactivate must **not** enqueue a QuickBooks product sync. Stock operations use `LocalInventoryProvider`. |
| `DISABLED` | A catalogue may exist. No availability enforcement, no stock mutation, no QuickBooks product synchronisation. |
| `EXTERNAL` | Fail closed until an approved implementation exists. |

Deferred to **Slice 6C-B — Product Catalogue and Synchronization Provider
Adoption**, and explicitly out of scope for Slice 6C-A.

Constraints on that slice: the provider abstraction owns the routing decision.
`ProductsService` must not acquire `if (accountingProvider === NONE)` or
`if (inventoryMode !== QUICKBOOKS)` conditionals, and `BusinessProfileService` must
not be injected into it merely to trade one hard-coded QuickBooks branch for
several profile branches. Before implementing, decide between extending
`InventoryProvider` with provider-neutral product lifecycle operations and
introducing a separate `CatalogProvider`.

Unsupported combinations must also be audited rather than silently accepted —
notably **`LOCAL` inventory + `QUICKBOOKS` accounting** and **`DISABLED` inventory +
`QUICKBOOKS` accounting**, since QuickBooks accounting documents may require valid
QuickBooks item mappings that neither mode maintains.

### D29 — Inventory-mode changes are unsupported once stock has moved

Inventory authority and accounting provenance are **separate concepts**. A return
resolves accounting from the original sale's provenance (D-Slice 6B) but resolves
inventory from the tenant's **current** `InventoryMode` — there is no per-sale
inventory provenance, and inferring one from QuickBooks accounting metadata would
conflate the two.

That is only safe if the mode cannot change underneath existing transactions. No
safe transition mechanism exists (no stock migration, no per-sale inventory
authority record), so `BusinessProfileService.updateProfile` **refuses** to change
`inventoryMode` once inventory-affecting transactions exist for the tenant.

Allowed regardless: a write that does not change the effective mode — which
includes legacy-default → explicit `QUICKBOOKS`, since the legacy default *is*
`QUICKBOOKS`. Allowed for a tenant with no completed sales and no returns: any mode.

No migration. The guard reads existing tables.

---

## 2026-08-05 — Slice 6C-B review

### D30 — Architectural-test integrity standard (resolves Risk AH)

The standard introduced during Slice 6C-A.5 is now a **permanent AxloPOS
engineering rule**, and applies to every future slice.

It exists because Slice 6C-A shipped structural tripwires that were green while
asserting something false. That is a worse failure than a missing test: a missing
test is visibly missing, whereas a vacuous one is indistinguishable from a passing
one and actively discourages anyone from looking again.

**A structural, scope-control or source-inspection test must not pass merely
because:**

- Two counts happen to be equal.
- A searched string is absent from both the adopted and the unadopted path.
- An analyser silently ignored a file.
- A fixture does not represent the real production structure.
- A regular expression fails to match either the valid or the invalid state.
- A renamed symbol caused the test to inspect nothing.
- The test asserts only that a future feature is absent, without proving the
  expected current path exists.

**Required standard:**

1. Assert the expected current behaviour **positively**.
2. Assert the prohibited or future behaviour **negatively**.
3. Prefer exact file or importer **sets** over counts.
4. Use **runtime provider spies** where possible, in preference to source text.
5. **Mutation-prove** high-risk architectural tripwires.
6. Ensure analysers have tests for: valid source, invalid source, empty source,
   a renamed symbol, nested or multiline syntax, and every applicable import form.
7. **Fail** if the analyser inspects zero relevant files unexpectedly.
8. Report which architectural tests were mutation-proven.

**Scope of the mutation requirement.** Focused, inline mutation proofs at
high-risk boundaries only. No repository-wide mutation-testing framework is
introduced, and none should be added as a side effect of this rule.

Recorded operationally in
[`05-testing-strategy.md`](./05-testing-strategy.md#architectural-test-standard-in-brief-d30)
and in the repository engineering guide (`CLAUDE.md`).

### D31 — Product presentation routes on the effective profile, resolved once

The product screens must reflect the tenant's `InventoryMode`, and the **only**
admissible source for that mode is `GET /v1/platform/profile`. It must never be
inferred from `quickbooksItemId`, `syncStatus`, the product name, the business type,
or the presence of a QuickBooks connection — none of those can distinguish "this
tenant does not use QuickBooks" from "this tenant uses QuickBooks and this product
has not reached it yet".

The decision is taken **once**, in a pure resolver
(`apps/web/src/lib/products/product-presentation.ts`), which returns view flags.
Components read flags; no product component compares an inventory mode. This is the
frontend counterpart of the D28 constraint on `ProductsService`, and for the same
reason: replacing one hard-coded QuickBooks branch with several profile branches
spread across a table, a detail page and three wizard steps is not an improvement.

| Mode | Product interface |
|---|---|
| `QUICKBOOKS` | Unchanged. Sync status, explicit sync, refresh, accounts panel and existing wording all preserved. Legacy tenants resolve here. |
| `LOCAL` | Provider-neutral "Locally managed". Stock is real and editable. No sync surface of any kind. A null `quickbooksItemId` is never styled as a fault. |
| `DISABLED` | "Catalogue item" / "Stock tracking disabled". Full CRUD, no stock figures, no sync surface. |
| `EXTERNAL` | Fails safe: a generic configuration warning, and no fallback to QuickBooks or Local. |
| Unresolved | While loading **and** after a failed profile request: neutral, no external action, no claim about stock. The client never defaults to the legacy configuration. |

`Product.syncStatus` is unchanged and remains legacy external-integration state. No
Prisma migration.

**Hiding is usability, not security.** Backend provider resolution and permission
enforcement remain the authority; a hidden control is still refused server-side.

---

## Open decisions

| ID | Question | Needed by |
|---|---|---|
| O1 | `mockSync()` fabricates QuickBooks document ids for a *disconnected Tile Shop tenant*, writing synthetic ids into financial records. Preserve, or change deliberately? | Phase 2 |
| O2 | Redis: yes or no? Determines the Socket.IO multi-replica adapter (D7, D11) and the settings-cache invalidation strategy. | Phase 4 |
| O3 | Service-charge tax treatment specifics, to be confirmed with an accountant (D8). | Phase 8 |
| O4 | Pilot restaurant: which tenant, how many branches, which printers, which channels. | Phase 4 |
| O5 | Commercial model (per-branch / per-register / per-module) — blocks subscription and entitlement design. | before entitlements |
