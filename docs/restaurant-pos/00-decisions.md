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

## 2026-08-05 — Slice 7 review

### D32 — Authentication throttling is a storage abstraction, not a claim

Login, PIN login and refresh are rate-limited on **two dimensions at once** — a
source dimension and an identity dimension — because either alone is trivially
defeated: identity-only loses to a botnet against one account, source-only loses to
a spray across many accounts from one address. The strictest verdict wins.

The identity key is **tenant-scoped**. Keying on the email alone would let a failed
campaign against `owner@acme.test` in tenant A lock out the unrelated
`owner@acme.test` in tenant B — one tenant denying service to another through a
shared address. PIN keys never contain the submitted PIN, which would otherwise hand
an attacker a fresh allowance per guess.

A successful authentication **clears** the keys it spent, so recovery is not punished.

Responses are a generic 429 with `Retry-After` and nothing else — no indication of
which counter tripped, whether the account exists, or which tenant it is in.

**Client IP is resolved by counting from the RIGHT of `X-Forwarded-For`**, `N` hops
in, where `N` is `TRUSTED_PROXY_HOP_COUNT` (default **0** = ignore the header). The
left-most entry is attacker-controlled; trusting it is the most common rate-limiter
bypass there is. The default fails safe: a deployment that forgets to configure it
gets a limiter that is too aggressive behind a balancer, not one that is silently
bypassable.

**The limitation, stated plainly.** `MemoryRateLimitStore` is process-local
(`isDistributed === false`). It protects a single replica. With several replicas each
holds its own counters and the effective allowance multiplies. This is **not** a
multi-replica correctness model, and Phase 1 does not claim it is. The boot log says
so on every start. Production with more than one replica needs a distributed
`RateLimitStore` (Redis `INCR`/`EXPIRE` maps onto the interface directly) or an edge
rate limiter. Blocked on open decision O2.

### D33 — Workspace-first authentication, and the disclosure it makes

`POST /auth/login` accepts an optional `workspace` slug. Resolution order: `workspace`
→ `x-tenant-id` header → unique match on the email alone. All three are
client-supplied and only ever **narrow** the lookup; the password is always verified
against the resolved user's own hash, so a wrong value can only make a login fail.

An email held by several active workspaces returns `AUTH_WORKSPACE_REQUIRED` (409)
instead of the generic 401 that Slice 3.5 introduced. **This is a deliberate change
to an existing behavioural assertion**, and the reason is that the 3.5 behaviour left
a legitimate user with no way forward — correct passwords simply stopped working with
nothing to act on.

The residual disclosure is recorded rather than hidden: the response reveals that the
address exists in **more than one** workspace. It reveals no names, no slugs, no
count, and nothing about any particular workspace. Single-workspace addresses — the
overwhelming majority — disclose nothing at all and return the same generic 401 as an
unknown address. The ambiguous branch also short-circuits before any bcrypt round,
which is asserted explicitly; it adds nothing beyond what the response already says.

An unknown *or deactivated* workspace is indistinguishable from a wrong password.

### D34 — One authority for roles and permissions; settings are eventually consistent

`@hardware-pos/shared` is the single definition of `UserRole`, `Permission` and
`ROLE_PERMISSIONS`. `apps/api` and `apps/web` re-export it. Both copies had already
drifted before this slice — the shared `UserRole` was missing `OWNER` and
`ACCOUNTANT`, and the web permission list never received the two `PLATFORM_PROFILE_*`
entries added in Slice 4 — and nothing failed, because nothing compared them.
Parity is now asserted against the Prisma enum. Restaurant permissions extend this
map; there will be no second permission authority.

**Settings consistency window.** The settings cache was hydrated at boot and
refreshed only by writes on that process, which with several replicas was not stale
but *permanently wrong*. Each entry now records when it was read and revalidates in
the background past `SETTINGS_CACHE_TTL_MS` (30s). The guarantee:

> A settings write is observable on every replica within
> `SETTINGS_CACHE_TTL_MS` + one database round trip, and immediately on the replica
> that performed the write.

Deliberately eventual: settings are display and policy defaults. Anything that must
be immediately correct across replicas — module access, provider routing — does not
use this cache and reads the database per request, because a stale module revocation
would fail **open** (D11).

### D35 — Route-module matrix, and where guards are deferred

Every one of the 139 routes is classified, enforced by a spec that reads Nest's own
metadata. See [`route-module-matrix.md`](./route-module-matrix.md). 79 routes carry
`@RequireModule`; 60 do not, each for a stated reason.

Notably **`/products` is `SHARED_CORE`, not `INVENTORY`** — products are the
catalogue, which every business profile needs, while `INVENTORY` means stock tracking,
already governed by `InventoryMode` (D28, D31). Gating catalogue CRUD on `INVENTORY`
would stop a Restaurant tenant managing its own products.

`RETAIL_POS` on sales/payments/receipts is classified but **not yet enforced**:
gating it would deny a Restaurant tenant read access to its own sales history, and
splitting read from write needs the Phase 2 ordering model settled.

`@Public()` routes cannot carry a module guard — `ModuleAccessGuard` denies anything
requiring a module without an authenticated tenant — so the QuickBooks OAuth callback
and the public quotation link enforce their own tokens instead.

Tile Shop is unaffected throughout: every gated module is in the legacy default set.

---

## Phase 1.5 — platform and branch security hardening

Approved at the Phase 1 checkpoint. The phase was renamed from "Restaurant Phase 2"
because it contains no restaurant domain entity and no restaurant operational
workflow; see [`phase-1_5-plan.md`](./phase-1_5-plan.md).

### D36 — Roles are per-tenant rows, never shared

`Role.tenantId` is `NOT NULL`. Each tenant owns its five built-in roles plus any it
creates, and no row is shared between tenants.

The alternative — global built-in rows with `tenantId NULL` and per-tenant
overrides — stores fewer rows and creates a cross-tenant **write** surface: one
`OWNER` row serving every tenant means any update path that forgets its
`tenantId` predicate edits every tenant at once. That is the same class of defect
as D-slice-3.5's login lookup, which returned an arbitrary tenant's user because
the query had no tenant predicate. Paying five rows per tenant at provisioning is
the cheaper side of that trade.

Consequence: `provision-tenant.ts` and `seed.ts` must seed the built-in roles, and
a tenant created without them has no role rows — which must fail closed, not fall
through to "no permissions".

### D37 — Permissions are a code catalogue; the database stores only assignments

The list of permissions that exist stays in `packages/shared` as a TypeScript
union. The database stores which role holds which permission, and nothing else.

A `Permission` table that tenants can insert into invites permissions the codebase
has never heard of. No decorator references them, no guard enforces them, and they
grant exactly nothing — while looking, in an admin screen, like access control. The
compiler is the right authority for *what can exist*; the database is the right
authority for *who has it*.

Permission string values are already treated as an immutable storage contract
(`authorization.ts`), which this makes load-bearing rather than aspirational.

### D38 — The access token carries `activeBranchId`, and the server re-validates it every request

The claim is a hint, never proof. `BranchScopeGuard` re-checks on every
branch-scoped request that the branch belongs to the authenticated tenant, is
active, and is still one the user may use — and that any register named belongs to
that branch.

This is what makes the Product Owner's requirement satisfiable: *"branch access
changes must not remain valid indefinitely because an old JWT contains a branch
ID."* Trusting the claim would make revocation wait for token expiry. Resolving the
branch per request with no claim at all would also be correct, but it loses the
ability to switch branches without a stored preference, and it still costs the same
lookup the validation costs.

Fails closed: a claim naming a branch the user may no longer use is a 403, not a
fallback to the user's default branch — silently serving a *different* branch's data
than the client believes it is showing is worse than refusing.

### D39 — No Redis yet; the abstraction ships, the dependency does not

`RateLimitStore` keeps its process-local implementation as the only one. The
distributed contract is specified and the deployment requirement documented, and
the API refuses to start if it is configured for several replicas without a
distributed store — rather than starting and quietly protecting one process.

The same abstraction is reused for cross-replica settings invalidation, so
answering O2 later switches both at once. Until then **multi-replica operation is
unsupported and is documented as such**, which is honest where "we have rate
limiting" would not be.

O2 stays open. It becomes forced at Phase 4, where the Socket.IO adapter needs a
shared backplane and no abstraction can paper over it.

### D40 — The dormant `Role` / `Permission` tables are adopted, not replaced

`Role`, `Permission` and `User.roleId` already exist in the schema. They hold
**zero rows in every environment**, and no application code reads or writes them —
grep finds no `prisma.role`, no `prisma.permission`, and no non-spec use of
`roleId`. They are scaffolding from an earlier design that was never wired up.

Phase 1.5 adopts these tables rather than adding a parallel set. Two consequences:

- The migration is far smaller than planned, and carries **no data migration** —
  there is no data.
- `Role` is keyed `@@unique([tenantId, name])`, i.e. on a *display name*. A built-in
  role identified by the string an admin can rename is a defect waiting to happen,
  so an additive `Role.key` column is required, unique per tenant, holding the
  stable `OWNER` / `ADMIN` / … identifiers. `name` becomes presentation only.

Recording this because a reader of the Phase 1 plan would reasonably assume these
tables were part of the working system. They are not, and a structural test that
asserted their existence would have passed while proving nothing.

---

## 2026-08-11 — Restaurant Menu Wizard

### D41 — Additive presentation fields on `MenuItem` + role marker on `ModifierGroup`
Approved to unblock the Add Menu Item wizard whose mock includes fields the
schema does not persist today.

**Additive columns** (migration `20260811000000_add_menu_item_presentation_fields`):

- `MenuItem.imageUrl TEXT NULL` — item photo URL; media pipeline reuses the
  one `Product.imageUrl` already uses. NULL renders the menu card placeholder.
- `MenuItem.itemType MenuItemType NULL` (enum `FOOD | BEVERAGE | DESSERT`) —
  wizard segmented control. NULL on legacy rows (Menu filter treats as unset).
- `MenuItem.dietaryTags TEXT[] NOT NULL DEFAULT '{}'` — presentation chips
  (Veg / Non-Veg / Egg / Spicy / Gluten-Free). Tenants may add more strings;
  server does not enforce vocabulary.
- `MenuItem.prepMinutes INTEGER NULL` — menu-level preparation estimate.
  Distinct from `KitchenTicket.prepMinutes` which is a per-ticket actual.
  NULL on legacy rows and Prepared Dishes without an estimate.
- `ModifierGroup.role TEXT NULL` — wizard marker. `'SIZE'` for variation groups
  (Small / Medium / Large); NULL for ordinary groups. Server enforces nothing
  on this string — it is a frontend semantics marker so an edit round-trip does
  not lose the wizard's intent.

**Non-goals of D41:**

- No new media pipeline. `imageUrl` accepts a URL string; upload plumbing is
  the pre-existing product-image mechanism.
- No dietary-tag enum. Tenants can add strings ad-hoc.
- No enforcement of `ModifierGroup.role` values on the server.

**Compatibility:** every new column is nullable or has a safe default read.
Pre-migration rows remain valid; existing callers that omit the new fields
receive the previous behaviour.

**Variations pricing (approved with D41):** Small/Medium/Large are persisted
as `ModifierOption.priceDelta` on a `ModifierGroup(selection=SINGLE, min=1,
max=1, role='SIZE')`. The wizard UI collects and displays the *adjustment*
(Small +0, Medium +300, Large +600). One arithmetic authority, no double
storage. POS renders it exactly like any SINGLE modifier group.

### D42 — Menu item Delete uses archive semantics
The card `•••` menu presents "Delete" to the operator but the implementation
sets `isActive = false` via `PATCH /menu-items/:id`. Historical orders,
kitchen tickets, bills and reports retain the item unchanged — a hard
delete would break the historical join. Wording on the confirmation dialog
makes this explicit to the operator.

Never-used items may still be true-deleted in a follow-up if the backend
grows a safe path for it; the wizard does not need it.

**Superseded 2026-08-12 by D43.**

### D43 — Menu admin: hard delete + Set Active/Inactive as distinct actions

Product Owner requires permanent delete for Menus, Sections and Menu Items.
The domain supports it safely: `RestaurantOrderItem` / `KitchenTicketItem`
carry `menuItemName / menuItemCode / unitPrice / modifierTotal` snapshots at
submit time, and `menuItemId` on those rows is a **loose string reference**
with no Prisma relation. Deleting a `MenuItem` does not cascade into finance
or kitchen history.

Split the two operations on the card `•••` menu:

- **Set Active / Set Inactive** — `PATCH /menu-items/:id { isActive }`. The
  archive verb of the old D42. Historical rows untouched. POS hides the item
  while it is Inactive (server-enforced via the existing `isActive` filter);
  the server also refuses a POS attempt to add an Inactive item to an order.
- **Delete permanently** — `DELETE /menu-items/:id`. Refuses with a
  structured 409 (`ITEM_ON_OPEN_ORDER`) if any `RestaurantOrderItem` for the
  item is on an order in `DRAFT / SUBMITTED / PARTIAL`. Once every open
  reference closes (`COMPLETED / CANCELLED`), delete succeeds.
- **Sections** — `DELETE /menu-sections/:id`. Refuses with `SECTION_HAS_ITEMS`
  if any `MenuItem` is still attached (active or inactive). Operator must
  move or delete items first.
- **Menus** — `DELETE /menus/:id`. Refuses with `MENU_HAS_SECTIONS` if the
  menu still contains any section.

**Permissions** — reused `PRODUCT_MANAGE` per Section 2 of the brief ("Reuse
equivalent existing permissions instead of creating duplicates"). Held by
OWNER + ADMIN today; MANAGER + CASHIER do not have it. A dedicated
`MENU_DELETE` remains available as a future split without changing the API
contract.

**Image storage** — image upload for the wizard uses the existing
`StorageService` (local disk in dev, S3 in prod; validated MIME, sharp
downscale, WebP re-encode, UUID key). Two endpoints:

- `POST /restaurant/menu-items/image` — standalone, returns `{ imageUrl }`
  the wizard sends on the subsequent `create`. Orphan sweep is a follow-up.
- `POST /restaurant/menu-sections/:sectionId/items/:itemId/image` — attach
  to an existing item (Edit flow), mirrors the Products pattern; old asset
  is retired only after the DB update commits.

---

## 2026-08-12 — Product variants + Purchase Receipts + Weighted-Average

### D44 — Products own variants; Receive Stock owns cost history; costing is weighted-average

Approved for AxloPOS Product Management to gain multi-dimensional variants,
a proper Receive Stock (Purchase Receipt) workflow, and immutable historical
purchase cost. Legacy (variant-less) Products and Tile Shop / QuickBooks
behaviour remain unchanged.

**Domain model.**

- A `Product` is the commercial master. It may have **0..N** variation
  dimensions (`ProductVariationDimension`) — not limited to two. Each
  dimension owns 0..N `ProductVariationOption` rows (e.g. Size → 200ml /
  300ml / 500ml). Every *sellable combination* the operator enables becomes
  one `ProductVariant` with independent SKU, barcode, selling price,
  weighted-average cost, per-branch inventory, and reorder point.
- `ProductVariantOptionValue` fixes one option per dimension for each
  variant. A product with 2 dimensions × 6 enabled variants stores 12 rows
  here — one row per (variant, dimension).
- `Product.hasVariants` is the single boolean the API and UI branch on:
  - `false` → legacy Product; `unitPrice`, `sku`, `costPrice`,
    `quantityOnHand`, `averageCost` on the Product row are authoritative.
    Existing Tile Shop tenants stay exactly here.
  - `true` → the `ProductVariant` rows are authoritative for price, cost,
    SKU, barcode, and per-branch inventory. The parent-level fields remain
    as legacy fallbacks and are never read.
- A `SaleItem`, `ReturnItem`, `MenuItem`, `BranchInventory`, `StockMovement`
  or `InventoryReceiptLine` may carry `productVariantId`; NULL keeps the
  legacy per-product semantics.

**Product variants ≠ Restaurant menu variations.** Menu Small/Medium/Large
remains a `ModifierGroup(role='SIZE', selection=SINGLE)` per D41. Menu
variations are customer-facing customisation of one dish; product variants
are physically distinct stockable items. The wizards share visual language
per the Restaurant Menu Wizard pattern; the domain models stay separate.

**Purchase Receipts / cost history.**

- Vendor stock enters the system exclusively through **Receive Stock**.
  Editing `Product.quantityOnHand` or `ProductVariant`-side quantity from
  the Product form is no longer the supported path for adding stock; the
  wizard's Step 3 "Opening Quantity" applies once, on creation, then Receive
  Stock takes over.
- `InventoryReceipt` (header) + `InventoryReceiptLine` (per-variant line)
  are immutable once written. A correction goes through a new movement,
  never by mutating history. `InventoryReceipt.idempotencyKey` guards
  against a double-submitted form.
- Every receipt writes an append-only `StockMovement` row with
  `reason=RECEIPT`, `refType='INVENTORY_RECEIPT_LINE'`, `refId=line.id`,
  and `unitCost` captured on the movement. Sales / returns / adjustments
  continue to write their existing reasons.

**Weighted-Average costing (MVP).**

- Costing policy is fixed to **`WEIGHTED_AVERAGE`** for the first commercial
  release; no per-tenant switch, no enum column. Every receipt into a
  `(branch, variant?)` cell recomputes:

  `newAvg = ((existingQty × existingAvg) + (receivedQty × unitCost)) / (existingQty + receivedQty)`

  When `existingAvg` is NULL the received `unitCost` is adopted directly.
- The rollup is stored on `BranchInventory.averageCost` (per branch, per
  variant/product); `ProductVariant.averageCost` and `Product.averageCost`
  are updated as the quantity-weighted mean across the variant's / product's
  branches on receive for fast list rendering. All rollups are recomputable
  from the ledger — no rollup is a source of truth.

**FIFO readiness.** No FIFO logic ships. But every `InventoryReceiptLine`
is immutable and every RECEIPT `StockMovement` snapshots `unitCost`, so a
future policy can walk history lot-by-lot without a schema change.

**Selling price is not touched by a receipt.** A cost increase surfaces to
the operator (margin banner on the Variants / Inventory tab); the operator
alone decides whether to change customer price. No auto-repricing.

**Branch-scoped stock is authoritative.** `BranchInventory` becomes the read
authority for variants. `Product.quantityOnHand` is retained per D10 as the
legacy rollup + QuickBooks cache — never dropped, never repurposed. Sales /
returns / restaurant orders still route through the existing
`InventoryProvider` port; the port grows `receiveStock(tx, ctx, lines)`
implemented by `LocalInventoryProvider` (writes `BranchInventory` +
`StockMovement`), refused by `QuickBooksInventoryProvider` (QB is the stock
authority — a future slice adds `PurchaseOrder` push), and refused by
`NoInventoryProvider` (stock tracking is off).

**Module boundary (D28 / D31 respected).** Receive Stock lives in a new
`InventoryReceiptsModule` that holds `InventoryProviderFactory`.
`ProductsService` still resolves ONLY `CatalogSyncProviderFactory` — the
per-slice tripwire at `provider-contract.spec.ts:251-273` stays green.
Variant CRUD lives inside the products module as a `ProductVariantsService`
that holds no provider port at all (it never moves stock — receiving does).

**Frontend routing (D31 respected).** The 4-step Add Product wizard reads
the tenant's inventory mode from `GET /v1/platform/profile` via the pure
resolver at `apps/web/src/lib/products/product-presentation.ts`. Wizard
Step 3 hides Opening Stock / Reorder in `DISBLED` mode; Receive Stock is
suppressed in `QUICKBOOKS` mode with the wording "Stock is managed in
QuickBooks." No component compares an `InventoryMode` value.

**Backward compatibility.**

- Every existing Product remains valid with `hasVariants=false` and no
  ProductVariant rows. The old create endpoint, product form, POS lookup,
  QuickBooks push, retail sale, and return flow all continue unchanged.
- `MenuItem.productId` still means what it did; the additive
  `productVariantId` narrows it to a specific variant when set.
- Every existing sale / return keeps its rows and its printable document.
  `SaleItem.productVariantId` is NULL on all historical rows.

**Migration.** `20260812000000_add_product_variants_and_purchase_receipts`.

- Creates the six new tables listed above.
- Adds nullable / defaulted columns to `Product`, `SaleItem`, `ReturnItem`,
  `MenuItem`, `BranchInventory`, `StockMovement`.
- Adds `RECEIPT` to `StockMovementReason`.
- Replaces `BranchInventory (branchId, productId)` unique with two partial
  unique indexes: `(branchId, productId) WHERE productVariantId IS NULL`
  and `(branchId, productVariantId) WHERE productVariantId IS NOT NULL`.
  The swap is data-safe because `BranchInventory` holds zero rows in every
  environment — Phase 2.5 (D10) shipped the table but no code wrote to it
  until this slice, which is now its first writer.

Additive-only otherwise: no DROP TABLE, no column type change, no rename,
no data backfill. Legacy rows read unchanged. The per-migration structural
assertion lives in `provider-contract.spec.ts` and is mutation-proven by
checking the exact `CREATE TABLE` set, the exact single DROP INDEX
statement, and the presence of every additive column and FK.

---

## 2026-08-13 — Restaurant Product wizard + Promotions

### D45 — Restaurant tenants manage POS-sellable items from Inventory → Products; Menu admin deprecated read-only

Approved to merge Restaurant Menu Item authority into the Product wizard.
Restaurant tenants get a single admin surface (Inventory → Products) with
Restaurant-aware content in the wizard; the `/menu` admin route is removed
from Restaurant navigation. Retail (Tile Shop, Hardware) behaviour is
unchanged — the wizard's Restaurant sections render only for tenants whose
business type resolves to a Restaurant profile.

**Deprecate MenuItem read-only.**

- Existing MenuItem rows stay in the database indefinitely. The
  `GET /restaurant/menu-sections/:sectionId/items` and sibling read routes
  stay live so historical RestaurantOrder / KitchenTicket / Sale rows
  continue to render (each snapshots `menuItemName` / `unitPrice` / etc.,
  but the loose `menuItemId` reference is still used for KOT reprint,
  order detail, and receipt lookup).
- `POST` / `PATCH` / `DELETE` on menu-items and menu-sections continue to
  work at the API level for a transition period — the Restaurant admin UI
  routes to `/products` (redirect at the sidebar level; the raw routes are
  reachable if typed but no navigation exposes them).
- No auto-conversion. Tenants re-create existing menu items as Restaurant
  Products at their pace; the transition is a UX decision, not a data
  migration.

**Domain shape.**

- Restaurant-specific columns land on `Product` — `prepMinutes Int?`,
  `dietaryTags String[]`, `foodType MenuItemType?`. All nullable /
  defaulted so Retail rows stay valid with no backfill. `foodType`
  reuses the D41 `MenuItemType` enum (FOOD / BEVERAGE / DESSERT) to
  avoid a second authority.
- `ProductVariant.isDefault Boolean` marks the variant a Restaurant POS
  quick-add picks when the operator taps the product card without
  opening the picker. Uniqueness of "one default per product" is
  enforced by a partial unique index (Prisma cannot declare it).
- Two new junctions promote existing MenuItem relationships to Product:
  `ProductModifierGroup(productId, modifierGroupId, position)` and
  `ProductStationLink(productId, stationId)`. Both are peers of the
  existing MenuItem junctions; ModifierGroup rows themselves are
  tenant-scoped and reusable, so a group can be attached to both a
  Product AND a MenuItem during the transition window without a data
  copy.
- Kitchen station routing widens at KOT time: `KitchenService.
  generateTicketsForRound` reads station IDs from EITHER
  `MenuItemStationLink` OR `ProductStationLink` depending on how the
  round item was sourced. A `RestaurantOrderItem.sourceKind` (or
  equivalent discriminator) is used to pick the correct junction — DB
  schema unchanged, service resolution widened.

**Promotions vs Discounts — new peer domain.**

- New `Promotion` + `PromotionItem` models cover **scheduled auto-apply
  rules** — bundle fixed price, BOGO, %/$ discount — with day-of-week,
  time-of-day, date range, branch scope, and channel scope.
- `PromotionType`: `BUNDLE_FIXED_PRICE | BUY_X_GET_Y |
  PERCENTAGE_DISCOUNT | FIXED_AMOUNT_DISCOUNT`.
- `PromotionItemRole`: `BUY | GET | BUNDLE`.
- The existing `Discount` model stays authoritative for operator-applied
  retail line/order discounts at sale time. Promotion is its peer, not
  its replacement. No `Discount` field is renamed or migrated.
- **Server-side evaluation is the authority.** POS shows a promotion
  badge only when the server confirms the promotion is currently valid
  for the tenant, branch, channel, date, and time-of-day. Client-side
  computation is advisory (preview only).
- **Stacking policy defaults to false** — promotions do not stack unless
  explicitly allowed via `Promotion.stackable`.

**D45 scope — what ships now vs what defers.**

Per Product Owner scope decision: **models + admin CRUD + POS badge**
ship in this slice.

Ships:

- Prisma migration `20260813000000_add_restaurant_product_wizard_promotions`.
- Restaurant-aware Product wizard step 3 (Modifiers / Offers /
  Availability / Kitchen).
- Promotions admin page (`/products/promotions` under the Inventory tab
  set) with list + create + edit + activate/deactivate.
- POS Catalogue endpoint that returns active Restaurant Products with
  variants + modifier groups + station routing + a `promotions` array
  of currently-valid promotions per product.
- POS shows the promotion badge for items with an active promotion.

Defers (follow-up slice):

- Sale-close integration — freezing the promotion discount into
  `RestaurantOrderItem` snapshots, auto-inserting BOGO reward lines,
  routing reward lines to KOT, reducing stock for the reward.
- Bundle auto-collapse in the cart.
- Receipt line for the promotion discount.

**Frontend routing (D31 respected).**

- Business-profile-aware step content in the Product wizard: Restaurant
  tenants see Step 3 with Modifier Groups / Promotions / Availability /
  Kitchen Station; Retail tenants see Step 3 with the existing Pricing
  & Inventory content only.
- The `presentation.managementMode` resolver gains a `businessKind` hint
  (Restaurant vs Retail) — components never compare `businessType`
  directly, matching D31's rule.

**Backward compatibility.**

- Every existing Product row remains valid — the new columns are
  nullable / defaulted. Retail Products (no `foodType`, no `dietaryTags`)
  render exactly as they do today.
- Every existing MenuItem, RestaurantOrder, KitchenTicket, Sale, and
  Receipt continues to function against the untouched MenuItem tables
  and API.
- `POST /restaurant/orders/:orderId/rounds` gains an optional
  `sourceKind: 'MENU_ITEM' | 'PRODUCT' | 'PRODUCT_VARIANT'` field
  (default `'MENU_ITEM'`) so existing clients keep working; new
  Product-sourced round items use the new discriminator.

**Migration.** `20260813000000_add_restaurant_product_wizard_promotions`.
Purely additive: 4 new tables, 2 new enums, 3 additive Product columns,
1 additive ProductVariant column, 1 partial unique index. No DROP, no
ALTER COLUMN SET NOT NULL, no RENAME. `MenuItem*` and `Discount` are
untouched — the per-migration structural spec in
`provider-contract.spec.ts` enforces this via mutation-provable
negative assertions.

---

## 2026-08-14 — POS Product Variations in the Customise dialog

### D46 — Restaurant POS Counter's Customise dialog exposes Product Variations as a single-select radio group; round submit + KOT preserve the variation

Approved to expose the `ProductVariant` selection introduced by D44 in the
Restaurant POS Customise popup, and to unblock the last piece D45 deferred:
sending Product-sourced round items to the kitchen. Variation is a
distinct concept from Additionals (Modifiers) — the two are collected and
rendered separately, with different selection semantics.

**Two customisation concepts, deliberately separate.**

- **Variation** (Small / Medium / Large) — physically distinct sellable
  variants of the Product, each with its own absolute selling price. The
  Customise dialog renders them as a **single-select radio group**;
  selecting Large deselects Medium. Backed by `ProductVariant` rows
  created via the D44 wizard. Selling price is the variant's own
  `unitPrice` — NOT a base price + variant delta.
- **Modifier / Additional** (Extra Chicken, Extra Cheese, No Onion) —
  customisation options that add / subtract from the item price. Rendered
  as a **multi-select checkbox group** with the existing
  `ModifierGroup.selection / minSelections / maxSelections` constraints.
  Backed by `ProductModifierGroup` (D45) attaching `ModifierGroup` rows
  to the Product.

The two must not collapse into one concept — modelling Small / Medium /
Large as SIZE-role modifiers (the D41 pattern for Restaurant menu items)
was correct there but would duplicate D44's variant authority for
Products and break the cart identity + snapshot discipline this decision
requires.

**Cart identity + round submit.**

- `DraftLine` extends with `productId?`, `productVariantId?`,
  `variantName?`, `variantPrice?`. The cart continues to be a
  local-only draft — server remains the pricing authority.
- `RestaurantOrderItem` gains a `sourceKind` discriminator
  (`MENU_ITEM | PRODUCT`, default `MENU_ITEM` so every historical row
  keeps semantics), plus `productId?` + `productVariantId?` FKs and
  `variantNameSnapshot?` + `variantPriceSnapshot?` for reprint /
  receipt / audit.
- `submitRound`'s `OrderItemInputDto` gains `sourceKind` +
  `productVariantId?`. The service resolves name / price / isActive
  from EITHER `MenuItem` (legacy) OR `Product`+`ProductVariant` (D46)
  depending on the discriminator. Cross-tenant, inactive-variant,
  mismatched-variant-for-product are rejected at the service — client-
  provided price is NEVER financial authority.
- `KitchenService.generateTicketsForRound` widens station lookup: for
  a `PRODUCT`-sourced item it reads `ProductStationLink` (D45); for
  `MENU_ITEM` it reads the existing `MenuItemStationLink`. Un-routed
  items still fall to the silent `__unrouted__` bucket the earlier
  audit flagged — that is out of scope for this slice.

**KOT / snapshot discipline.**

- `KitchenTicketItem` gains a nullable `variantName?` — the KOT prints
  "MEDIUM" / "LARGE" verbatim. The kitchen must not infer the variant
  from the selling price (the brief calls this out explicitly).
- Every snapshot column on `RestaurantOrderItem` is IMMUTABLE once
  written. A later variant rename or price change cannot rewrite
  historical orders, bills, receipts, or KOT reprints.
- Sale-close (`table-sessions.service.closeSession`) reads only from
  snapshot columns, so it is source-agnostic — no change needed there.

**Default variant preselection.**

- The Customise dialog preselects the variant whose `isDefault=true`
  (D45 partial unique index guarantees at most one). When no default
  exists, selection is required; Add to Cart stays disabled with a
  hint "Select a size to continue" that appears only after the operator
  has interacted with the dialog.
- A Product with one active variant either auto-selects or hides the
  Variation section entirely (per existing "one meaningful option"
  UX). Products with zero variants render the dialog without a
  Variation section.

**Backward compatibility.**

- Every existing `RestaurantOrderItem` row remains valid — `sourceKind`
  defaults to `MENU_ITEM`, `productId` / `productVariantId` /
  `variantNameSnapshot` / `variantPriceSnapshot` all default NULL.
- The legacy MenuItem POS path (Restaurant tenants who still have
  MenuItem-based rounds during the D45 read-only-deprecate transition)
  continues to work unchanged.
- Tile Shop and other Retail tenants are unaffected — Restaurant POS
  is the only consumer.

**Migration.** `20260814000000_add_pos_variation_snapshots`. Purely
additive: one new enum, three additive columns on `RestaurantOrderItem`,
one additive column on `KitchenTicketItem`, two indexes + two FKs
(`ON DELETE SET NULL` so a Product deletion never cascades into
historical rows). No DROP, no ALTER COLUMN SET NOT NULL, no rename.
`menuItemId` stays a loose string reference exactly as before. Per-
migration structural test in `provider-contract.spec.ts` enforces the
positive shape AND the mutation-provable absence of destructive
statements.

### D47 — Table reservations by timeslot; Calendar page; `RESERVATIONS` becomes a default food-service module

Approved to let restaurant operators reserve tables for customers by
timeslot, and to add a **Calendar** navigation item where the day's
reservations are viewed on a tables × time grid, with navigation to past
and future days.

**Model.** New `TableReservation` + `ReservationStatus` enum
(`BOOKED → SEATED → COMPLETED`, terminal `CANCELLED` / `NO_SHOW`).

- Tenant/branch/table scoped, same cascade posture as `TableSession`.
- A timeslot is a half-open interval `[startAt, endAt)` chosen at booking
  (start time + duration). No fixed slot table: slots are a *rendering*
  granularity (the Calendar draws 30-minute rows), not a storage concept,
  so service hours or slot sizes can change without a migration.
- `customerId` is an **optional** FK (`ON DELETE SET NULL`);
  `customerName` / `customerPhone` are **snapshots** captured at booking.
  Phone reservations must not force creating a Customer row, and the
  calendar must render without a join and survive customer deletion —
  same snapshot discipline as `RestaurantOrderItem` (AD-15).
- `reservationNumber` `RSV-######` via the existing `DocumentSequence`
  (`'RESERVATION'` joins the `DocumentType` union; no migration needed).
- `createdByUserId` nullable-but-always-written, matching the
  `DiningArea` creator pattern. Reservations are NOT creator-owned:
  any staff member holding the permission can manage any reservation —
  a shared front-of-house book, not a personal artifact.

**Double-booking rule.** A table cannot hold two reservations in
ACTIVE states (`BOOKED`, `SEATED`) whose intervals overlap. Enforced in
the service inside the write transaction, serialized per table by a
`SELECT … FOR UPDATE` on the `RestaurantTable` row — the same
row-as-mutex shape used elsewhere; two clerks booking the same table
race on the lock, and the loser gets a 409. A Postgres exclusion
constraint was rejected: Prisma cannot model it, `migrate diff` drift
checks would fight it, and the service is already the financial/state
authority everywhere else. Reservations do NOT check `TableSession`
occupancy — a table can legitimately be seated now and reserved for
later; the front of house owns that judgement.

**Permissions.** Three new active keys, `reservation:view`,
`reservation:create`, `reservation:manage` (edit / status transitions).
All three go to every food-service template that touches the floor
(`RESTAURANT_MANAGER`, `WAITER`, `RESTAURANT_CASHIER`) and to the
built-in `MANAGER` / `CASHIER` roles — a host stand cannot function if
cancelling a booking needs a manager. OWNER/ADMIN derive as usual.

**Module gating.** Routes live under `@RequireModule(ModuleKey.RESERVATIONS)`.
`RESERVATIONS` **moves from opt-in to the default food-service module
set** — the Release 1 / Release 2 boundary in `platform.constants.ts`
moves deliberately: reservations are now part of the pilot scope. The
two assertions that pinned it out of the defaults
(`business-profile.service.spec.ts`, `platform.constants.spec.ts`) are
updated citing this decision (permitted per D16: a decision record says
otherwise). Retail tenants are untouched — the module is food-service
only.

**Calendar page.** New `/calendar` route + nav item (Service group,
gated `module: RESERVATIONS`, `permission: reservation:view`). Day view:
tables grouped by dining area on one axis, the service day as 30-minute
slots on the other; reservations render as blocks spanning their
interval. Prev / Today / Next plus a date input reach past and future
days (past days are read-only history — no new bookings in the past).
Clicking an empty slot opens the booking dialog pre-filled with that
table + time; clicking a block opens edit / seat / cancel / no-show.
The API lists by explicit `[from, to)` instants supplied by the client —
the server does not guess the display timezone.

**Deferred, deliberately.** Linking a seated reservation to the
`TableSession` it becomes (would give per-cover analytics; lands
additively later). Deposits/prepayment. Guest-facing booking. Reminder
messaging. Capacity-aware overbooking warnings.

**Migration.** `20260815000000_add_table_reservations`. Purely additive:
one new enum, one new table, indexes + FKs (`ON DELETE CASCADE` from
tenant/branch/table like `TableSession`; `SET NULL` for customer and
creator). No DROP, no column changes to existing tables.

### D48 — Email + password is the only login path; PINs are approval-only

The login page's Cashier PIN box and the `POST /auth/pin-login` endpoint are
removed. Signing in — web form or API — requires an email and password,
workspace-scoped as before (Slice 8.2). Requested by the Product Owner with
the login redesign.

**What PINs still do.** In-POS approval prompts (discount over the cap,
returns) keep verifying PINs via `findUserByPin` — that is an *authenticated*
check inside a session, not a way to mint one. Seeded users keep their PINs
for exactly that purpose.

**What went with the endpoint.** The device-commissioning tenant memory
(Slice 8.8 `rememberTenant`/`recallTenant`) existed only so a pre-auth PIN
POST could name its tenant; with the endpoint gone it is deleted, along with
the `pin-login` throttle policy and its rate-limit keys. Workspace memory
(the slug prefill) is unrelated and stays.

**Seed consequence.** Roles that previously logged in by PIN now carry
email + password in the dev seed (`manager@` / `cashier@hardwarepos.test`,
`restaurant.cashier@axlopos.test`); their PINs remain as approval PINs.
Slice 8.8's WS-201/202 acceptance rows are superseded by this decision —
the tenant-boundary claim they made is now asserted through
workspace-scoped email login instead.

**Continuation — the workspace field goes too.** The login form asks only
for email and password; the workspace is identified from the email. The
`AUTH_WORKSPACE_REQUIRED` flow (Slice 8.2) survives as progressive
disclosure: the field renders ONLY after the server answers that the email
lives in more than one workspace — otherwise a duplicate-email user would
be locked out with no recourse. `?workspace=` deep links are still
honoured, silently. The per-device workspace memory is deleted with the
visible field: silently replaying a stale remembered slug would fail a
valid login with no visible cause (a slug narrows the search, never widens
it — WS-104).

### D49 — Open tables: ad-hoc joined tables with auto-release on bill close

Approved for the situation the PO described: a party of six, no six-top
free, so the floor joins a four-top and a two-top. The joined arrangement
is an **open table** — named by the operator, optionally carrying a seat
count, seatable like any table, and dissolved automatically when its bill
closes.

**Model: an open table IS a RestaurantTable.** `RestaurantTableKind`
(`PHYSICAL` default | `OPEN`) discriminates. This keeps the entire session
stack — open session → orders → rounds → KOT → bill — working on open
tables with zero changes: `TableSession.tableId` points at it like any
other table. The alternative (a separate entity) would have forked every
downstream flow.

- `capacity` and `areaId` become **nullable** (widening only): an open
  table has "no registered seating capacity" unless the operator records
  one, and it belongs to no floor plan area. Physical-table creation still
  requires both — enforced at the service, where the invariant actually
  lives; the columns carry the honest shape.
- `code` is auto-assigned (`OPEN-<n>` via the tenant's `DocumentSequence`)
  — the operator names the table via `label`; codes exist for staff
  vocabulary and uniqueness, not for data entry.
- `OpenTableMember` joins the open table to the physical tables it
  absorbs. Membership rows are deleted on release; history lives in the
  audit log, not in tombstones.

**RESERVED is a new table status.** Members go `RESERVED` on creation and
back to `AVAILABLE` on release — the PO's vocabulary, now a first-class
`RestaurantTableStatus` value. `openSession` refuses a RESERVED table
outright: a joined member must not be seatable on its own, otherwise the
reservation is decorative. (This is the first status check in
`openSession`; the pre-existing looseness around OCCUPIED is untouched.)

**Member eligibility.** AVAILABLE + active + `PHYSICAL` only, at least
one, all on the open table's branch, checked inside the create
transaction. A table already absorbed into one open table cannot join a
second.

**Lifecycle.** Create (members → RESERVED) → seat → order → bill. On
`closeSession` of an open table's session, in the same transaction: every
member returns to AVAILABLE, memberships are deleted, and the open-table
row is archived (`isActive=false`) — the arrangement ends with the tab,
which is what "special situations" means. An open table that was never
seated (the party left) is dissolved manually; dissolve refuses while a
live session exists.

**Permission.** One new active key, `open-table:manage` (create +
dissolve). Front-of-house, like the reservation book: MANAGER, CASHIER,
and the RESTAURANT_MANAGER / WAITER / RESTAURANT_CASHIER templates. NOT
creator-owned — joining tables is a shift decision, not floor
administration (deliberately unlike D-series `TABLE_CREATE`, which stays
OWNER-only).

**Out of scope, deliberately.** Reservations (D47) on open tables — the
reservation service now refuses non-PHYSICAL tables; a transient
arrangement has no business on the calendar. Auto-suggesting which tables
to join. Cross-branch joins.

**Migration.** `20260816000000_add_open_tables`: `RESERVED` enum value,
`RestaurantTableKind` enum + `kind` column (default PHYSICAL),
`capacity` / `areaId` DROP NOT NULL (widening — every existing row remains
valid), `OpenTableMember` table with cascade FKs. No DROP, no SET NOT
NULL, no rename; the widenings are named explicitly in the
provider-contract structural test.

### D50 — One physical table may back several open tables; release is last-one-out, with a manual early release

Supersedes D49's "one live membership per physical table". The PO's two
worked examples:

- **Two parties, one table.** A four-top is free; two unrelated pairs
  arrive. The waiter creates **two** open tables, each reserving the same
  four-top. Each party gets its own tab. The four-top returns to
  AVAILABLE when the **last** of the two bills closes.
- **Two parties, two joined tables.** Two parties of three; a four-top
  and a two-top remain. Both are joined, and **both** open tables reserve
  **both** tables. When the first party is billed, the two-top *can* be
  freed — the remaining three fit on the four-top — but only a human
  knows that. So the system asks rather than assumes.

**Membership is many-to-many.** `OpenTableMember`'s
`@@unique([memberTableId])` is dropped; `@@unique([openTableId,
memberTableId])` stays, so a table still cannot be added twice to the
*same* open table.

**Eligibility widens by exactly one status.** A member may now be
`AVAILABLE` **or** `RESERVED` (already held by another open table).
Everything else is still refused: SEATED / OCCUPIED / BILLING / CLEANING
/ BLOCKED, archived rows, and `kind = OPEN`. A table with a party
physically at it is not shareable; a table already shared is.

**Release is last-one-out, and only that is automatic.** `closeSession`
deletes the closing open table's own memberships and archives that open
table, then returns each former member to AVAILABLE **only if no live
membership remains**. A member still held by another open table stays
RESERVED. This is the rule that makes example 1 correct without a prompt
and example 2 refuse to guess.

**Manual early release is the escape hatch.** `POST
.../tables/:tableId/release` drops every live membership for one physical
table and returns it to AVAILABLE. It exists because the server cannot
know whether the parties still occupying an arrangement physically need
all of its tables — compaction is a floor judgement. Deliberately
permitted even when it strips the last member of a live open table: the
alternative is inventing a rule that blocks a real compaction, and the
server has no way to verify the room.

**Billing reminds, it does not decide.** The close response carries a
release summary — which members were auto-released, and which stay
RESERVED with the open tables still holding them. When anything stays
reserved, the web app interrupts the close→bill navigation with a dialog
listing those tables and offering release inline. The dialog is a
decision point, not a notification: dismissing it continues to the bill
unchanged.

**"Connected to an open table" must be legible.** A RESERVED table on the
floor names the open tables holding it ("Held by Party A, Party B"), and
the Unreserve action renders **only** for tables with a live open-table
membership. A table reserved for any other reason is therefore never
offered an unreserve control — the PO's stated failure mode (releasing
something that was not an open-table hold) cannot be reached from the UI.
The held-by map is derived client-side from the open-table list the floor
already loads; no table-listing endpoint changes.

**Migration.** `20260817000000_share_open_table_members`: drops one unique
index. Data-safe and widening — every row satisfying the old constraint
satisfies the new one. Named explicitly in the provider-contract test,
which asserts the pair-unique survives.

### D51 — Bills split by item: a split carries the lines it covers, and its share is derived

A group of friends wants a bill each for exactly what they ate. The
operator opens the closed tab's bill, assigns each line to a named split,
and every split becomes a separately payable, separately printable bill.

**Item-backed splits, derived shares.** `BillSplitItem` joins a
`BillSplit` to a `RestaurantOrderItem` with an assigned `quantity`, so a
line of "3 × Beer" can go 2/1 across two friends. `BillSplit.share` stops
being an operator input on this path and becomes a **computed** figure —
the server owns the money, as everywhere else.

**Both split modes coexist.** The existing amount-based `setSplits`
(even split, arbitrary tenders) is untouched and still valid for "just
halve it". `splitByItems` is the new path. A split created by amount has
no items; a split created by items always does. Nothing about the
existing endpoint changes.

**Share = items + a proportional slice of everything else.** A split's
share is its own line totals plus its pro-rata share of the difference
between the sale's subtotal and its total — service charge, tax,
packaging, discounts, whatever the tenant configured — weighted by the
split's item subtotal. Rounding uses **largest remainder**: shares are
rounded to 2dp and the leftover cent goes to the split with the biggest
fractional part, so `Σ shares == total` **exactly**, always. A zero-value
tab (all items comped) spreads the extras evenly by the same method
rather than dividing by zero.

**Every unit must be assigned.** `splitByItems` refuses unless the
assigned quantities for each line sum exactly to that line's quantity.
Partial assignment would make `Σ shares == total` false, which is the one
invariant the payment path already depends on. The UI tracks what is left
and blocks save until nothing is.

**Splitting is refused once money has moved.** Any collected payment
makes the sale ineligible for re-splitting — reallocating shares under a
recorded tender is an accounting mess with no honest answer. Split
first, then collect.

**Payments allocate to a split.** `collectPayment` takes an optional
`splitId` and increments that split's `paidAmount`, refusing more than
the split's own remaining balance. This closes a real gap: the bill
screen's "Collect for split" button already captured a split id and
never sent it, so split `paidAmount` could never move off zero and every
tender landed against the whole sale.

**No new Sale rows, deliberately.** One tab stays one financial record;
the splits are views of it that can each be paid and printed. Minting a
Sale per split would double-count revenue unless the parent were voided,
and would renumber and re-date financial documents for a presentation
concern. Restaurant tenants run no accounting provider (D2), so there is
nothing that needs a separate Sale to reconcile against. If per-split
Sales are ever genuinely required, the item assignment recorded here is
what they would be built from.

**Migration.** `20260818000000_add_bill_split_items`: one new table with
cascade FKs. Purely additive — no existing table is touched, and a bill
with no item assignments behaves exactly as it does today.

### D52 — Restaurant bills compute tax, packaging and per-channel service charge; sales are attributed to the real actor

The audit in [`hardcoded-audit.md`](./hardcoded-audit.md) found the restaurant
close path hardcoding `taxAmount: 0`, `packagingCharge: 0` and `totalDiscount:
0`, levying service charge on dine-in only by accident rather than by
configuration, and attributing every sale to `findFirst` results. This
decision fixes the money and the attribution.

**One totals calculator, shared by every channel.** `restaurant-totals.ts` is
pure and dependency-free (the `split-shares.ts` pattern): given a subtotal, a
channel and the branch/tenant configuration it returns service charge,
packaging, tax and total. `closeSession` and the takeaway handover both call
it, which is what stops the two channels drifting — today dine-in charges
service and takeaway silently does not.

**Tax comes from the existing `AppSettings.taxRatePercent`,** read through the
synchronous cache-backed `SettingsService.getSettings` that retail already uses
(`sales.service.ts:410`). No new tax setting is introduced.

**`taxInclusive` stays unhonoured — deliberately, and now documented.** The
setting exists but is read by *nothing* in the platform, retail included.
Implementing tax-inclusive pricing only for restaurants would make the two
channels compute differently from the same tenant setting, which is worse than
the current honest gap. It is recorded in the audit as an open item for a
platform-wide slice.

**Three new branch config fields, each replacing a hardcoded assumption:**

- `serviceChargeChannels RestaurantOrderChannel[]`, default `[DINE_IN]` —
  makes today's implicit behaviour explicit and configurable. A restaurant
  that levies service on takeaway can now say so.
- `packagingChargeAmount Decimal(12,2)`, default `0` — a flat per-order charge
  applied to TAKEAWAY and ONLINE. The `Sale.packagingCharge` column and the
  bill row already existed with nothing to fill them; the schema comment
  already named this as the missing config.
- `serviceChargeTaxable Boolean`, default `true` — whether service charge sits
  inside the taxable base. This genuinely varies by jurisdiction and cannot be
  guessed; `true` matches Sri Lankan practice, which is the pilot market.

**Attribution: the actor, not a query result.**

- `closeSession` now takes `actorUserId`. It was the only method in its class
  that did not, while its controller already held `actor.id`. The cashier is
  `session.waiterUserId ?? actorUserId` — never `findFirst` on `User`, which
  was not branch-scoped and in practice booked every untagged sale to the
  tenant owner.
- The register is taken from an optional `registerId` on the close DTO,
  validated to belong to the session's branch. Absent one, the fallback is
  the branch's first active register **ordered by code** — deterministic,
  where the previous `findFirstOrThrow` had no `orderBy` at all and could
  return a different till between two closes. Binding a register to a device
  at login is the real answer and is deferred to its own slice; this removes
  the non-determinism without inventing that feature.

**Deferred, with reasons rather than silence:**

- **Promotion pricing at close.** Promotions are badged on the POS catalogue
  and never discount the bill. This is not a small wiring gap: the promotions
  module exports only `isPromotionActive`, an activity-window predicate. There
  is no promotion *pricing* engine anywhere, so applying them is a feature to
  design, not a bug to fix.
- **Manual order-level discounts.** Retail resolves these with a manager
  approval threshold; the restaurant equivalent needs the same approval flow
  plus a UI, and belongs with promotion pricing.
- **`Sale.status: COMPLETED` before payment.** A restaurant bill legitimately
  exists unpaid — `paymentStatus: UNPAID` already records that. Moving it to
  `DRAFT` would change which sales every existing report, the returns path and
  the QuickBooks sync can see. That is a financial-state redesign needing its
  own decision and a data story, not a line change inside this one.

**Migration.** `20260819000000_add_restaurant_charge_config`: three additive
columns on `RestaurantBranchConfig`, all defaulted so every existing branch
keeps its current behaviour exactly.

### D54 — Money is formatted in the tenant's currency; the vendor's brand never appears on a tenant's document

Audit section F plus D5/D6. Three fallbacks put "Hardware POS" or "Axlo POS"
onto documents a customer keeps, and every money formatter on the restaurant
surface rendered `LKR` regardless of what the tenant had configured.

**`AppSettings.currency` is honoured, not defaulted past.** It has existed and
been API-writable all along. `utils.formatMoney` named its parameter
`_currency` and discarded it — while `pos/payment/page.tsx` genuinely fetched
the setting and passed it in. `labels.formatMoney` defaulted to the literal
`'LKR'`, and since no call site passes a currency, that default was what every
tenant got.

**Resolved once per shell, read synchronously.** Money is formatted in dozens
of render paths that cannot each await the settings API, so `tenant-money.ts`
caches the resolved code in module memory and LocalStorage — the same pattern
`document-template-service` already uses for the document profile.
`PlatformProfileProvider` primes it, and signing out forgets it, because the
next user on the device may belong to a tenant trading in another currency.

**Only LKR keeps a display symbol.** `Rs.` is LKR-specific; every other
currency renders as its ISO code. Inventing a symbol per currency would be
worse than an honest `AED 1,250.00`, and the pilot's output is unchanged.

**An unset company name renders empty, not as the vendor's brand.** A blank
letterhead is visibly wrong to whoever is about to print it. "Hardware POS" on
a tax document is not — it looks like a real company, and it is the wrong one.

**The split bill I shipped in D51 printed bare decimals with no currency at
all** — the only customer-facing document in the app without a unit — and
computed its balance in the browser with `.toFixed(2)`. Both fixed here.

Branch and register names in the three POS shells were the literals
`"Main Dining"` and `"Counter 1"`; they now come from the session.

### D55 — Platform admins: a cross-tenant account that manages workspaces and users, and never reads tenant business data

A new account type that signs in through the same login page and lands on a
platform console instead of a workspace. It creates workspaces from a
template, and manages user accounts inside any workspace.

**The security problem this creates.** Every JWT in this system carries a
`tenantId`, and that one field is what `@TenantId()` turns into the isolation
boundary on every route. A platform admin belongs to no workspace, so the
boundary has to be re-stated rather than inherited.

**A bidirectional guard, not a privilege escalation.** `User.isPlatformAdmin`
marks the account; platform routes carry `@PlatformAdminRoute()`. A global
`PlatformBoundaryGuard` enforces both directions:

- a non-platform token on a platform route → 403;
- **a platform token on any tenant-scoped route → 403.**

The second half is the important one. A platform admin's token is refused by
every existing route in the product, so "cannot read tenant business data" is
a property of the guard rather than of the endpoints we remembered to check.
Platform admins live in a dedicated `platform` tenant so the `User.tenantId`
FK stays satisfied and the whole auth stack — password hashing, refresh
rotation, login throttling — is reused rather than duplicated.

**Password reset is a deliberate hole in that boundary, and is logged like
one.** The PO chose full user CRUD including password resets. A platform
admin can therefore reset a workspace owner's password and sign in as them,
which reaches the business data the guard otherwise refuses. This is a
support-desk capability with a master-key shape, so: every reset writes an
audit record naming the actor, the target user and the workspace, and the
reset endpoint is the only one in the platform module that touches
credentials. The metadata-only boundary is real protection against accident
and casual browsing; it is not a defence against a malicious platform admin,
and should not be described as one.

**Templates are business types, because that mechanism already exists.**
`BusinessType` already drives `NAV_BY_BUSINESS_TYPE`, `DEFAULT_MODULES_BY_
BUSINESS_TYPE`, `BUSINESS_PROFILE_PRESETS` and the role templates. A template
is therefore a named business type plus its presets, not a new entity: three
are offered — Hardware, Restaurant, Hotel.

**HOTEL is its own business type that currently aliases Restaurant.** The PO
asked for a duplicate of the restaurant template. Aliasing at the *map* level
(HOTEL → `RESTAURANT_NAV`, restaurant modules, restaurant role templates)
rather than reusing the `RESTAURANT` value means the workspaces are
distinguishable in data from day one, and the day hotels need their own
navigation it is a one-line map change instead of a migration over live
tenants. `BUSINESS_PROFILE_PRESETS` is a total `Record<BusinessType, …>`, so
the compiler required every map to answer for HOTEL — which is the point.

**Provisioning reuses the proven path.** Creating a workspace runs the same
sequence as `provision-tenant.ts`: tenant, business profile, main branch,
register, role rows for the template's business type, and an owner user. It
is one transaction, so a half-built workspace cannot exist.

**Migration.** `20260820000000_add_platform_admin_and_hotel`: the `HOTEL`
enum value and `User.isPlatformAdmin` (defaulted false, so no existing user
gains anything).

**The console is its own route tree, and the two shells push each other
apart.** `/platform` sits outside the `(app)` group because that layout mounts
the sidebar, the module gate and the POS cart providers, all of which assume a
tenant — a platform admin inside it would 403 on the profile fetch and land in
front of a broken shell. So `Protected` sends a platform admin to `/platform`
and the platform layout sends a workspace user to `/dashboard`. Neither is a
security control (the guard already refuses both tokens); they exist so nobody
reaches a shell that cannot load. `platform-boundary.render.test.tsx` asserts
both directions and is mutation-proven: dropping the workspace→console half
fails exactly one test and leaves the other six green.

**The console shows the role that is actually in force.** A user linked to a
custom workspace role keeps an enum role underneath — the seeded waiter is enum
`CASHIER` — and `PermissionResolver` uses the linked role. Listing only the
enum would tell an operator that a waiter is a cashier, so the workspace role
is named separately and the enum select is labelled as its fallback.

**D55.1 — the role a new user gets is the workspace's own, not a fixed five.**
The console shipped with `['OWNER','ADMIN','MANAGER','CASHIER','ACCOUNTANT']`
written into the Add-user dialog and into the DTO's `@IsIn`. That list is
correct for a hardware workspace, which is what made it survivable: it could
not assign `WAITER` — the role a restaurant workspace exists to assign — and
`role: dto.role as UserRole` would have written an invalid enum value if it
ever received one.

The roles now come from `GET /platform-admin/workspaces/:id/roles`, read from
the workspace's own `Role` rows. Which rows exist was already decided by the
template: `seedTenantRoles` gives a food-service workspace the restaurant
roles on top of the five built-ins — eleven in total, not the two the request
sketched — and a hardware workspace five. The rows are also what
`PermissionResolver` consults, and a tenant may have renamed one, so reading
them beats deriving the list from the templates a second time.

**Addressed by id, not by key.** `Role.key` is nullable — documented as
nullable only so the column could be added without a backfill — so a
key-addressed console would silently fail to offer any role lacking one. The
id is what `User.roleId` stores anyway, and the lookup is scoped by
`tenantId` as well as `id` so a role from another workspace cannot be
attached even if its id is known.

**The enum column still matters, so the fallback is CASHIER.** A user on a
custom role must still store something in `User.role`. It is not inert:
`BranchScopeGuard` and `UsersService` treat OWNER/ADMIN as cross-branch and
`QuotationsService` gates admin actions on it, and it is what
`LEGACY_FALLBACK` resolves from if the linked role row is later deleted.
`baseUserRoleFor` therefore maps a built-in key to itself and everything else
to the least-privileged built-in, so both paths fail closed: a waiter does not
gain cross-branch visibility from a column that had to hold a value, and does
not inherit manager permissions if their role row goes away. This matches what
the seed already does for the restaurant waiter.

**An unknown role is a 400, never a silent null.** The earlier code fell back
to `roleId: null` when the key did not match, which fails *open* — the user
would resolve from the enum instead, so a typo produced a working cashier
rather than an error. The lookup now refuses, naming the workspace's actual
roles.

Verified live: a waiter created through the console resolves to a permission
set identical to the seeded waiter's; a hardware workspace is refused the
waiter role and a restaurant workspace is refused a hardware role. The picker
is mutation-proven — reintroducing the hardcoded five fails two of the five
render tests while the hardware-only assertion stays green, which is exactly
the asymmetry that let the original bug through.

**Known gap, deliberately not closed here.** The seeded hardware tenant
(`tnt_dev`) has no `TenantBusinessProfile` row at all: it resolves through
`LEGACY_TENANT_DEFAULTS` to `TILE_SHOP`/QuickBooks. It is therefore linked to
no template, and the console says so — "Legacy default" — rather than implying
a Hardware template it does not have. Writing it a `HARDWARE` profile would
keep the inventory/accounting pair identical but would change its business
type and swap the legacy 13-module list for the HARDWARE default set, which is
a behavioural change to the live retail product. That needs its own decision
and its own verification, so it is not bundled into this one.

---

## 2026-08-14 — Convergence Phase 0

### D56 — Domain packs: one descriptor per vertical; capabilities replace business-type comparisons

Implements Phase 0 of [`docs/convergence-plan.md`](../convergence-plan.md)
(§4, §5). Adding a vertical used to touch fifteen places, eleven of which
failed silently — `NAV_BY_BUSINESS_TYPE[t] ?? RETAIL_NAV` handed an unknown
domain the retail rail, `resolveBusinessKind` fell back to retail chrome, and
six page bodies compared `businessType` inline. HOTEL shipped missing seven of
them, which is how a hotel workspace got the restaurant sidebar with the
retail POS behind it.

**Domain packs.** `packages/shared/src/domains/` holds one `DomainDescriptor`
per vertical (hardware, food-service, hotel, general) declaring label,
template copy, profile preset, module set, navigation (as data, icons by
name), role templates and capabilities. `DOMAIN_REGISTRY` is a total
`Record<BusinessType, DomainDescriptor>` with **no fallback**: a value without
an entry is a compile error, never a wrong screen. The seven scattered maps
(`BUSINESS_PROFILE_PRESETS`, `DEFAULT_MODULES_BY_BUSINESS_TYPE`,
`BUSINESS_TYPE_LABELS`, `NAV_BY_BUSINESS_TYPE`,
`roleTemplatesForBusinessType`, `WORKSPACE_TEMPLATES`, the web `BusinessType`
union) become derivations or re-exports of the registry.

**Capabilities.** `TenantCapabilities` — what a tenant's users can actually do
(catalogue.variants/modifiers/preparation, fulfilment.kind/channels, charges,
documents) — is declared per descriptor and returned on
`GET /v1/platform/profile`. Pages and services read a capability, never a
business type; D31's rule generalised from the product screens to the whole
platform. Capabilities are affordances only: the server still refuses what the
guard refuses. Unshipped features (`collections`, `components`) are declared
`false` until their phase flips them.

**Hotel re-declares, never aliases.** `hotel.domain.ts` re-declares the
food-service values (Q7): a redundant-looking file today is a one-file edit
when hotels diverge; an alias would be a refactor. A parity spec pins the
values equal until a divergence is a visible edit.

**The web unions move to `@hardware-pos/shared`.** The web must never import
the Prisma client, so it hand-maintained copies of `BusinessType`/`ModuleKey`,
guarded by a regex over source text that broke twice during D55. The shared
package is browser-safe; the unions live there once as `as const` arrays with
derived types, and the API contract spec compares them against the Prisma
enums **at runtime**, both directions, no regex.

### D57 — One business type per template: the pilot is HARDWARE; TILE_SHOP and RETAIL are removed

> **Partly superseded by D120 (2026-08-28).** `RETAIL` returns as its own business
> type and domain descriptor, for a clothing customer that did not exist in
> August. The Tile Shop finding below and the `TILE_SHOP` removal **stand
> unchanged**.

PO decision (2026-08-14): the Hardware template and the Tile Shop are the same
entity, and there is no Retail template. (Plan §4.8.1; plan-appendix id D71.)

The `BusinessType` enum was ten days old and the three retail values carried
**zero data** — `TenantBusinessProfile.businessType` is the enum's only column
and no row held `TILE_SHOP`, `HARDWARE` or `RETAIL`; the pilot tenant has no
profile row and resolved through `LEGACY_TENANT_DEFAULTS` (code, not data). So
the values are removed outright rather than deprecated: a transition for
ghosts protects nothing.

- `LEGACY_TENANT_DEFAULTS.businessType` and the
  `business-profile.repository` write-fallback repoint `TILE_SHOP` →
  `HARDWARE`. Verified behaviour-preserving: HARDWARE's default module set is
  exactly the legacy 13-module list and the provider pair is identical. The
  one visible change is the Settings → Business label reading "Hardware
  store" instead of "Tile shop". (The D55 "known gap" note assumed the module
  lists might differ; they are the same set — that note is corrected by this
  record.)
- The pilot tenant is **classified for real**: an explicit
  `TenantBusinessProfile` row (`HARDWARE`, `QUICKBOOKS`/`QUICKBOOKS`) written
  by `packages/database/prisma/backfill-pilot-profile.ts` — an operational
  script with a production guard, never part of `migrate deploy`. This closes
  D55's "Legacy default" console gap: the pilot shows as a Hardware-template
  workspace because it genuinely is one.
- **Migration** `20260821000000_remove_tile_shop_and_retail_business_types`:
  recreates the enum without the two values (Postgres cannot `DROP` an enum
  value in place). Non-additive by nature — this record is its authorisation,
  and the per-migration proof in `provider-contract.spec.ts` scopes an
  explicit exception for exactly this recreation while continuing to forbid
  every other destructive shape. The migration refuses to run if any row
  carries a removed value.
- Existing specs that passed `'TILE_SHOP'` to role seeding are mechanically
  renamed to `'HARDWARE'` under this record (their assertions are unchanged —
  both values always resolved to identical roles).

### D58 — The settlement document is universal: every completed transaction writes SaleItem rows

Implements Phase 1 of [`docs/convergence-plan.md`](../convergence-plan.md)
(§3.2, §8.1–8.2, §12.3.2). A restaurant sale wrote a `Sale` header with zero
`SaleItem` rows, which made returns, item-level reporting, receipts and
accounting sync structurally retail-only and forced a parallel reporting
stack over `RestaurantOrderItem`.

**The projection.** Closing a table session (and handing over a takeaway) now
projects every non-voided order item into a `SaleItem` inside the SAME
transaction that creates the `Sale` — a field-for-field copy of the snapshots
frozen at submit time, never a recomputation. A `SaleItemModifier` child
mirrors `RestaurantOrderItemModifier` the same way. An in-transaction
invariant asserts `Σ lineTotal == subtotal`; a close that fails it aborts
rather than persisting a document that disagrees with itself.

**New columns.** `SaleItem`: `sourceKind` (`RETAIL_CART` default, so every
existing retail row keeps its meaning; `RESTAURANT_ORDER_ITEM` for projected
lines), `sourceItemId` (typed by sourceKind, never reused for another
entity — the lesson of D-6's polymorphic `menuItemId`), `modifierTotal`,
`notes`, `backfilledAt`. `Sale`: `fulfilmentKind` (default `IMMEDIATE`),
`channel` (default `COUNTER` — correct for every existing retail sale, which
is why those defaults were chosen), `sourceRefKind`/`sourceRefId`, and
`servedByUserId` (open decision Q6, resolved per the plan's recommendation:
`cashierId` keeps meaning "who took the money", `servedByUserId` is who
served the table — loose reference, no FK, so serving staff churn never
blocks a settlement write).

**`SaleItem.productId` becomes nullable** — the one widening `ALTER` in the
migration. A projected line from a legacy MenuItem has no product; the
snapshots carry the document's meaning. The per-migration proof in
`provider-contract.spec.ts` scopes `DROP NOT NULL` as permitted for exactly
this migration while `SET NOT NULL` stays forbidden everywhere.

**Historical backfill (open decision Q1, resolved: yes).**
`prisma/backfill-restaurant-sale-items.ts` reconstructs `SaleItem` rows for
already-closed sessions from `TableSession.finalSaleId → RestaurantOrder →
RestaurantOrderItem` — dry-run first, idempotent, every reconstructed row
stamped `backfilledAt`, and a per-sale sum invariant under which a
discrepant sale gets NO rows and a report line instead: a wrong
reconstruction is worse than an absent one. Run as an operational step,
never inside `migrate deploy`.

**Explicitly deferred, with reasons.** (a) Pointing `billing.service`'s
settled-bill reads at `SaleItem`: `BillSplitItem` anchors splits to
`RestaurantOrderItem` ids, and switching the read source while splits are
mid-flight risks live bills for zero user-visible gain until the shared
consumers (returns, receipts) actually read the projection — revisit in
Phase 5 with the reports re-backing. (b) Restaurant returns through the
shared `ReturnsService`: the RETURNS module is not in the food-service
module set, so no UI can reach it; enabling the path without the module
decision would be dead code asserting nothing.

### D59 — One money engine, `Prisma.Decimal` throughout, for sales, bills and quotations

Implements Phase 2 of the convergence plan (§8.7, §13.3). Three calculators
existed: retail sales and quotations computed money in binary floating point
with `round2()` at each step; the restaurant bill used `Prisma.Decimal`
(D52). `computeDocumentTotals` (`common/money/document-totals.ts`) is now the
superset pipeline — line discounts + order discount + service charge +
packaging + tax — and all three callers delegate to it:

- `restaurant-totals.ts` became a thin wrapper whose unchanged D52 spec is
  the parity proof for the food-service half.
- `quotations.calc.ts` and `sales.service.ts` delegate at a number boundary
  (exact — every engine output is a 2dp figure); their unchanged specs are
  the parity proof for the retail half.

**The differential proof, and the one recorded behaviour change.** The spec
preserves the legacy float formulas verbatim and runs both engines over
5,000 seeded carts. Measured result: wherever no intermediate sits on an
exact half-cent, the engines agree to the cent, unconditionally. AT an exact
half-cent the float engine's answer depended on the value's magnitude — the
`+ Number.EPSILON` nudge rescued small figures (10% of 19.85 → 1.99, both
engines agree) but is below one ulp for large ones (15% of 15,185.50 = 
2,277.825 exactly; float computed 227782.49999999997 and charged 2,277.82).
The Decimal engine rounds every mathematical half up: **at exact half-cent
boundaries a total can change by one cent, upward, and that is the defect
(plan D-7) being fixed, not a regression.** Pinned in the spec so it cannot
regress into silence. Existing behavioural assertions were NOT edited — all
pinned totals in the sales/quotations/restaurant specs pass unchanged.

**Per-branch tax (plan Q5, resolved per recommendation).**
`RestaurantBranchConfig.taxRatePercent` — nullable; NULL inherits the
tenant-wide `TenantSettings.taxRatePercent`; 0 is a real rate and stays
distinguishable from unset. Wired into both restaurant close paths. No UI
yet, deliberately.

**Migrations.** `20260823000000_add_branch_tax_rate_override` (one nullable
column). The settlement migration is D58's.

### D60 — `Product` is the only catalogue; `MenuItem` becomes a placement and is frozen

Implements Phase 3 of the convergence plan (§8.3, §8.5–8.6, §8.9, §12.3.3).
D45 made `Product` the authoring surface but left `MenuItem` alive as a
complete second catalogue with its own name, price, image, modifiers and
station routing, and a `sourceKind` discriminator threaded through every
consumer. This decision finishes the convergence.

**`Product.sellableKind`** — AxloPOS's own vocabulary for what a sellable
thing IS (`STOCK_ITEM` default / `COMPOSED_ITEM` / `SERVICE` / `BUNDLE`,
with `TIME_SLOT` and `STAY_UNIT` named now, unused, so nobody invents
`Product.type = 'Room'` later). Distinct from the QuickBooks `type` string
(provider data, untouched) and from `foodType` (presentation). Backfill
maps `type = 'Service'` → SERVICE and D45 restaurant products carrying a
`foodType` → COMPOSED_ITEM — a component-less COMPOSED_ITEM depletes 1:1,
so packaged drinks marked COMPOSED lose nothing.

**`CatalogueEntry`** — the thin placement `MenuItem` actually was: which
product appears in which menu section, in what order, optionally at what
price. `priceOverride` is the ONLY price a placement may own, and it is an
override of the product's price, never a second authority (plan P1).
`CatalogueAvailability` and `CatalogueChannelPrice` re-home the placement
concerns. `MenuItem.migratedProductId` records the mapping for audit and
for the order-item backfill.

**Backfill (plan Q2, resolved: auto-create).**
`backfill-catalogue-convergence.ts`, dry-run first: linked menu items get a
`CatalogueEntry` (+ junction copies for modifier groups and station links);
UNLINKED menu items get a new `Product` first (scalars copied,
`sellableKind = COMPOSED_ITEM`), with a case-insensitive duplicate-name
report for the tenant to merge — D45's "no auto-conversion" was about not
forcing UX change, not about stranding data. Historical
`RestaurantOrderItem` rows with `sourceKind = MENU_ITEM` get `productId`
stamped from the mapping.

**Transitional pricing rule.** A MENU_ITEM-sourced order line now resolves
its price as `CatalogueEntry.priceOverride ?? Product.unitPrice`, falling
back to the frozen `basePrice` only for an unmigrated item. At backfill
time these are equal by construction (the override is written only where
`basePrice` differed); afterwards the product price is authoritative —
which is the point. Item writes (`POST`/`PATCH` menu items, sections,
menus) return `410 Gone` naming the successor; reads stay for reprints and
the support-only legacy browser.

**Kitchen routing** prefers `ProductStationLink` whenever the order line
carries a `productId` (all lines, after backfill) and keeps the
`MenuItemStationLink` fallback only for unmigrated legacy rows.

**Frozen, not dropped.** `MenuItem` and its children stop being written and
stay readable indefinitely; the drop is a separate decision two releases
out, per the plan's deferred-drops rule.

### D61 — `FulfilmentProvider`: the third provider axis, alongside inventory and accounting

Implements Phase 4 of the convergence plan (§4.5). A fulfilment provider owns
HOW a sale comes into being — the operational lifecycle between "the customer
wants this" and "the money settled" — while the settlement document
(`Sale`/`SaleItem`, D58) stays Layer-1 invariant core. This is the phase the
plan's extension contract rests on (its risk register R9 warned it would feel
skippable): a future vertical's lifecycle — an appointment, a room-night, a
repair job — becomes one class implementing one interface, its own
operational tables, its own routes, and NOTHING else, because settlement,
reporting, receipts and returns consume `SaleItem`.

**The interface.** `collectSettlementLines(tx, tenantId, ref)` returns
not-yet-settled lines in the universal projection shape;
`releaseResources(tx, tenantId, ref)` frees what the work unit held, in the
settlement transaction, so "bill settled" and "resources released" cannot be
observed apart. The work-unit ref is a tagged union — `TABLE_SESSION` has a
persisted work unit, `IMMEDIATE` deliberately has none (the priced cart IS
the work unit; plan §3.3 rejected inventing an order row for retail) — so
both shapes are first-class rather than one pretending to be the other.

**Implementations.** `TableServiceFulfilmentProvider` collects via an
INDEPENDENT query over the same rows the bill's subtotal was computed from —
so the D58 sum invariant now compares two reads, not one restated — and owns
the table-release logic that lived inline in `closeSession` (physical →
AVAILABLE; open table → dissolve, D49/D50). `ImmediateFulfilmentProvider` is
honestly thin: pass-through collection, nothing to release; it exists because
`FulfilmentProviderFactory` holds a total `Record<FulfilmentKind, …>` with no
fallback (the D56 rule), so a kind without a provider is a compile error.

**Consumers.** Both table-service close paths (dine-in, takeaway) resolve the
concrete provider — not the factory; the service IS the table-service
lifecycle and re-reading the profile per close to learn what the file already
is would be ceremony. The factory serves kind-agnostic callers (Phase 5's
reporting, future settlement surfaces). The provider-contract importer sets
gained the two modules under this record.

### D62 — Catalogue REST surface: `/products` is canonical, `/products/sellable` is the POS read model

Implements Phase 5 of the convergence plan (§9). Paths that were already
correct stay; concepts that were never restaurant-specific leave
`/restaurant`; every alias says so in-band and dies on a schedule.

**`GET /products/sellable`** — the one POS read model, for every domain.
SHARED CORE like `/products` itself: which BLOCKS the response carries is
decided by the tenant's capabilities, not a module key — a retail tenant
gets NO `modifierGroups` key (absent, not `[]`: §9.5's rule that absent
means "does not have this concept"). Money is decimal STRINGS. Price
resolution happens server-side, once — base → collection override → channel
override — and `priceSource` says which rule won. Keyset pagination
(`cursor`/`limit` capped at 200). `stockState` includes `UNTRACKED` as a
real state distinct from `OUT`. The legacy `/restaurant/pos-catalogue`
became a thin adapter over the same service preserving its number-typed
contract, wearing `Deprecation`/`Sunset`/`Link successor-version` headers.

**Modifier groups moved home.** `/products/modifier-groups` is canonical —
"cut to 3 keys +$6" and "add bacon +$2" are the same feature — with the
`/restaurant/modifier-groups` alias deprecated in place. One service serves
both.

**Collections** — `/branches/:id/collections`, `/collections/:id/sections`,
`/sections/:id/entries` — are the successor authoring surface the D60 410s
point at: `Menu`/`MenuSection` under their real job description, holding
`CatalogueEntry` placements of PRODUCTS. `priceOverride` is the only price a
placement may own; entry deletion is archive (D42/D43 heritage). Gated on
MENU_MANAGEMENT like the surface they replace; retail gains the module when
Phase 9 flips `catalogue.collections` on — routes ready first.

**Reports re-backed.** Five of the six restaurant reports now read the
settlement document (`Sale`/`SaleItem`) — the same source retail reporting
reads — with waiter performance attributed by `servedByUserId` (D58/Q6) and
channels by `Sale.channel`. Voids stay operational (an order-lifecycle fact
with no sale-level analogue). One recorded semantic shift: financial figures
now measure SETTLED documents rather than ordered-but-possibly-unsettled
items — the old numbers could count food later voided at the table.

**Deprecation policy** (plan §9.1): aliased routes keep working, carry
`Deprecation: true`, `Sunset`, and a `Link rel="successor-version"`, and are
removed no earlier than two releases after the successor — each removal its
own decision.

### D63 — External identity lives in `ExternalEntityRef`; the QuickBooks quarantine begins

Implements Phase 6 steps 1–4 of the convergence plan (§4.9, §8.10). Eight
Layer-1 models carry QuickBooks columns and ten domain-neutral modules read
them (plan defect D-9) — a coupling every future domain would inherit. The
PO's constraint (D68 in the plan's numbering): QuickBooks serves the hardware
template only.

**Step 1 — the satellite.** `ExternalEntityRef` generalises the barely-used
`QuickBooksMapping` by a `provider` column: one home for
`(tenant, provider, entityType, localId) → external identity + sync state`.
Its only FK is the tenant — it can never cascade into a core row, and a ref
outliving its entity is a reconciliation signal, not corruption.

**Step 2 — dual-write, live.** Every write of vendor identity or sync state
(the four QBO sync services, the sync queue's PENDING resets, the retail
`markSynced` path, product import commit, supplier map/unmap, customer
queueing, product PENDING marks) now mirrors into the satellite in the same
transaction via one helper (`mirrorExternalRef`). Column defaults need no
mirror: reconciliation reads absence as agreeing with `NOT_SYNCED`/no-id.

**Steps 3–4 — backfill + reconciliation, proven.**
`backfill-external-entity-refs.ts` (copy, never move; dry-run/write/
idempotent; includes the `QuickBooksMapping` rows) and READ-ONLY
`reconcile-external-entity-refs.ts` (exit 0 only on zero mismatches). Run
locally: 1,557 refs copied, reconciliation clean; a deliberately staged
pre-instrumentation drift was caught by the reconciler (named the sale and
both values) and trued up by re-running the backfill — the exact operational
loop production will use.

**The read switch (step 5) is NOT in this change, by the plan's own design**:
it deploys only after the reconciler reports clean across a full PRODUCTION
sync cycle (risk R10 — the only paying integration). The code change is then
mechanical: the ten readers move to the satellite, the tripwire's ratchet
list goes to `[]`, and step 6 gates `syncStatus` out of the public DTOs.

**The ratchet.** `quickbooks-isolation.spec.ts` pins the EXACT current
vendor-column reader set outside the integration modules — it may only
shrink; file eleven fails by name — and pins the satellite + mirror to the
integration and the instrumented legacy write sites, so `ExternalEntityRef`
cannot grow the disease the columns had.

No QuickBooks behaviour a hardware tenant can observe changes in this phase;
if one can tell it happened, it is wrong (plan non-goal).

### D64 — `Product.attributes`: domain catalogue fields without a migration per domain

Implements Phase 7 of the convergence plan (§4.6). The rule that decides
where a product field lives, now enforced end to end:

> **Behaviour goes in columns. Description goes in `attributes`.** If the
> engine must branch on it — inventory, pricing, tax, settlement — it is a
> typed column and a migration with a decision record. If only the domain UI
> and reports read it, it is a validated key in `Product.attributes`.

**Storage.** `attributes JSONB NOT NULL DEFAULT '{}'` + GIN index
(migration `20260826000000`, self-backfilling — every existing row is the
valid empty document). Values are scalars only; a key that wants structure
is a key that wants promotion to a column.

**One declarative schema, three consumers.** Each `DomainDescriptor` now
REQUIRES `catalogue.attributeSchema` — a descriptor must say "no
attributes" rather than get it by omission. The same list drives:

1. `GET /products/attribute-schema` — what the tenant's wizard renders;
2. the server-side validator (`validateAttributes` in `@hardware-pos/shared`,
   applied by `ProductAttributesService` on create and update) — refusals
   are `400 PRODUCT_ATTRIBUTES_INVALID` with per-key issues;
3. the sellable listing's `attr[key]=value` filters — keys checked against
   the schema, values coerced to the field's type, unknown key or
   uncoercible value a 400 naming itself, never a silently-empty page.

So a new vertical's catalogue fields are one descriptor edit: no migration,
no DTO change, no wizard code — the generic attributes step renders any
schema, and only appears when the schema is non-empty.

**Declared today.** HOTEL carries the plan's worked example (bedCount,
maxOccupancy, viewType) — all OPTIONAL for now, deliberately: the same
wizard authors a hotel's food, and a required `bedCount` would block every
burger. Requiredness arrives with STAY_UNIT authoring, hung off the
sellable kind. Hardware, food service and GENERAL declare `[]`, and an
empty schema is a CLOSED door: every `attributes` key is refused, which is
what keeps the column from growing schemaless sprawl.

**Semantics.** The document is replaced whole when provided (`undefined`
leaves it untouched); an optional key is cleared by omission, never by
`null`. `attr[…]` filters ride the restored Express `extended` query parser
(Express 5 dropped it; `main.ts` and the integration harness set it back)
so a nested `attr` object passes the whitelist pipe as one declared key.

**Found and fixed while wiring the route:** Phase 5's module edit had folded
`ProductModifiersController` into a `//` comment in `products.module.ts` —
its `GET/PUT /products/:productId/modifier-groups` routes 404ed live while
the route matrix stayed green, because the matrix reads decorator metadata
off controller CLASSES, which exist whether or not any module registers
them. The controller is re-registered (verified live), and the matrix spec
gained the missing tripwire: every controller class must appear, comment-
stripped, in some module's `controllers: […]` array — exact sets both ways,
with an inline mutation proof that replays the actual defect.

Attributes are deliberately absent from `SellableItem` (the POS grid does
not render them) and from every money/stock path — the D30 spec suite pins
the validator's whole refusal surface, including the empty-schema case.

### D65 — components, and rounds finally move stock

Implements Phase 8 of the convergence plan (§8.8), closing defect D-5:
`StockMovementReason.ORDER_ROUND` was declared and never written — a
food-service tenant's stock was purchase-side only. Open decision Q4 is
resolved as the plan recommended: **depletion happens at round SUBMIT**, in
the round's own transaction (the same reasoning as D53 — food reaching the
kitchen is the event that matters), **with a compensating movement on
void**.

**The model.** `ProductComponent` — what a COMPOSED_ITEM or BUNDLE consumes
per unit sold, ONE level, no recursion. Authored via
`GET/PUT /products/:productId/components` (replace-all, wizard card D,
audit-logged); writes are refused `403 COMPONENTS_NOT_ENABLED` for tenants
whose domain does not declare `capabilities.catalogue.components` — flipped
TRUE for food service (hotel inherits) in this change, false elsewhere.

**What depletes, by sellable kind.** STOCK_ITEM → itself, 1:1 (the bottled
drink in a restaurant, D-5's worked example). COMPOSED_ITEM / BUNDLE → its
recipe rows at `qty × quantity × (1 + wastageRate)`. SERVICE / TIME_SLOT /
STAY_UNIT → nothing. The oversell guard is the provider's own
(`reduceStock`): a round the shelf cannot support is refused WHOLE, exactly
as a retail cart is; the recourse is a stock adjustment.

**Deliberate deviation from the plan's "absent = 1:1" note.** A
COMPOSED_ITEM with NO recipe depletes NOTHING. Sticking to the plan text
would have broken every restaurant at deploy (every dish sits at quantity 0)
and contradicted D62, which already displays componentless COMPOSED items
UNTRACKED because their stock number is a number nothing maintains.
Authoring a recipe is the per-product opt-in that §12.3.5 pairs with an
opening stock-take; a packaged drink misclassified COMPOSED is fixed by
reclassifying it. To that end the D60 backfill's Stage A rule now ALSO runs
at authoring time (`deriveSellableKind` in ProductsService): Service →
SERVICE, foodType set → COMPOSED_ITEM, else STOCK_ITEM — re-derived on
update only when an input of the rule changes, so authored rows can no
longer drift from backfilled ones.

**The ledger.** One `StockMovement` per (order item × depleted product):
negative delta, `ORDER_ROUND`, `refType RESTAURANT_ORDER_ITEM`, `refId` the
item, `balanceAfter` read back in-transaction. A void mirrors the RECORDED
movements (`…_VOID`, positive delta) — never a re-expansion, so a recipe
edited between submit and void still restores exactly what was taken; the
presence of a compensation row makes the restore idempotent. Takeaway
depletes through the same engine. Tenants with DISABLED inventory are a
full no-op — no ledger noise. Per §12.3.5, NOTHING is backfilled: history
stays purchase-side; depletion starts at cutover, forward only.

Engine: `providers/inventory/round-depletion.service.ts`, writing only
through the caller's transaction like every provider. Verified live end to
end: deplete 50 → 47.8 (2 × 1.1 wastage), void restore → 50, double-void
inert, oversell refused naming the ingredient, ledger pair
`-2.200/47.800` then `+2.200/50.000`.

### D66 — collections for every domain, and channel-scoped assortments

Implements Phase 9, the last phase of the convergence plan. Two changes and
one supersession:

**The surface opens.** The D62 collections routes
(`/branches/:id/collections` and descendants) are reclassified SHARED_CORE
— the catalogue is shared core, the same doctrine as `/products` and
`/products/sellable`. This SUPERSEDES D62's forward note that retail would
"gain the MENU_MANAGEMENT module": handing retail that module would have
opened the LEGACY `/restaurant/menus…` routes to hardware tenants, changing
what D60's gate assertions mean. Instead, writes follow the D65 components
pattern — refused `403 COLLECTIONS_NOT_ENABLED` for tenants whose domain
does not declare `capabilities.catalogue.collections`, reads open. The
capability flips TRUE for retail ("Trade counter", "Seasonal" — the plan's
original motivation for renaming menus) and for food service (menus ARE
collections; the capability now says so). GENERAL keeps false as the living
negative control, and the legacy `/restaurant` menu reads keep their
MENU_MANAGEMENT gate untouched.

**Channel scope.** `Menu.channels OrderChannel[] @default([])` (migration
`20260828000000`, additive — the empty default means what every existing
row already meant: all channels). Create/update accept it; the collections
list filters by `?channel=`; and `/products/sellable` honours it — asking a
DINE_IN-only assortment for TAKEAWAY yields an empty page, not the
collection anyway.

**The menu admin dies.** `components/restaurant/menu/**` is deleted
(browser, item wizard, CRUD dialogs, `?view=legacy` escape hatch — every
editing control had answered 410 since D60, and a browser of dead buttons
is a broken UI, not a fallback). `/menu` stays as a pointer card so
bookmarks explain themselves. `ProductSelectorDialog` — a generic product
search, not a menu concept — moved to `components/products/`, where the
promotion editor and the D65 recipe card import it.

Verified live on the hardware tenant: create scoped collection → section →
priced entry → sellable serves it (`COLLECTION_OVERRIDE`, 111.50), wrong
channel serves zero, channel list filter includes/excludes correctly.

### D67 — auto-printing, and dine-in as a waiter flow  *(superseded by D68)*

> **Superseded 2026-08-20 by [D68](#d68--the-kitchen-board-replaces-the-kitchen-printer).**
> The dine-in half stands and is live. Everything about PRINTING below —
> the outbox, the two transports, the on-site agent, the printer routing —
> was withdrawn and deleted a day after it shipped. It is kept here as the
> reasoning D68 overturns, not as a description of the system.

PO requirements, 2026-08-18/20. Two things that turned out to be one change:
the dine-in POS mode assumed a guest paying at the counter, and nothing in
the system ever drove a printer.

**Dine-in belongs to the waiter.** `/pos → Dine In` opened the counter cart
whenever no session was named — "guest is at the counter, payment collected
now, no table", the opposite of table service. It now always opens the table
picker → order entry. That screen also stopped reading the FROZEN legacy
menu tables (D60) and now reads the same converged catalogue as the counter
POS, sending PRODUCT-sourced lines: on a migrated workspace the legacy tree
is nearly empty, so the waiter was picking from a menu that no longer
exists.

**Printing is an outbox, drained after commit.** Phase 6 already wrote
`KitchenTicket` + `KitchenPrintAttempt` rows inside the round transaction
and never drove them. Now: submitting a round kicks a dispatcher that
renders ESC/POS and sends it; closing a table queues the bill in the close
transaction and prints it after commit. D53 is preserved absolutely —
printing can delay paper, never fail or slow an order. A failing printer
retries three times, then the ticket goes FAILED and surfaces on the KDS
with its reprint button.

**Takeaway prints both at placement** (PO, 2026-08-20): the cashier takes
that order, so the bill belongs on paper with the ticket. No Sale exists
yet, so the job points at the RestaurantOrder and is priced by
`computeRestaurantTotals` — the SAME calculator the close uses (D52/D59), so
paper and the Sale written minutes later cannot disagree. Handover then
skips its own bill, so a takeaway yields exactly one.

**Routing is owner-configured, user-overridable.** The owner adds printers
once per workspace (network scan or by IP) and marks each KITCHEN or
CASHIER; every user then picks their own defaults from that list. KOT: user
→ station links → branch default. Bill: user → branch default. An unrouted
item used to be dropped silently; it now falls back to a sole active station
and is logged by name otherwise.

**Two transports, chosen automatically.** The web app is on Amplify and the
API on EC2, and neither can open a socket to a printer on a shop LAN — while
a browser cannot speak raw ESC/POS at all (no TCP; HTTPS→private-IP is
blocked by mixed content, CORS and Private Network Access; `window.print()`
reaches exactly one OS-installed printer per device, so it cannot serve a
kitchen AND a cashier printer). So: an on-site agent (`apps/print-agent`)
dials out, leases work, prints on the LAN, acks. A branch whose agent has
checked in within two minutes is served by it and the server-side dispatcher
leaves those rows alone; a branch without one is printed directly by the API
(on-prem/single-machine installs). Leases with a TTL arbitrate, making
delivery at-least-once: a duplicate ticket is recoverable, a missing one is
not.

The ESC/POS encoder is in-repo (~15 commands) rather than a dependency, and
every template is asserted as real bytes.

### D68 — the kitchen board replaces the kitchen printer

PO decision, 2026-08-20, superseding D67 one day after it shipped. The
kitchen does not want paper. It wants a screen.

**Kitchen tickets are not printed at all.** Every item a waiter confirms
onto an order appears on the kitchen board, and kitchen staff mark it done
when the food is up. This is a genuine simplification, not a downgrade: a
row written inside the round's transaction cannot fail to arrive, so the
retry ladder, the lease arbitration, the two transports, the ESC/POS
encoder, the LAN discovery and the on-site agent all had exactly one
justification and it is gone. All of it was deleted rather than parked —
1,900 lines and a whole app. Dead infrastructure attracts callers.

**Kitchen staff are a role.** Phase 6 gave `KOT_VIEW` to no template a
workspace seeds, so the board only ever opened for an owner — tolerable
while it was a monitor for a printer, indefensible now that it is the sole
delivery. The template holds exactly three permissions: read the profile
(without it the nav rail renders empty, not reduced), see the board, mark a
ticket done. Nothing on the floor, nothing with money in it. The pass is
the one place in a restaurant with no till accountability, and a role that
could both cook and settle a bill is how that becomes a problem.

**A ticket carries where the food is going.** Station, table, order, round,
waiter — what the printed KOT carried, for the same reason: a dish the pass
can see but cannot place does not leave the kitchen. `OUTSTANDING` is a
filter meaning "not COMPLETED" rather than "QUEUED", so a ticket left on one
of the retired print statuses by a pre-D68 round still reads as work to do
instead of silently vanishing from the board.

**The waiter completes the order; the cashier prints the bill.** Closing a
table is unchanged mechanically — it still raises the Sale — but it is
labelled for what the floor actually does, and nothing prints on the way
past. The cashier presses **Print bill** on the bill screen, which uses the
browser print path the retail POS has always used. That mechanism was never
the problem: a browser prints fine when a human presses a button, because
the print dialog is expected and the destination is that till's own
printer. What a browser cannot do is print unattended to two different
printers, which is the only thing the D67 machinery existed to solve.

Takeaway follows the same rule: the ticket goes to the board, the cashier
prints the bill.

**Schema.** Forward-only. D67's five migrations are already applied to live
development databases, and deleting them would force a reset that wipes
seeded workspaces; one drop migration costs a file and no data. The retired
`KitchenTicketStatus` print values stay in the enum — persisted data with
rows on it, and removing an enum value is destructive for nothing.

### D69 — dine-in is the ordinary POS screen, plus a table

PO decision, 2026-08-21. Dine-in had its own screen (`PosDineInWorkspace` →
`OrderEntry`), built before the counter POS existed and diverging from it
ever since: a different menu browser, a different cart, a different set of
affordances for the same act of composing an order. Waiters and cashiers
work the same shift; they should not be learning two POS screens.

**One screen.** `?mode=dine-in` now renders `PosCounterWorkspace`, exactly as
takeaway and delivery do. The menu grid, the cart, per-line edit/discount,
the portrait cart sheet and the modifier dialog are the same code, so they
cannot drift apart again. The POS fork is deleted;
`/tables/session/[id]` still mounts `OrderEntry`, because the floor plan's
own route is a different job.

**Plus a table.** The one structural difference table service has is that an
order belongs to a table, over a period, across rounds — so a session block
sits above the menu. Picking a table swaps it for a one-line strip rather
than navigating, so the menu never unmounts and a waiter mid-order does not
lose their place.

**One screen, two tails.** Composition is identical; the button diverges.
Counter modes go customer → payment → completion. Dine-in confirms a ROUND
onto the table and empties the cart, ready for whatever the guests ask for
next, which is the actual shape of table service. Then: close the session →
the bill is raised → the cashier settles and prints it.

Two things this exposed, both fixed here rather than filed:

- **The permission gate was wrong for the role the flow exists for.** The
  counter's Place Order is gated on `TAKEAWAY_CREATE`; the WAITER template
  deliberately holds `ORDER_SEND_TO_KITCHEN` and not that. Reusing the gate
  would have left the waiter looking at a permanently disabled button.
- **D68's Print bill could never have worked.** It called
  `/receipts/:saleId/customer`, which sits behind
  `@RequireModule(RETAIL_POS)` and answers 403 "Feature not available" to
  every food-service workspace, the owner included. The bill is now rendered
  client-side like the split bill beside it, which has always worked for the
  same reason. Verified against a live restaurant tenant: the endpoint 403s
  for owner and cashier alike.

Also fixed: the POS never recorded who seated the table. `waiterUserId` is
optional and the server does not default it to the caller, so the kitchen
board showed tickets with no name on them and the close path fell back to
whoever pressed the button.

### D70 — a waiter sees their own tables

PO decision, 2026-08-21. Waiter A must not see the sessions Waiter B is
serving: those are somebody else's responsibility, and a floor list that
mixes them is how a table gets served twice or not at all.

**Expressed as a permission, granted as the WIDER case.**
`TABLE_SESSION_VIEW_ALL` means "every open session on the branch, not only
your own". Owner and Admin hold it through the full catalogue; the
restaurant Cashier holds it because the till settles whichever table asks;
the hotel Receptionist holds it because the desk IS the whole floor's view.
The Waiter template does not.

The direction matters. A `_OWN` narrowing would make the permissive case the
default, so a role that forgot to mention it would see everything — the
failure that must not be reachable by omission. This way a forgetful role
sees less than it might, which is recoverable.

**Enforced on the server, at every route that reaches a session.** Hiding
the list would have been cosmetic: the session id is in a URL, and both
"order onto this table" and "close this table" are addressable by it. So the
list narrows in its WHERE clause — a waiter must not be able to read another
waiter's guest count out of a response the client then hides — and `get`,
`detail`, `createOrder` and `close` each refuse a session that is not
theirs.

**Refused as not-found, not forbidden.** A 403 on a specific id confirms
that the session exists and that somebody else has it, which is precisely
the fact being withheld.

**An unclaimed session is refused too.** `waiterUserId` is nullable — the
synthetic walk-in table behind counter and takeaway orders has no waiter —
and "nobody's" must not read as "everybody's". The POS records the waiter
when it seats a table, so a dine-in session always has one.

Frontend copy follows the rule rather than restating it: "Your open tables".

### D71 — the waiter holds the bill

PO decision, 2026-08-21. The waiter is the one talking to the guests, so the
waiter is the one who has to answer "what have we had", "what do we owe" and
"can we pay separately". All three lived at the till, on a screen a waiter
never opens — which meant the cashier reconstructing who ate what from a
conversation they were not part of.

**The full order, on the POS screen.** The cart shows what has not been sent
yet; the bill sheet shows everything that HAS, grouped by round, because that
is the order the guests ate in and the order they will remember when they
query a line.

**The server prices it.** `GET /table-sessions/:id/bill-preview` reads the
same rows the close will read and runs `computeRestaurantTotals` — the same
calculator (D52/D59) — so what a guest is shown at the table and what they
are charged a minute later cannot differ. The client never re-adds the lines.
A service charge the client does not know about is exactly the kind of
difference that turns into an argument at the table.

**Splitting moved to the waiter.** `BILL_SPLIT` joins the WAITER template.
`PAYMENT_COLLECT` deliberately does not: a waiter can divide a bill four ways
and still cannot settle any of the four. Verified live — the waiter's own
split-by-items succeeds and their attempt to collect a payment is refused.

**The split surface is shared, not copied.** `ItemSplitAssigner` was lifted
out of the bill screen (D51) so both the table and the till use the identical
control. A second copy would have been two split UIs with one set of money
rules between them, and they would have drifted the first time either was
touched.

**Why the split brackets the close.** Splits attach to a Sale and an open
session has none, so confirming does two things in order: close the session
(raising the Sale), then split it. These cannot be made atomic from a
browser, so the failure is designed rather than hoped away: if the split call
fails the close still stands, the waiter is told the table IS closed and that
the cashier can finish the division at the till. Reporting a plain failure
there would invite them to press it again against a session that no longer
exists — which is why the half-failure has its own test.

### D72 — the printed bill looks like a restaurant bill

PO decision, 2026-08-21, against a photographed reference bill. The layout is
now: centred logo, address, phone numbers, then Served By / date / bill
number / table, then a ruled DESCRIPTION / QTY / AMOUNT table, the tender,
and the totals block — Total Qty, Bill Amount, Paid Amount, Bal. Amount —
closing on the tenant's footer text.

**One template, two callers.** `renderThermalBill` prints the whole bill and
each split bill. They were two hand-written documents, which is how a tenant
ends up with a logo on one and not the other. A split's share IS its total:
the server has already apportioned the service charge into it, so the
template does not list bill-level charges again on a split.

**The header is the tenant's, and never the vendor's.** Everything above the
rule comes from the document profile (Settings → Documents), including the
logo, which was already uploadable and simply unused by the bill. The logo
REPLACES the company name rather than sitting above it: on the reference
bill the mark carries the wordmark, and printing both gives the guest the
brand twice. With no logo the name prints instead, so the header is never
anonymous. Nothing is substituted for an unset field (D54).

**Notes and discounts are on the paper.** A line's special instruction prints
indented beneath the line it belongs to — a guest querying a charge reads the
line they remember ordering, and a note is often the only thing separating
two identical lines. A discount prints as a DEDUCTION: shown as a positive
in a column of charges it reads as one more thing to pay. Zero rows are
omitted; a bill listing "Discount 0.00" is noise.

Three fields the bill needed and `BillView` did not carry: `taxAmount` (so a
taxed branch's bill can add up at all), `totalDiscount`, and the line's
`specialInstructions` — plus `servedByName`, `placeLabel` and `closedAt` for
the header. Served-by prefers `servedByUserId` over `cashierId`: the guest is
thinking of whoever brought the food, not the till operator.

**Two defects found while building it.** The escaper handled `&<>` only,
which is fine where every value lands in a text node but not here — the logo
URL goes inside `src="…"`, and a value containing a quote closes the
attribute. Found by a test feeding it `" onerror="alert(1)`. And the print
window fired `print()` on a 400 ms timer, which predates the bill having an
image at all; it now waits for every image to load or fail, with a 4 s
backstop so an unreachable logo cannot leave the dialog un-opened.

The retail receipt is deliberately untouched — it is the Tile Shop's
document, and D16 keeps its behaviour and wording as they are.

### D73 — a receipt wastes no paper between pages

PO report, 2026-08-21: the printed bill carried a page number and the word
"about:blank", and a long order came out looking like separate receipts.

**`@page { margin: 0 }` does both jobs.** It removes the browser's own print
header and footer — the page counter and the URL of the popup the bill is
written into — because with no page margin there is nowhere for that chrome
to be drawn, and CSS has no other lever over it. And it is what makes a long
bill read as ONE receipt: the gap between one page and the next IS the page
margin, and on a continuous roll that gap prints as a band of blank paper
mid-bill that looks like the receipt was cut and restarted. At zero, page two
carries on exactly where page one stopped.

**The page is deliberately NOT given a size — corrected the same day.** The
first attempt measured the document and wrote `size: 80mm <height>mm` so the
whole bill was a single page. Browsers honour an oversized page by SCALING it
onto the physical paper, so a long order printed correct and unreadably
small. The paper size belongs to the printer; the only thing this document
asserts is that it wastes none of it. The regression test names `size` so
the same fix cannot be reintroduced by someone solving "it splits across
pages" again.

Two smaller rules finish the job. Rows, the tender and the totals block carry
`break-inside: avoid`, so a line is never cut in half mid-row and the balance
is never stranded alone. And `thead { display: table-row-group }` stops the
column headings repeating at the top of every page — a browser repeats them
by design, which is right for a report and wrong on a roll, where a guest
reads the repeat as a second receipt starting.

Verified page by page in a real browser: a 60-line bill across three pages
prints the header once, continues flush from the top of page two with no
heading and no gap, and closes with an unsplit totals block. A short bill is
byte-for-byte what it was.

### D74 — the print popup drives itself

PO request, 2026-08-21. Pressing Print bill opens the print dialog with no
click on the page, and the popup closes once the browser is finished with it.

`afterprint` fires whether the operator printed or dismissed the dialog, and
no web API distinguishes the two, so both close the window: a cashier who
cancels wanted out of it either way, and the alternative is a dead receipt
tab left open behind the POS. The listener is attached BEFORE `print()`,
because `print()` is synchronous in some browsers and the event has already
fired by the time it returns.

**The dialog's own confirm button is not ours to remove.** Only Chrome's
`--kiosk-printing` launch flag makes `window.print()` go straight to the
default printer, and a page cannot set it. On a till launched with that flag
this is already the whole interaction.

The popup is also opened in the click's own turn now, before the document
profile is fetched. Browsers grant a gesture a few seconds of transient
activation, and `window.open` after an `await` gambles on that not having
lapsed — on a slow connection the popup is simply blocked and nothing appears
to happen. It opens with a placeholder and is filled in when the data lands;
`abort()` closes it if the data never does.

### D75 — the receipt ends where the text ends

PO reports, 2026-08-21, with photographs: a band of blank paper mid-receipt
between "Soup of the Day" and "Vegetable Fried Rice", and a large blank area
after the footer that had to be fed before the bill could be torn off.

Both are the same defect — the receipt was being paginated — and one
mechanism fixes both: ONE page, sized to the content. No boundary to leak a
gap, no remainder to feed.

**This is the second attempt, and the difference matters.** The first sized
the page and shrank long bills. `@page { size }` is a REQUEST: where it does
not match the paper the driver reports, Chrome scales the page to fit, and
432 mm of receipt on a 297 mm sheet is 69% — exactly the unreadable print
that came back. That is a printer-side setting (a roll or custom paper
length, and Scale at 100%), not something CSS can assert. So it is now
switchable per call: a workspace whose driver has a fixed page length turns
it off and pages normally at the correct size instead.

The height is measured rather than declared, because `size: 80mm auto` is
invalid CSS — the property takes one or two lengths — and because the real
height depends on how the document lays out. Measured after images settle: a
logo that has not decoded reports no height and would truncate the receipt to
the height of its text. Two millimetres are added so the cutter does not
shave the footer.

**`break-inside: avoid` was removed, having caused the first gap.** It was
there to stop a line being cut at a page boundary. On a continuous roll that
protection costs more than it buys: a row that does not fit is pushed WHOLE
onto the next page, and the space it vacated prints as blank paper mid-bill.
With the pages abutting, an allowed break rejoins invisibly and an avoided
one leaves a hole. `thead` is likewise demoted to a row group so the column
headings do not reprint mid-receipt, where a guest reads them as a second
bill starting.

### D76 — the column is the printable width, and the popup closes itself

PO report, 2026-08-21, on the D74/D75 delivery: the bill fitted one page but
printed SMALLER, and the popup stayed open.

**Why it printed smaller.** An 80 mm thermal roll has a printable width of
about 72 mm — 576 dots at 203 dpi, the rest under the mechanism. The page was
declared at 80 mm, so Chrome had a page it could not fit on the paper and did
what it always does with a mismatch: scaled it, by roughly the 90% the PO was
looking at. The fix is to stop asking for something the printer cannot give
— the column and the declared page are both 72 mm now, and a browser with
nothing to reconcile has no reason to scale.

Two supporting rules, each of which reintroduces the same defect on its own:
`box-sizing: border-box`, because with content-box the side padding is added
OUTSIDE the width and a 272 px column becomes a 296 px body on a 272 px page;
and one width for both media, because the page height is measured from the
on-screen layout and applied to the printed page, so a print column of a
different width prints short or long.

**Why the popup stayed open.** `afterprint` is the correct event and Chrome
does not reliably deliver it to a listener the OPENER registered on a
scripted popup. The close is now driven from the call site instead:
`window.print()` blocks until the dialog is dismissed, in every desktop
browser, so the line after it is the moment the browser is finished with the
document. The listener stays as a second path, guarded on `closed` so the two
cannot fight.

Verified: one 72 × 223 mm page, content filling the full width, ending 2 mm
after the footer.

### D77 — the receipt prints itself; the page size is the printer's

PO report, 2026-08-21, on the D76 delivery: both issues unchanged. Third
attempt at each, and this record supersedes the reasoning in D74–D76.

**The popup now closes itself, from inside.** Two assumptions were wrong.
`otherWindow.print()` does NOT block the caller — the dialog is modal to the
popup, not to the opener — so a `close()` on the next line ran while the
preview was still up, and Chrome ignores that. And `afterprint` is not
reliably delivered to a listener the OPENER registered on a scripted popup.
Both calls now live in a script inside the receipt document, where
`window.print()` blocks its own window and a script-opened window may always
close itself. Verified in a real browser: the popup closes on its own.

**The page size goes back to the printer.** Sizing the page to the content is
what a roll wants — no boundary to leak a gap, no remainder to feed — and it
cost correct print twice, at 432 mm and again at 223 mm. `@page { size }` is
a REQUEST: where the declared height exceeds the paper the driver reports,
Chrome scales the page down to fit, and the height of a receipt is by nature
whatever the order came to. There is no height that is safe on a fixed-length
page. So the fitting is opt-in, for a driver configured with a continuous
roll, and correct size wins by default.

**The column is 80 mm again.** D76 narrowed it to 72 mm — an 80 mm roll's
printable area — on the theory that the mismatch was causing the scaling. It
was not, and the receipt simply printed as a narrower column, which reads as
"smaller" too. The printer this ships against prints the full width.

What survives from D73–D76 and is confirmed working: `@page { margin: 0 }`
(no browser header or footer, and no gap between pages), no
`break-inside: avoid` (which was itself the photographed gap), and headings
printed once rather than per page.

Still outstanding, and it is a printer setting rather than a defect: paper is
fed to the end of the last page. Set the driver to a continuous/roll length
and the opt-in fitting removes it.

### D78 — printed from an iframe, at the printable width

PO report, 2026-08-21, with a photograph: at 80 mm the AMOUNT column bled off
the edge ("LKR 1,450.00" printed as "LKR 1,450.0"), the popup still would not
close, and with the driver now set to continuous paper the receipt still
broke across two pages.

**No popup.** Three rounds were spent trying to make one close itself — from
the opener (Chrome ignores `close()` while the preview is up, and does not
deliver `afterprint` to a listener the opener registered) and then from a
script inside the document. The receipt now prints from a hidden IFRAME, so
there is no window to close. The dialog opens over the app and dismissing it
leaves the operator where they were. Cleanup is a detached DOM node: were it
ever delayed, nobody would see anything, which is the opposite failure mode
to a receipt window left standing open. It also takes the popup blocker out
of the picture, so the document profile can be fetched first without racing
a user gesture.

The frame is positioned off-screen at the receipt's true width rather than
sized 0×0 — a zero-width frame lays out at zero width, wraps every line, and
would report a height with no relation to the printed bill.

**72 mm, left-aligned.** About 8 mm of an 80 mm roll sits under the mechanism
(576 printable dots at 203 dpi), so a column set to the paper width bleeds.
This is not the question the scaling turned on — that was the page HEIGHT
(D77) — and guessing it both ways cost a round each. Left-aligned because
centring a 72 mm column inside whatever page the driver reports puts 4 mm of
slack on each side and pushes the right-hand column past the last printable
dot: the same bleed by another route.

**One page, now that the driver can honour it.** With continuous paper set,
the measured `@page { size }` is no longer a request the printer has to
refuse, so the fitting is back on for receipts: one page, no boundary to leak
a gap, no remainder to feed.

### D79 — no window at all, and the width comes from the driver

PO report, 2026-08-21, with the driver dialog attached — which answered in
one screenshot what three rounds of guessing had not.

**Xprinter XP-365B, stock "USER": Maximum Size 78.7 × 101.6 mm, exposed liner
0.0 mm, margins 4 mm top and bottom.** Every symptom follows from those
numbers:

- 80 mm bled off the right, because the stock is 78.7 mm wide.
- 72 mm left a band of white down both sides, because the shorter page was
  centred on 78.7 mm of paper.
- The receipt split, because a 101.6 mm maximum length cannot hold a bill of
  any size — and the 4 mm top and bottom margins were the gap between the
  pieces.

The PO fixed the last one at the printer, which is where it belonged: a
longer Maximum Length. The width is this file's to get right, and it is now
78 mm, edge to edge — the page IS the printable area, so there is no column,
no centring and no padding.

**The print window is gone, not fixed.** Four reports of a receipt window
that would not close, chased from the opener and then from a script inside
the popup. Receipts now print from a hidden IFRAME: there is no window to
close, the dialog opens over the app, and dismissing it leaves the operator
where they were. `openPrintWindow` survives as a name and delegates — every
popup-based path had the same defect, and fixing them one at a time would
have left the next one to rediscover it.

The regression to guard is therefore not "does the window close" but "was one
opened at all", and the spec asserts exactly that: `window.open` is stubbed to
fail if anything in the module calls it.

The page size stays off for retail receipts, which print to whatever sheet
the till is set up with (D16). Only the thermal bill asks to be sized to its
content, and that only works because the driver's Maximum Length now allows
it.

### D80 — the page is the stock; the text is inset from the right

PO photograph, 2026-08-21: the bleed returned and worse — "LKR 1,450.00"
printed as "LKR 1,450.", "AMOUNT" as "AMOU".

D79 read the driver's stock width (78.7 mm) as the printable width and set
the text edge to edge on a 78 mm page. It is not: it is the width of the
PAPER, and the head stops short of it. Two characters at this font size is
about 3.5 mm.

These are two numbers, and every round that went wrong conflated them:

- The PAGE matches the driver's stock, so nothing is centred and no width is
  lost before the content starts. Getting this wrong at 72 mm is what left a
  band of white down both margins.
- The TEXT is inset 6 mm from the RIGHT, where the head stops. Getting this
  wrong at 0 mm is the bleed, twice; 4 mm cleared the clip but left the
  amounts hard against the edge, so it was raised the same day.

Left alone at 0: that edge has printed cleanly throughout, and insetting both
sides is the white the PO rejected. The inset is a single named constant
which the stylesheet interpolates, so the two cannot drift — and it is the
only number to change for a printer that clips a different amount.

Verified by rendering at the page width and measuring: the furthest ink lands
at 280 px of a 295 px page, exactly on the content edge, with nothing
overflowing.

### D81 — a storage failure names the bucket, the place, and the way out

PO report, 2026-08-21: uploading a business logo on a local Windows machine
failed with "The specified bucket does not exist".

Nothing was wrong with the code. `apps/api/.env` had been copied from a
machine configured for S3 (`STORAGE_PROVIDER=s3`, LocalStack at
127.0.0.1:4566), and that endpoint does not exist on a laptop. The default
has always been local disk; the environment overrode it.

What IS wrong is the message. It names neither the bucket, nor where the
bucket was looked for, nor the fact that this deployment is pointed at S3 at
all — and the fix is one line in a file the operator already has open. So the
S3 provider now explains its own failures: which bucket, which endpoint (or
region, on real AWS), and `STORAGE_PROVIDER=local` as the way out. Rejected
credentials and a refused connection get their own wording, because sending
someone to hunt for a missing bucket when the key is wrong wastes the same
hour again.

Raised as a 500, not a 400. The upload was valid and the SERVER is
misconfigured; a 400 sends the operator off to blame their image file. An
unsupported image type stays a 400 — that one really is the caller's.

### D82 — the LocalStack bucket creates itself

Follow-up to D81, 2026-08-21: the PO's LocalStack WAS running from
docker-compose, and the upload still failed with "The specified bucket does
not exist".

Both facts are true at once. A reachable LocalStack that returns
`NoSuchBucket` is not a connection problem — the community image does not
persist objects across container re-creation (that is a Pro feature), so it
starts empty every time and a bucket made by hand disappears with the next
rebuild. The compose file said so in a comment, which is the wrong place for
a step that has to happen every time.

The bucket is now created by an init hook in
`docker/localstack/ready.d`, which LocalStack runs once the S3 service
reports ready. Idempotent, so an existing bucket is a no-op rather than an
error.

Verified against a real container, not by reading the docs: first start logs
`HeadBucket => 404` then `CreateBucket => 200`; a restart shows the image
losing the bucket and making it again — which is the papercut this removes —
and running the script twice inside one container reports "already exists"
and exits 0.

### D83 — the bill where the work is, and the order behind a ticket

PO requests, 2026-08-21.

**The finalised bill is a dialog, not a link.** Closing a table used to offer
"View bill" pointing at `/bills/:id`. A waiter is standing at the table with
guests asking what they owe; sending them to another screen mid-service is
the wrong answer. The bill now opens in place the moment the table closes —
lines, totals, splits, and a Print button — and the strip re-opens it, so
dismissing it is not a one-way door.

**The Orders queue can open and reprint a bill.** That button existed,
disabled, labelled "Bill navigation lands in a follow-up slice": the queue
row carried a payment status but not the id of the sale it belonged to. The
projection already resolves the sale to read its total, so the id was there
all along — it is now exposed and the same dialog opens over the queue. A
third-party row has no sale of ours and gets no button at all, rather than a
greyed-out one that invites people to keep trying it.

**A kitchen ticket can show its whole order.** A card lists only what THIS
station is making, which is right for cooking and wrong for timing: the grill
cannot tell whether it is plating alone or alongside a curry the main kitchen
has not started. Details opens every item on the order, grouped by round and
labelled with the station that received it — read back from the tickets
rather than re-derived from the routing links, because a link can be edited
after the fact and the ticket is what the kitchen actually got.

KOT_VIEW, like the board, and deliberately NOT routed through the
table-session read: that one is scoped to the waiter who owns the table
(D70), and the kitchen owns no tables.

### D84 — the service charge has somewhere to be set

PO request, 2026-08-21: the service charge should appear on dine-in bills and
be configurable by the owner.

Half of it already worked. `computeRestaurantTotals` has applied the charge
since D52 and the bill template has printed it since D72 — but nothing in the
app could set the number, so it sat at the schema default of 0.00 and every
bill quite correctly showed no service charge.

Settings gains a Charges tab: the percentage, which channels levy it, whether
tax applies on top of it, and the flat packaging charge for takeaway. Per
BRANCH, because that is where the row lives and a group prices its rooms
differently. The channel toggles are explicit rather than assumed — "10% on
dine-in only" and "10% on everything" are both ordinary, and guessing puts
money on a bill that should not carry it.

Its own save button, outside the page's sticky bar: that bar writes the
document profile, and the charges live on a different row with its own
optimistic-concurrency version. One button writing two unrelated records is
how a stale version silently clobbers an edit.

Verified end to end against a live tenant: owner sets 10% → a dine-in preview
reads 6400.00 + 640.00 = 7040.00 → the closed bill agrees, and the Orders
queue row carries the sale id that opens it.

### D85 — a modal never grows past the screen

PO request, 2026-08-21: no popup may bleed off the viewport; 80% of the
height is the ceiling, and content beyond that scrolls.

`Dialog` had no cap at all. It grew with its content and ran off BOTH ends of
the screen — and the FOOTER went with it, so the confirm button on a long
bill or a long split list sat below the fold with no way to reach it and no
scrollbar to find it. The content was never the casualty; the actions were.

Three rules, and any one of them alone leaves the bug intact: the card is
capped and lays out as a column; the BODY is the scroller — `min-h-0`
included, without which a flex child's min-height is its content and the card
grows past the cap instead of overflowing inside it; and header and footer
are `shrink-0`, so the body is the only thing that gives.

`dvh`, not `vh`: on a phone or an iPad in Safari the toolbar collapses and
expands, and `vh` measures the tallest state — exactly the state where the
dialog does not fit.

The ceiling is now the same everywhere rather than per-control. `Sheet`
already capped itself but at 85dvh, with `height='full'` claiming the
viewport minus a 3rem strip; the retail cart panel took 88dvh. All three are
80dvh. `Drawer` is left alone — a side panel is full-height by design and
already scrolls its body.

Measured in a real browser at 1194×834, 834×1194 and 390×844: the card is
exactly 80.0% of the viewport at each, sits fully on screen, the confirm
button is reachable, and the body scrolls. Mutation-proven four ways —
removing the cap, dropping `min-h-0`, moving the scroll to the card, and
letting the footer shrink each fail.

### D86 — the logo has to be an absolute URL

PO report, 2026-08-21: a logo uploaded in Settings → Branding did not appear
on the printed receipt.

An uploaded asset is stored as `/uploads/<key>`, and `/uploads` is served by
the API — a different origin from the web app in every deployment (:4000 vs
:3000 locally, api.axlopos.com vs the Amplify host in production). Printed
raw, the browser resolves it against the app's own origin, finds nothing, and
the receipt comes out with the logo silently missing: no error, no
broken-image icon on paper, just no brand. `resolveImageUrl` is what the
product screens have always used for exactly this, and the bill template now
uses it too.

Also removed: the "Total Qty" row above the subtotal (PO). The reference bill
carried one; a guest counts plates, not units, and it is the only figure on
the receipt that is neither money nor a line they ordered.

**Not a defect — the service charge.** Reported in the same message as
missing from the bill. It is captured at CLOSE time onto the Sale, which is
correct: a bill is a settled document, and changing a rate afterwards must
not rewrite what a guest already paid. The database says so plainly — the
rate was set at 12:31; S-000007, closed at 12:32, carries 640.00, and every
sale closed before it carries 0.00 and always will. A rate set today applies
to tables closed after it, not to bills already raised.

### D87 — the till prints, the waiter serves, and every page has a floor

PO, 2026-08-21, four things in two messages.

**Two names on the bill.** "Served By" is the waiter — the person the guest
actually spoke to — and a new **Cashier** line under it names whoever pressed
Print. They are different people and the receipt now says so, which is what
makes a printed bill answerable: a guest querying the food knows who served
them, and a manager querying the money knows who took it. The waiter comes
from the session; the cashier is read from the printing user's own session at
print time, not stored on the Sale — reprint it tomorrow from a different till
and the line correctly names whoever reprinted it.

**Only the till prints.** Print is gated on `PAYMENT_COLLECT`, which the
waiter template does not carry and the cashier and owner do. The waiter still
sees the whole bill, still splits it, still closes the table — they just have
no Print button and no "Open billing" link, because handing a printed bill to
a guest is a payment act and the waiter does not take payment.

This is the frontend half of a rule the server already enforced (D31: hiding
is usability, the server is the authority). `POST /v1/restaurant/billing/…`
still refuses a waiter's token, and that refusal, not the missing button, is
what protects the till.

**Bottom padding — and a Tailwind trap worth recording.** Almost every
restaurant screen ran its last row flush against the bottom of the scroll
container. The app shell had `p-4 pb-safe md:p-6`; `pb-safe` sets
`padding-bottom: env(safe-area-inset-bottom)` — which is **0 on every device
without a notch**, and because it comes after `p-4` it *replaces* the 16px
rather than adding to it. The screens with no bottom padding had it deleted by
the class meant to protect it.

My first fix was `pb-safe-8 md:pb-safe-12`, and it was wrong in a way that
looked right in the markup: **Tailwind generates no variants for a custom
class**, so `md:pb-safe-12` compiled to nothing at all. The shell now uses a
single `.pb-page` that carries its own media query — `calc(2rem + env(...))`
below 48rem, `calc(3rem + ...)` above. Measured in a real browser: 32px at
390×844 and 48px at 1194×834, where it used to be 0.

`TAB-PAD-001` reads the computed padding off the real scroll container rather
than asserting a class name, so it fails on the `md:` trap, on a reverted
`pb-safe`, and on a future shell that pads the wrong element.

**The waiter's POS shows Dine In and Takeaway.** A waiter has no reason to
raise a Delivery order — that is a counter and third-party channel — but a
seated guest asking for something to take home is ordinary, so takeaway stays.
The waiter and restaurant-cashier templates gained `TAKEAWAY_CREATE`
(`TAKEAWAY_VIEW` too, for the waiter), and the order-type modal takes an
explicit `modes` list instead of hard-coding all three. When only one mode is
available the modal does not appear at all and the mode chip is hidden — a
choice of one is not a choice.

**Honest limit.** Mode filtering here is presentation. `PosOrderTypeModal`
offers what the permissions allow; the server is what refuses a delivery
order from a waiter's token, and it still does. Anyone reading the modes list
as a security boundary would be reading it wrong.

**Requires a reseed.** The two template grants only reach existing users
through `pnpm db:seed`; roles already in the database keep the permissions
they were created with.


### D88 — a reload must not change who you are

Found while verifying D87 in a browser, not by a test: the waiter's order-type
chooser rendered with **no options at all**.

`loadSession()` overwrote the stored permission set with
`permissionsForRole(user.role)` on every read — the enum role, not the role
row. For a user whose authority is a custom role that is simply the wrong set:
the waiter's enum is CASHIER, so a page reload silently turned them into a
retail cashier. `toSession` had already been fixed to keep what the server
resolved at login; the store threw it away again on the next load, which is
why the bug only ever appeared **after a refresh** and never during a session.

What a waiter lost on F5: dine-in (`ORDER_SEND_TO_KITCHEN`), takeaway,
bill splitting, opening a table. What they gained: `SALE_READ` — a Sales entry
in the rail that the API refuses. The fix trusts the stored set and falls back
to the enum only when there is nothing stored, which is the one case the
original comment was actually about.

**The gap it was hiding.** With the fallback gone, the restaurant cashier's
navigation went blank and `/pos` fell back to the retail checkout: the
`RESTAURANT_CASHIER` template never held `PLATFORM_PROFILE_READ`. It worked
because the retail CASHIER enum carries that permission and every reload was
handing it over. The template now holds it in its own right.

This is the failure mode D30 exists for: two wrongs that cancelled, and no
test could see either. The tripwire is a real jsdom round-trip through
`saveSession`/`loadSession` asserting the stored set survives (positive) and
that `SALE_READ` does not appear (negative), with three inline mutation
proofs — unconditional re-derivation, merging both sets, and an inverted
guard. Restoring the original line fails two of them.


### D89 — the rail's footer note earns its space or leaves

PO, 2026-08-21: remove "Sales and catalogue are managed in AxloPOS." from the
sidebar.

The QuickBooks note exists to answer a real question — *where do my books
live?* — and its answer is somewhere else. The AxloPOS variant answered the
same question with the name of the app the reader is already looking at, and
charged a divider and a block of rail for it. `NONE` now returns null, which
removes the note **and** the rule above it; the QuickBooks sentence is
untouched, verbatim, per D16.

The tripwire asserts both halves in one test — QuickBooks present, AxloPOS
absent, and no empty divider left behind. Split in two, deleting the entire
footer would leave the negative green and read as a pass. Mutation-proven both
ways: restoring the sentence fails it, and deleting the whole footer fails it.


### D90 — opening hours the owner sets, per weekday and per date

PO, 2026-08-21: the restaurant's opening and closing hours should be
configurable from Settings, per weekday *and* for individual dates — every
Monday 09:00–22:00 against an ordinary 07:00–23:00, and 13 August (a poya day)
on its own terms. The calendar's hours must follow.

**Two tables, because they answer two different questions.** A weekly rule is
what the restaurant normally does; an override is what it is doing on one
named date. Folding both into one table means either seven rows carrying a
nullable date or a date column that is sometimes a weekday, and the query that
resolves "what are today's hours" stops being obvious. Resolution is
override → weekday rule → fallback, first match wins, and the fallback is the
08:00–23:00 the calendar has always drawn, so a branch nobody has configured
renders exactly as it does today.

**Minutes since local midnight, stored as `Int`.** Not a `DateTime`: a
restaurant that opens at seven opens at seven, on the wall clock, in March and
in October. A timestamp would carry a date nobody means and a UTC offset that
moves under it. Not `"HH:MM"` text either — every comparison would parse a
string. `closesAt` may exceed 1440 to mean the small hours of the next day
(a kitchen closing at 01:00 is `1500`), which is why closing is stored as a
duration from the same midnight rather than a clock time: `01:00` and `25:00`
are the same wall clock and very different closing times.

**Per branch.** Hours are a property of a location — a group's city branch and
its beach branch keep different ones — and this is where `RestaurantBranchConfig`
already lives. Writes need `RESTAURANT_CONFIG_MANAGE` (the owner). Reads are
gated on `PLATFORM_PROFILE_READ`, which every food-service role now holds
(D88), because the calendar is a floor tool: the waiter reading the book needs
today's hours as much as the owner setting them.

**A closed day still draws its bookings.** If a date is marked closed but a
reservation exists on it, the calendar shows the reservation and says the
branch is closed. Hiding a booking because the hours say the door is shut
loses a guest who is going to turn up anyway; the widening rule that has
always kept a late booking on-chart is unchanged and now widens past the
configured window as well.

**One Save button per tab.** Adding a second self-saving tab exposed a bug in
the first: the sticky bar at the bottom of Settings saves the DOCUMENT
profile, and it is fixed to the viewport, so on Charges (D84) it sat on top of
the Save button that actually applied to what the operator had just edited.
Two Save buttons with the wrong one on top. The bar is now hidden on the tabs
that write their own record.

**Migration.** `20260904000000_add_branch_opening_hours` adds
`BranchOpeningHours` (unique per branch+weekday) and `BranchOpeningHoursOverride`
(unique per branch+date). Both cascade from branch and tenant. No existing row
is touched and no column is dropped, so a deploy that runs the migration
without the new UI behaves exactly as before.


### D91 — the picker shows the room, not just the empty seats

PO, 2026-08-21: the dine-in POS should show open tables too, with a filter for
them in the "which table" block.

The block listed only `AVAILABLE` tables. A seated one was simply **absent** —
so a waiter looking for the party on M4 saw a gap where M4 should be, with no
way to tell whether the table was taken, being cleaned, or had been deleted.
The only occupied tables anywhere on the screen were the waiter's own, in the
strip above, and a floor has more tables on it than that.

Every table in the area is drawn now, and a three-state filter — **All · Free ·
Open** — narrows the list rather than defining it. The default is All, because
the ask was to *see* open tables, not to go looking for a filter first.
"Open" means a session is running (`SEATED`, `OCCUPIED`, `BILLING`): those are
one party at one table from the floor's point of view, and asking a waiter to
know which of the three their table is in would be a filter that hides things
for reasons they cannot see.

**Shown is not the same as offered.** A tap does three different things now: it
seats a free table, resumes one of the waiter's own, and does nothing at all
for anyone else's — that one is drawn greyed, with its state named and a title
saying whose it is. This is D70 held to rather than worked around: the server
returns only sessions this user opened, so a table that is occupied and absent
from that list belongs to another waiter, and offering the tap would be
offering a refusal. A supervisor holding `TABLE_SESSION_VIEW_ALL` sees them all
as workable, which is the same rule, not an exception to it.

The state chips share ONE row with the area chips. A second row costs 44px of a
block that is capped at half the viewport, and the two read left to right:
which tables, then where.

**A stale cap, found while measuring.** That half-viewport rule was expressed
as `max-h-[calc(50vh-11rem)]` on the table grid — the 11rem being a fixed
reserve for the block's own chrome, measured once on a tablet. The new chips
wrap to a second row on a narrow screen, where the real chrome is **15.5rem**,
so the block would have quietly grown past half the screen on a phone. The
guess is gone: the CARD carries `max-h-[50dvh]` and the grid takes what is
left. The constraint is now exact at every width with nothing to keep in step.
Measured at 834×1194, 1194×834, 390×844 and a deliberately cramped 390×500 —
within half the viewport at each, with the grid scrolling and tables still
reachable at the smallest.

Mutation-proven three ways in the render spec (restoring the AVAILABLE-only
filter fails five tests; rendering the chips but ignoring them fails three;
making every table clickable regardless of ownership fails one), and once more
against the browser — `TAB-DINE-003` fails when the chips are ignored. One test
of mine was replaced during this work for promising an empty-state assertion
it never made.


### D92 — Open is a destination, not a second filter

PO, 2026-08-21, on the D91 picker: drop the All and Free chips and put Open in
the area strip, as if it were another area.

D91 had shipped two independent selections side by side — table state and
dining area — which is six combinations for a question with one answer:
*which tables am I looking at?* The strip now carries one selection: **Open**,
then each floor. Open first, because during service "carry on with a table" is
the commoner errand than "seat a new party", and a strip that scrolls should
not hide the commonest destination behind a swipe.

The partition falls out of it, and is better than what D91 had: an open table
lives under Open and nowhere else, a free one lives on its floor and nowhere
else. Every table on the branch is in exactly one place, so no selection can
hide one — which was D91's whole point, kept, with a third of the controls.
Open spans every floor, because a waiter carrying two tables in two rooms
should not have to remember which room to look in. A floor whose tables are
all seated says so and points at Open, rather than reading as a floor with no
tables in it.

What did not change: another waiter's table is still drawn and still dead
(D70 — the server returns only sessions this user opened), and "Your open
tables" still sits above everything, cross-floor and unfiltered.

### D92b — `__walk_in__` was never internal

Same message: change `__walk_in__` to "Walk In" everywhere.

A `DiningArea` row's `name` **is** its display name. The synthetic area that
takeaway orders hang their table from was called `__walk_in__`, so that string
appeared verbatim as a chip in the waiter's picker and on the floor plan. It
was only ever invisible on a branch that had never taken a takeaway order.

The rename moves the identity, though, and that needed care.
`@@unique([branchId, name])` means an owner who calls a floor "Walk In" would
collide with the synthetic row — a name nobody would type was doing real work
as an identifier, and a readable one cannot. `ensureWalkInTable` now looks the
row up by its reserved **position** (999; the delivery hub holds 998, and the
Tables screen numbers floors from 0), falling back to the name for a row the
migration could not rename. Reusing an operator's own floor is a strange home
for a synthetic table; failing every takeaway order on that branch is worse.

`20260905000000_rename_walk_in_area` is data-only and guarded with `NOT
EXISTS` for the same constraint: one branch with an existing "Walk In" would
otherwise abort the migration, and with it the deploy.

`__delivery__` is untouched — it was not what was asked, and it identifies the
same way. `hardcoded-audit.md` H6 moves from OPEN to PARTIAL rather than
closed, because half of it is still a magic string.

**Still open, and worth a decision:** the Walk In floor is now a
normal-looking chip in the waiter's dine-in picker, holding a WALK-IN table a
waiter can seat — which would open a dine-in session on takeaway plumbing. It
was equally seatable before, just uglier and easier to ignore. Hiding the
reserved floors (999/998) from the dine-in picker is a small change; it is not
this one.


### D93 — a rail entry is gated on what the screen can do

PO, 2026-08-25: "In restaurant POS, cashier should also be able to place takeaway
and delivery orders. That part is missing it seems."

It was not missing. It was unsigned.

The server has permitted the whole thing since D87: `POST /v1/restaurant/takeaway`
asks for `TAKEAWAY_CREATE`, the status change asks for the same, payment asks for
`PAYMENT_COLLECT`, and the till holds all three. The counter workspace computes
`[TAKEAWAY, THIRD_PARTY]` for exactly that permission set and renders the chooser.
The audit log shows the cashier had already placed and settled orders. What the
cashier did not have was any way to *find* the screen: the food-service `/pos`
rail entry hung on `SALE_CREATE` — a **retail** permission the restaurant till
deliberately does not hold (D87) — and so did the Ctrl+K command. The two doors
left were a dashboard tile labelled "Takeaway ready" and a "New sale" button on
the Sales page. Neither says "place an order here."

**`SALE_CREATE` was the wrong lever, and granting it would have been the wrong
fix.** The WAITER template says so out loud: it carries `SALE_CREATE` with a
comment explaining the grant exists *because the POS and Tables rail entries are
gated on it*. A retail-sale permission had become a proxy for "may use the
restaurant floor screens", and the proxy had started lying. Granting it to the
till would have made the sidebar right by making the permission model wronger,
needed a reseed to reach the existing row, and handed the till a standing
retail-sale, discount-approval and receipt-issuing grant that goes live the day
someone enables `RETAIL_POS` or gates a food-service route on it.

So the gate moved instead. `NavItemSpec.permission` now accepts an **array,
meaning any-of**, and `/pos` lists the capabilities the screen actually offers —
`ORDER_SEND_TO_KITCHEN` (Dine In), `TAKEAWAY_CREATE` (Takeaway, and Delivery with
`PAYMENT_COLLECT`), and `SALE_CREATE` kept so nobody who reaches POS today loses
it. The entry now appears exactly when there is something behind the door. No
permission was granted, no seed is required, no migration, no API change.

Widening the existing field rather than adding a sibling `anyPermission` is
deliberate: `bindGroups` copies spec fields by an explicit whitelist, so a new
field somebody forgets to copy yields an item with **no gate at all**. Widening
the existing one makes every consumer a compile error instead.

**The dangerous direction is fail-open.** An any-of gate written as all-of-nothing
puts Settings and QuickBooks in front of every role in the product, so an empty
gate array REFUSES rather than passes, and the tripwire that proves it calls the
real exported `holdsAnyOf` — the first draft of that proof compared two local
expressions and passed happily while the function under test fell open. No nav
spec carries an empty gate today, which is exactly why the branch had to be
reachable from a test at all.

**A deep link may now open a mode you cannot work.** Making POS visible to the
till turns `/pos?mode=dine-in` into an ordinary link to receive from a colleague,
and unclamped it opens a cashier into a dine-in workspace whose Confirm & send
the server refuses — a 403 three taps in, after they have composed an order. The
mode logic moved out of the component into `apps/web/src/lib/pos/pos-modes.ts`
as a pure resolver (D28/D31), where the clamp is one line and testable without
rendering a workspace. It was untestable in place, which is why the hole was
invisible.

**Deliberately not done.** `/tables` carries the identical `SALE_CREATE` gate and
the identical problem — the till settles tables it cannot see in its rail — but
the complaint was about takeaway and delivery, and widening a second destination
is a decision somebody should make on purpose. There is a negative assertion
holding that line so it cannot drift in unnoticed. The hotel RECEPTIONIST holds
none of the three and still gets no POS; the retail `/pos` entry is untouched and
still requires exactly `SALE_CREATE` (D16). The palette keeps its retail wording
"Start new sale", which reads oddly in a restaurant — noted here rather than
fixed by editing a string the Tile Shop depends on.

**What the review changed.** An adversarial pass over this change confirmed no
findings, but three of its refutations conceded something worth acting on, and
all three were the same species of defect this decision is about — an assertion
that looks like a guarantee and is not one.

* `resolveInitialPosMode` opened with "the mode a `?mode=` deep link may open",
  which reads as route-wide. It is not: `/pos?mode=third-party` carrying an
  `externalOrderId` returns the third-party **inspector** earlier in
  `pos/page.tsx`, before the counter workspace exists. That screen is a
  different feature gated server-side on `PLATFORM_PROFILE_READ` /
  `PLATFORM_PROFILE_MANAGE`, so routing it through this resolver would apply
  the wrong gate and would hide from a waiter an inspector they are authorised
  to read. The docstring now says what it guards.
* The palette had a **second, hand-copied** `holdsAnyOf` and a hand-typed copy
  of the three permissions. That is the shape D56 already caught once (seven
  inline copies of a businessType predicate, each drifted). It now imports the
  real helper and derives the gate from the nav specs as the union of both
  domains' `/pos` entries — fail-closed if the specs ever fail to load.
* Two of the mutation proofs in `nav.test.ts` compared **local expressions**.
  `Boolean(gate)` against a literal array is a compile-time constant: it could
  never fail whatever the shipped gate did. They assert against the exported
  `holdsAnyOf` now.

The palette gate had no test at all — the whole web suite was green with it
fully fail-open. It has one, and the first draft of THAT re-derived the gate
instead of importing it, so mutating the component left every assertion green;
the second draft asserted the constant but not that the command uses it, so
hardcoding the old permission back onto the entry also passed. Both were found
by running the mutation rather than by reading the test, which is the whole
argument for D30's rule that tripwires are mutation-proven and not merely
written.

**Still open:** whether the WAITER's `SALE_CREATE` grant is now vestigial. Its own
comment says it exists only for the rail gate this decision removes, and closing
a table needs `TABLE_CLOSE`, not `SALE_CREATE`. Removing it is a separate
security decision and needs a reseed.


### D94 — the till watches the board

PO, 2026-08-25: "Show the kitchen tab to the cashier as well."

`KOT_VIEW`, granted to `RESTAURANT_CASHIER`, and nothing else. The board's
"Mark done" control is gated on `KITCHEN_STATUS_UPDATE`
(`kitchen-board.tsx:51`), which the till does not hold, so this is a read-only
view of what the kitchen is doing — a cashier fielding "is table six's food
ready?" can answer it. Marking a ticket done stays with the people who cooked
it (D68), and the server refuses the update regardless of what the screen
shows.

Note this is a **grant**, not a gate change, and deliberately so. D93 moved the
POS rail entry off a borrowed permission because the till already held the
capability the screen offers; here the till held *no* kitchen capability at
all, so widening the `/kitchen` gate to some permission it happens to have
would have been exactly the `SALE_CREATE` proxy mistake D93 was written
against. The honest change is the one that says what it means: the cashier may
read the board.

It reaches existing users through `pnpm db:seed`.

**Proving a read-only board is harder than it looks.** "The till has no Mark
done button" is also what an empty board, a failed request and a broken
selector each produce — the first probe returned zero for kitchen staff too,
which would have shipped as evidence of nothing. `WS-408` asserts the contrast
on the same board: the till sees N Details buttons and zero Mark done, kitchen
staff see N Details and N Mark done. Mutation-proven — granting the till
`KITCHEN_STATUS_UPDATE` fails both the unit test and the e2e.


### D95 — the workspace page stops listing what a workspace does not have

PO, 2026-08-25: drop the "Not included" block from the workspace configuration
page, "across all of the templates", and remove the paragraph telling the reader
to contact support to change what a workspace includes — "since it's not
possible to change what a workspace includes."

Both are gone, for every business template **including the Tile Shop's**. That
half needs saying out loud because D16 protects retail wording: this is not a
restaurant change that leaked, it is the PO's instruction applied where they
said to apply it. The original block was defended on the grounds that "what am
I not getting" is the question an operator arrives with — but the answer was a
list of things nobody can act on, printed under an instruction that could not be
carried out. An inventory of the absent is only useful next to a way to acquire
it.

The support paragraph made a weaker claim than the PO's reason, which is worth
recording: it said the change was not *self-service*, implying support could do
it. The code comment above it is more honest — `QUICKBOOKS → LOCAL` has no
migration in either direction, so it is not that the change is gated, it is that
it does not exist. Nothing replaces the paragraph: a screen that says nothing
about an impossible action is better than one that hints at it.

**And the hyperlink became a tab.** "Workspace configuration" was a small link
in the Settings header, which is where things go to be missed. It is a tab now,
beside the others. The body moved to `components/settings/workspace-tab.tsx` and
`/settings/business` survives as a thin shell around the same component — it is
bookmarkable, it was the only inbound link until this change, and it still
renders when `GET /v1/settings` fails, which the tab cannot: the settings page
returns its error card before the tab strip exists.

The tests for the removed block were rewritten rather than deleted. The
exact-set assertion that used to span "Included" and "Not included" now pins
"Included" against the profile's own module list, which is a stronger claim than
the two `toContain`s it protects — deleting it was the tempting move and would
have left the positives with nothing behind them.

### D96 — Settings shows the document this workspace actually prints

PO, 2026-08-25: the Layout and Preview tabs should show "the details related to
the bill that will be printed, not quotations like in hardware pos", and the
signature, stamp "and the other branding details that are relevant to quotations
and invoices are not needed under the branding tab of restaurant POS either."

A restaurant owner opening Preview was shown a **quotation for Portland Cement
50kg, billed to Perera Constructions (Pvt) Ltd** — the server's sample catalogue
is a hardware one. Layout offered them margins, A4 paper size, an SKU column and
a signature area, not one of which can reach a thermal bill: `thermal-bill.ts`
reads exactly seven profile fields, its three columns are hard-coded, and a
continuous roll has no page to lay out. Those controls were not merely
irrelevant, they were settings that changed nothing.

**One resolver, not nine conditionals.** `resolveDocumentSettingsPresentation`
takes the tenant's capabilities and returns view flags; the tabs read flags and
decide nothing. This is the `product-presentation.ts` shape applied to a second
screen, for the same reason — the question reaches nine places, and the one
that is forgotten offers a restaurant a signature upload it can never use. A
contract test asserts the capability is named in exactly one file across the
whole web app, as an exact set rather than a count.

It routes on `capabilities.documents.proformaBill`, not on the business type.
That names the DOCUMENT rather than the service model, so a takeaway-only bakery
keeps its bill without seating anyone, and HOTEL — the value the seven
hand-written predicates D56 replaced had all independently forgotten — inherits
the right answer through the food-service capability set. The resolver takes
`TenantCapabilities | null` rather than a business type for a second reason too:
`domain-single-authority.test.ts` pins the exact set of files allowed to contain
`businessType === null`, and a resolver copying that idiom would have failed a
spec in a file nobody would think to open.

**The preview is the real bill.** Rendered client-side from `renderThermalBill`
— the same function the till prints from, fed the tab's UNSAVED settings, so an
operator sees the effect of a change before keeping it. A fifth server-side
preview type would have meant a second copy of a template whose printer
measurements were got wrong twice (D79, D80), and the API's preview spec
iterates a hard-coded list of four document types, so the new one would have
been silently uncovered — a textbook D30 vacuity.

**Layout gets a read-only summary.** After auditing every field the bill reads,
there is nothing on that tab a restaurant can configure. So it answers the
question an operator actually has — what comes out of the printer, and which tab
edits each line — instead of offering controls that do nothing.

**The consequence the PO may not have intended, and what was done about it.**
Hiding the branding controls does not stop a restaurant printing the document
that uses them: `/sales/[id]` offered "Print A4 bill" unconditionally, and
driven as the restaurant owner it produced a full A4 **INVOICE** with the SKU
column and an "Authorized signature / Checked by / Approved by / Customer
signature" block. Removing the controls while leaving the document would hand a
restaurant a signature block they can no longer populate or switch off, so the
A4 button is hidden for a food-service workspace by the same flag. The thermal
receipt button stays — that is their document. Usability only:
`/print/sales/[saleId]` is ungated and a typed URL still renders it, and the
server is unchanged.

**A defect this uncovered.** `Charges` (D84) and `Hours` (D90) were appended to
the tab list unconditionally, so a Tile Shop owner has been shown two tabs that
answer "Feature not available" — verified live before the fix. They edit
`RestaurantBranchConfig`, a row a retail tenant has none of. The same resolver
now decides, which is how they should have shipped.

Unresolved is its own state throughout: while the profile is loading every flag
is false and the Preview tab says it is checking, rather than flashing quotation
chrome at a restaurant and correcting itself.

**Known limit.** Hiding the signature and stamp rows also hides their Remove
buttons, and a save re-sends the whole document profile — so a food-service
tenant that had already uploaded a stamp keeps it stored, invisible and unused.
For the pilot tenant both are null. Clearing one would need Reset to defaults,
which discards the whole document profile; a targeted clear is not worth a
migration for an asset nothing prints.


### D97 — saving one setting must not decide another

PO, 2026-08-25: "I get error when trying to order takeaway from cashier console
saying 'takeaway is disabled on this branch'."

Nobody had disabled takeaway. **Setting the service charge did.**

`RestaurantBranchConfig` is created the first time anyone saves any branch
setting, and the Charges tab (D84) sends only charge fields. The create path
filled `takeawayEnabled` with `false`, and `TakeawayService.create` refuses when
a row exists and says false — so the row that D84 created to hold a 10% service
charge switched takeaway off, and every takeaway order after it failed. The
column defaulted to `false` in the schema too, so omitting it would not have
helped.

Reproduced exactly, from an empty table: `PUT …/config` with charge fields only
→ `takeawayEnabled: false` in the response nobody reads → `POST …/takeaway` →
`400 Takeaway is disabled on this branch`.

`dineInEnabled` was already `?? true` in the same object, two lines away. That
asymmetry is why dine-in never broke the same way and why nothing caught this.

**The deeper fault, which is the one worth fixing.** The enforcement refuses
only when a row EXISTS and says false, so a branch with no row has always taken
takeaway orders — while `get()` reported `takeawayEnabled: false` for that same
branch. The API described a restriction the server does not apply. Any screen
built on that answer would have disabled a working button. Both now say the same
thing: takeaway is on unless somebody turns it off.

So three changes, not one: the create path defaults to `true`, `CODE_DEFAULTS`
reports `true`, and the column defaults to `true` so no future writer can spring
the same trap. `20260906000000_takeaway_enabled_by_default` also flips existing
`false` rows — every one of them was written by this defect, because no UI
anywhere turns takeaway off and the only caller that ever sent the field
explicitly is a test. The flag still works: an explicit
`takeawayEnabled: false` is honoured, and there is a test holding that line so
the fix cannot quietly become a hard-coded `true`.

Mutation-proven three ways: restoring `?? false` fails the regression test,
hard-coding `true` fails the explicit-refusal test, and reverting `CODE_DEFAULTS`
fails the agreement test.

**Not done:** the Charges tab still has no toggle for either channel, so
`takeawayEnabled` is settable only through the API. That is now harmless rather
than dangerous — the default is the working state — but a branch that genuinely
wants takeaway off has no screen for it. Worth adding beside the charges when
somebody needs it.


### D98 — the counter receipt prints itself

PO, 2026-08-25: once a takeaway order is placed by the cashier, the ticket goes
to the kitchen and "receipt must be immediately printed without showing the
print window to the user".

**The kitchen half already worked.** `TakeawayService.create` calls
`generateTicketsForRound` inside the same transaction that writes the order, so
a ticket exists before the response returns. Confirmed rather than assumed:
the order placed while verifying this has a `QUEUED` ticket at the Grill
station.

**The receipt half did not exist at all.** The completion screen showed a
"Receipt ready" indicator, which was an indicator and nothing more — no receipt
was ever produced. It prints now, automatically, the moment payment succeeds.

It prints from the SALE, not from the cart. The server decides the totals — the
service charge, the tax and any rounding are applied when the sale is created —
and paper that disagrees with the money actually taken is worse than no paper.
So the flow fetches the bill it just created and renders that.

**Printing must not be able to fail the order.** By the time the receipt is
attempted, the food is on its way to the kitchen and the money is collected. A
printer out of paper is a reprint, not a rollback, so the failure is caught and
reported on the completion screen — "Receipt not printed — reprint from
Orders" — rather than thrown. The screen tells the truth either way instead of
claiming a receipt that never came out.

**No window, and one print.** Verified by counting: placing a real order from
the cashier's console produced exactly **one** `print()` call and **zero**
popup windows, with no click of any kind. The hidden-iframe path (D78) is what
makes that true.

**The print dialog itself is not ours to remove**, and D74 already recorded
why: only Chrome's `--kiosk-printing` launch flag sends `window.print()`
straight to the default printer, and a page cannot set it. On a till started
with that flag this is now the entire interaction — order placed, ticket in the
kitchen, receipt out of the printer, nothing clicked. Without it Chrome shows
its preview, which is a property of the browser rather than of this code.

**One map, not three.** The `BillView` → printable-HTML mapping existed twice,
byte-for-byte identical, in `bill-screen.tsx` and `bill-dialog.tsx`, and this
needed a third caller. It lives in `lib/restaurant/bill-print.ts` now and all
three use it. Both former copies did the fetch, the map and the print in one
function, so the part most worth testing — that every money row reaches the
paper — had no test in either. It has one now, asserting the whole object at
once: a field DROPPED from the map is the failure that matters, and a
field-by-field test only catches the fields somebody thought to list.
Mutation-proven by deleting the service charge and the packaging charge from
the map.

### D99 — the roll is measured, not assumed

Report, 2026-09-01: the bill prints correctly from Google Chrome and prints
with its **left edge cut off** from Microsoft Edge. Same till, same roll, same
Xprinter XP-365B.

**The mechanism.** `@page { size }` is a request about a page BOX. It says
nothing about where that box is PLACED on the paper, and the two Chromium
browsers do not place it the same way: Chrome laid the 78 mm box down at the
printable origin at 100%, and Edge re-fits and centres it against the driver's
78.7 mm stock, which splits the overflow between both edges. A layout whose
only slack is on the right survives one placement policy and not the other.

This is the mirror image of a failure already in this file. D79 recorded
*"72 mm left a band of white down both sides, because the shorter page was
centred on 78.7 mm of paper"*. The centring never went away; D80 simply stopped
noticing it, because at 78 mm there was nothing left over to centre — in
Chrome.

**The defect was not the value of the inset.** It was that all the slack was on
one side, and that the number lived in source, where nobody can measure it.
D73 through D80 is seven rounds of setting these numbers from a laptop and
posting the result to be photographed. An eighth constant is the same bet with
a different number.

#### What this supersedes in D80

1. *"Right only. The left edge has always printed cleanly from x=0"* — false
   in Edge. The text is inset on **both** sides now, by two independent
   numbers.
2. *"insetting both sides is the white the PO rejected"* — it is not. That
   white came from a PAGE narrower than the stock, centred on it. A page equal
   to the stock, with padding inside it, produces no white to centre. The two
   were conflated.
3. *"The inset is a single named constant which the stylesheet interpolates"* —
   replaced. The correct values are a property of a printer, a driver and a
   browser together, and are not knowable from source. They are per-workspace
   settings, defaulting to the XP-365B's 78 / 3 / 5.
4. The blanket ban on `max-width` — replaced by a narrower rule, below.

#### What D79 and D80 keep, restated

The two numbers are still different things and must not be conflated again.
The **page** matches the driver's stock, so nothing is ever centred and no
width is lost before the content starts — that is why the page width is still
what goes into `@page { size }`, never the content width. The **text** is inset
from where the head stops. Insets are in millimetres, never pixels: a pixel
inset stops being a fixed physical margin the moment a browser applies a scale
factor, which is the family this whole defect belongs to.

Also unchanged: no popup, printed from a hidden iframe, and `window.open`
asserted never to be called. `@page { margin: 0 }`, for the browser chrome and
for the gap between pages. No `break-inside: avoid`. Headings printed once. No
page size for retail receipts (D16). And the right inset stays the LARGER of
the two, because its clip is a measured property of the print head where the
left's is browser drift.

#### `max-width` on the body, and the one value it may take

The body is now capped at exactly the page width. When `@page { size }` is
honoured the cap does nothing. When a browser refuses the size and lays the
document out on A4 or Letter instead, it stops a monospace bill designed for
78 mm from spreading across 210 mm and landing past the last printable dot —
which is a total loss, not a clipped character.

It is safe at that value and at no other. `max-width` narrower than the page,
plus centring, IS the D79 band of white. So the margin stays `0` and never
`0 auto`, and both halves are asserted negatively.

#### The document carries its own geometry

`printReceipt` is handed an HTML string. The stylesheet inside it decides how
wide the text prints; the frame it is written into decides how wide it lays
out, and the page height written into `@page` is measured from that layout.
Two numbers, produced in two files, that must agree — and for seven rounds
they were kept agreeing by hand.

The numbers now travel in the document as `<meta>` and the frame reads them
back. There is no parameter for a call site to get wrong and no second
constant to fall behind. It is metadata ABOUT the document, not a page-size
declaration: the template still declares no `@page { size }` of its own, and
D77's third position on that is untouched. The two claims are asserted as a
pair so the distinction cannot erode into one.

**A correction worth writing down, because the obvious fix is wrong.** The
frame lays out at the PAGE width, not the content width. The body is
`border-box` at `width: 100%`, so a frame 295 px wide already gives a content
column of 295 px − 6 mm = 272 px — exactly what a 78 mm page with the same
padding prints. Narrowing the frame to the content width would subtract the
insets a second time, wrap more lines, and over-measure the page height. It
would look like a correction and be a regression, and it is invisible on a
78 mm roll.

#### Calibration is an operator action

Settings → Documents → Preview now carries **Paper width**, **Left inset**,
**Right inset**, a fit-to-content switch, and a **Print calibration strip**
button. The strip prints, in one page:

- a solid bar pulled out to the page's own edges by negative margins equal to
  the insets — the only element that is not inset, and the one that separates
  "the page is wider than the stock" from "the insets are too small". Without
  it those two faults look identical on paper, which is how D79 spent a round
  narrowing the page when the inset was the problem;
- a millimetre ruler across the text column, so the first and last legible
  numerals give both insets directly;
- edge markers, and the widest line a bill can print (`LKR 1,450,000.00` in the
  AMOUNT column) — the exact string D80 watched come out as `LKR 1,450.`;
- the three numbers in force, and **the browser that printed it**. That last
  one is not decoration: Chrome and Edge disagreeing is the entire defect, and
  two strips on a counter are otherwise indistinguishable. An unrecognised
  browser prints an em dash, never a guess (D54) — a strip labelled with the
  wrong browser would have the operator calibrate the wrong one and stop.

The strip's body rule is byte-identical to the bill's, from the same shared
function, and that identity is asserted. An instrument laid out differently
from the document it measures is worse than no instrument.

#### No migration

The four fields land in `TenantSettings.data`, which is `Json`. The service
merges its defaults UNDER a stored blob, and the web client's cache read
spreads `DEFAULT_DOCUMENT_PROFILE` under the cached value, so an existing
tenant and a till holding a stale `localStorage` profile both pick the geometry
up on the next read with no backfill. Asserted, rather than assumed.

#### D16 and D30

One existing behavioural assertion changed: `thermal-bill.test.ts`'s "fills the
roll, held off the RIGHT edge only", which is the claim this record reverses.
It changed because of this decision, not to accommodate a refactor.
`receipt-print.iframe.test.ts` — including `width:295px` and
`@page{size:78mm 267mm;margin:0}` — and `bill-print.test.ts` survive
**unedited**, which is the evidence that the default path is unchanged.

Mutation-proven tripwires added:

- `receipt-print.geometry.test.ts` — that the frame width, the stylesheet and
  the injected page all come from the document's own geometry. The fixture is
  58 / 2 / 4, sharing no digit with the defaults, and the proof is written
  inline: `mmToPx(78) === 295 && mmToPx(78) !== mmToPx(58)`, so a printer that
  re-hard-coded the old constant could not produce the asserted numbers. The
  companion case feeds a document with no geometry and asserts the unchanged
  fallback, so the pair cannot pass by always trusting or always ignoring.
- `thermal-bill-geometry.test.ts` — that `readBillGeometry` reads the document
  rather than answering from the defaults, proven with the same fixture.
- `document-presentation.test.ts` — `showBillCalibration` across all three
  surfaces, in that file's existing style.

Two other things the tests found while being written, both now fixed: a
half-written meta set was accepted because `Number(null)` is `0` and `0` is
finite, which would have silently reported insets of zero — the very layout
this record removes; and a second fallback for the page width was dead code,
unreachable given the bounds, so it was replaced by an assertion that the
bounds keep it unnecessary.

**Verified how:** the strip printed from both browsers on the till, and the
numbers it produced recorded here.


### D100 — the board reads like a kitchen screen, and a bump can be taken back

PO, 2026-09-03: the board's content was right and its ergonomics were not —
compared against mainstream KDS products, it read like an office web page.
Four changes, one record, because they are one statement: the kitchen board
is furniture in a kitchen, not a page in a browser.

**Age escalation.** The big timer sits where the status badge sat — on the
outstanding tab every badge read "To make", which the tab already says — and
the ticket turns amber at 10 minutes and red at 15 (timer colour + card
border). The thresholds are constants, not settings: they follow the
mainstream KDS defaults, and nobody has asked to tune them. The 5 s poll
doubles as the timer tick. Completed tickets stop ageing; a done dish is no
longer waiting.

**The bump is the whole bottom of the card.** `Mark done` was a
footer-sized button beside Details; the finger pressing it is wet, gloved,
or holding a plate. It is now full-width and 48px tall. Recall (below) gets
the same target but an outline variant — it is the undo, not the job.

**Type at arm's length.** Place `text-xl`, items `text-base`, everything
else one step up from where it was. The board is read from across a pass,
not from a desk.

**Recall.** `POST …/kitchen-tickets/:ticketId/reopen`, gated on
`KITCHEN_STATUS_UPDATE` exactly like complete: whoever may say the food is
done may say it is not. D68's write surface grows its second verb — the
undo every mainstream KDS carries, because optimistic finger-sized bumps
are sometimes wrong. Reopening rewrites the ticket to `QUEUED` and CLEARS
`completedAt`/`completedByUserId` — a recalled ticket is work to do again,
and a stale "done by" name would say otherwise. Idempotent in mirror image
of complete: recalling a never-completed ticket writes nothing. Audited as
`KITCHEN_TICKET_REOPENED`. No migration: `QUEUED` already exists.

D94 is untouched: the till still holds `KOT_VIEW` alone, so it sees neither
verb, and WS-408's contrast still holds — its selectors (`Mark done`,
`Details` by accessible name) survived the relayout unchanged.
`kitchen-board.render.test.tsx` pins the new behaviour in pairs: escalation
(a late board turns red AND a fresh board carries no warning colour),
the write gate (no verbs without the permission, Details as the positive
control), and both verbs' optimistic card drop against api mocks that empty
their rows — a reload must not resurrect a bumped card.

---

### D101 — Sold out is a switch, not a count

PO, 2026-09-03: the restaurant catalogue behaved like a hardware store's.
Every item a restaurant authors carried stock fields, and the number in them
was one nothing maintains — a curry's `quantityOnHand` neither depletes nor
means anything, yet it rendered as though it did. The mainstream shape
(Toast, Square) splits availability by what the item IS:

**Prepared items don't count units — they get an 86 switch.** New nullable
`Product.soldOutAt` (null = available). `PUT /v1/products/:id/availability`
sets or clears it, gated on the new `PRODUCT_AVAILABILITY_SET` permission —
held by OWNER/ADMIN/MANAGER and, deliberately, by the food-service Waiter
and Cashier templates: 86ing the last kottu is a till/floor action in the
middle of service, not an owner's console visit. The endpoint REFUSES kinds
whose availability is governed elsewhere (`STOCK_ITEM`/`BUNDLE` by the
count; `TIME_SLOT`/`STAY_UNIT` by booking calendars) with
`PRODUCT_AVAILABILITY_STOCK_GOVERNED` — one authority per fact. The flag is
product-level, not per-branch, because LOCAL inventory already refuses
multi-branch tenants; when multi-branch food service arrives, this moves to
a branch satellite with its own decision record.

**Bought-in sellables keep real counts.** The D65 authoring rule
(`foodType != null → COMPOSED_ITEM`) made a tracked bottled water
impossible: the restaurant wizard stamps every item with a foodType, so a
packaged drink classified as a dish, reported UNTRACKED, and depleted
nothing. The rule gains the operator's own answer: the wizard's Track-stock
switch (restaurant default OFF — dishes are the common case) now travels as
`trackStock`, and `foodType != null` derives `STOCK_ITEM` when it is true,
`COMPOSED_ITEM` otherwise. Update re-derives only when one of the rule's
inputs (`type`, `foodType`, `trackStock`) is in the patch, so existing rows
keep their classification until someone actually edits the decision.

**The server refuses a sold-out sale.** `resolveRoundItemInputs` — the ONE
resolver both intake paths share (dine-in rounds and takeaway, which the
counter routes every mode through) — now throws `PRODUCT_SOLD_OUT` for a
sold-out product, next to the existing inactive check. POS greying is
usability; the refusal is the rule (D31's stance). Out-of-stock STOCK_ITEMs
are deliberately NOT blocked — oversell stays permitted, unchanged.

**Presentation is per-item, resolved in one place.** The sellable read
model reports `stockState: 'SOLD_OUT'` (a new state beside UNTRACKED — a
sold-out dish must not read as OUT, which stock governs). The web resolver
gains `resolveItemStockPresentation(presentation, sellableKind)`:
EXTERNAL_CATALOGUE shows counts for every kind (Tile Shop pixels untouched,
D16); LOCAL splits QUANTITY (STOCK_ITEM/BUNDLE) from AVAILABILITY
(COMPOSED_ITEM/SERVICE) from NONE (booking kinds); no component compares a
kind inline. At the POS, sold-out cards grey out and stop adding; a
long-press (the Square gesture) opens the availability dialog for untracked
items when the operator holds the permission.

---

### D102 — a page is never wider than it is tall

Report, 2026-09-01, on the D99 delivery: with the bill printing correctly, one
case was found where it comes out **rotated 90° on the roll** — the words run
along the paper instead of across it. To reproduce: clear every document field
(business name, address, phone, email, tax number, footer, bill note) **and**
the logo, then print a bill with **one** item.

**The mechanism.** `@page { size: W H }` has no separate orientation property.
The two lengths *are* the orientation: a page box whose width exceeds its
height **is** a landscape page, and the print pipeline rotates it to suit.

`fitPageToContent` measured the content and declared `size: <paperWidth>mm
<measuredHeight>mm`. Nothing bounded that height. Its only guard was
`heightPx <= 0`, and the geometry module's three `min` constants — the page
width's floor, the inset floor, `minContentMm` — are every one of them about
the horizontal axis. Strip the header and the bill falls under the paper's own
width, and the page turns over.

Measured in Chromium at the real 295 px layout width, not estimated:

| document | content | declared page | |
|---|---|---|---|
| normal bill, logo and header | ~520 px | 78 × 140 mm | portrait |
| **stripped bill, one item** | **213 px (56.4 mm)** | **78 × 59 mm** | **landscape** |
| **calibration strip** | **275 px (72.8 mm)** | **78 × 75 mm** | **landscape** |

**The instrument had the defect it was built to find.** That 78 × 75 mm is not
a calculation — it is what the D99 calibration strip was observed injecting on
the live stack the day it shipped. The strip prints through the identical path,
so the tool for diagnosing the last print bug was quietly carrying the next one.

**The rule.** The declared height is now floored at the paper width plus the
cutter margin — 80 mm on a 78 mm roll, 60 mm on a 58 mm one. It tracks whatever
roll the workspace calibrated rather than being another hard-coded 78, and it is
strictly greater than the width, never equal: a square page is the ambiguous
case and there is no reason to hand a driver one.

The floor earns its place twice. Orientation is the first reason. The second is
that a cut needs somewhere to land — the `+2 mm` cutter margin was already
admitting as much for the bottom of a long bill, and a 50 mm page gives the
mechanism less paper than the head-to-cutter distance on most 80 mm printers.

The arithmetic moved out of `fitPageToContent` and into `pageHeightMm` in
`thermal-bill-geometry.ts`, beside the rest of the geometry, with
`CUTTER_MARGIN_MM` following it. The number that decides which way up the bill
comes out should not be computed in the middle of DOM code, and it is now
testable without a browser.

**Cost, stated plainly.** A very short receipt gets up to about 30 mm of blank
paper before the cut. That is the trade, it is bounded, and it disappears the
moment a bill has a letterhead or a second line.

**What D77 keeps, untouched.** The fitting is still opt-in and still measured;
the template still declares no `@page { size }` of its own. Every height failure
D77 records is a height too **large** — 432 mm and then 223 mm, scaled down by a
driver that could not honour them — and it drew the right conclusion from them.
This is the opposite end of the same axis, which nothing in D73–D99 had cause to
consider. D79's Xprinter dialog is the same story: it states a *Maximum* Length
and no minimum at all.

**An empty header no longer prints a blank line.** Every row in the header block
is conditional, but the block itself was not, so a workspace with the logo and
all four fields cleared got an empty `div` holding the template's own newlines.
Whitespace in a block still generates a line box, and nothing in that stylesheet
sets a `font-size` on `body`, so it inherited the browser's 16 px and printed as
a blank line at the top of the paper. It is emitted only when it has content
now. Adjacent to the reported bug rather than part of it, and recorded so.

**Why the suite did not catch this, which is the D30 lesson here.** Every
`@page` assertion in the repository is driven by a fixture whose body reports
**1000 px** → 267 mm, comfortably portrait. The entire regime below the page
width had no coverage — not a weak test, no test. A tripwire cannot fail in a
region no fixture visits, and "all the assertions pass" said nothing about it.

Tripwires added, and mutation-proven inline:

- `thermal-bill-geometry.test.ts` — the rule as a **property**, swept across
  1…2000 px, requiring `pageHeightMm(g, px) > g.pageWidthMm` for every one,
  rather than sampling a few heights. Plus the floor tracking a 58 mm and a
  110 mm roll, asserted negatively against the 78 mm roll's 80 mm so a
  hard-coded default cannot pass. The mutation proof states the pre-D102
  arithmetic explicitly — `ceil(pxToMm(213)) + 2 === 59`, and `59 < 78` — because
  `pageHeightMm(g, 213) === 80` proves nothing unless 213 px is shown to sit in
  the landscape regime.
- `receipt-print.geometry.test.ts` — the same claim through the real
  `printReceipt`, since the pure function could be correct and simply not
  called. Exact injected set, with the old sideways output named as the
  negative.
- `thermal-bill.test.ts` — the header block absent when empty, present the
  moment one field is filled, so it cannot pass by deleting every letterhead.

**D16.** No existing assertion changed. Every `@page` spec uses the 1000 px
fixture, which is above the floor, so all of them still pass untouched — which
is itself the evidence that the normal printing path is unaffected.

**Verified:** the heights above were measured in a real browser rather than
computed; the reported case reprinted upright on the till.

---

### D103 — the rail entry is called "Menu", because that is what it is

PO, 2026-09-04: after D101 landed, "I can still see the inventory tab."
Correct on both counts it could mean, and both are fixed under this record.

**The label.** D45 made `/products` the single authoring surface and, when
it removed the legacy `/menu` nav entry, labelled the food-service rail
entry "Inventory" so it would read as that surface. It never did: every
mainstream restaurant POS calls this surface the **Menu** (Toast,
Lightspeed; Square says Items), and after D101 the word "Inventory" is
actively wrong — most of what a restaurant authors there deliberately has
NO inventory. The entry is now labelled **Menu** with a book icon
(`BookOpen` joins the icon vocabulary). Nothing else moved: the href is
still `/products`, retail still says "Products", and the D45 rule that the
legacy `/menu` ROUTE gets no nav entry stands — `nav.test.ts` now pins
that claim by href, which is the invariant, rather than by the absence of
a label that legitimately exists again.

**The detail page.** A dish's detail page still offered Inventory and
Purchases tabs — per-branch counts and GRNs behind two clicks, for an item
whose D101 stock cell says a count means nothing. Both tabs now render
only for items whose stock presentation is QUANTITY, the same resolver
answer that gates the Receive Stock button. Overview and History remain
for every kind; availability lives on the Overview, where D101 put it.

Paired per D30: the nav spec asserts the Menu label present AND resolving
to `/products`, `/menu` absent from every workspace's hrefs, and retail
free of the label; the detail spec asserts a dish hides the two tabs while
a stock item keeps them.

### D104 — one joined table, several tabs

PO, 2026-09-07, on the open tables shipped by D49/D50: "think I'm going with 3
friends, the waiter makes a table with join ex M1 and M2 all having 6 seats, we
want 4, then another two friends come — they also can book that new made group."

D50 already answers *two parties, shared furniture*, but with the multiplicity
the other way up: **N arrangements over 1 physical table**, each arrangement
carrying exactly one tab. The PO is describing **1 arrangement carrying N
tabs** — one named group the floor can keep selling seats on. Both shapes are
real and they are not substitutes: the first is two unrelated pairs who happened
to be sat at one four-top, the second is one joined table that is only half
full.

**The rule changes for `kind = OPEN` only.** `openSession`'s
one-live-session-per-table check becomes kind-aware: a PHYSICAL table still
refuses a second session — a four-top with a party at it is not something two
parties can both be sold — and an arrangement admits as many tabs as it has
chairs. The integration spec proves the relaxation is scoped by re-asserting the
physical refusal beside the arrangement's acceptance, and
`table-sessions.spec.ts`'s "the same table cannot have two open sessions"
survives untouched because its fixture is a physical table.

**Seats are counted, and the count is refused when it does not fit.** Live tabs
are `OPEN` or `BILLING` — a party waiting for the bill is still in its chairs
— and `guestCount` becomes required on an arrangement that HAS a recorded seat
count. Where the operator wrote "seating as arranged" and left it blank (D49's
optional `seats`), nothing is enforced: inventing a limit would refuse parties
on a number nobody stated. The one list of live statuses now lives in
`common/live-sessions.ts`, because "may another party sit here" and "may this
arrangement be dissolved" are the same question about the same rows and two
copies of the answer would drift.

**A tab carries its own name.** Two parties on one arrangement previously
produced byte-identical kitchen tickets and bill headers — the table's name was
the whole label. `TableSession.tabName` is composed onto the place label by one
helper used at all three read surfaces (kitchen board and ticket detail, bill,
unified order list). It is required from the **second** tab onwards, and only
then: naming a tab that has no sibling is typing for nothing, and a lone
arrangement already reads unambiguously.

**Release becomes last-*tab*-out.** This supersedes D49's "the arrangement ends
with the tab". `releaseOpenTable` now returns without touching memberships,
`isActive` or any member status while another live session remains on the open
table; only the last close dissolves the arrangement, after which D50's
member-level "still held by another open table" logic runs unchanged. The
ordering inside `closeSession` is load-bearing — it marks its own session
CLOSED *before* the fulfilment provider asks who is left, so a plain count
excludes the tab that is closing — and an integration test pins it. The release
summary gains `remainingTabs`, because "no member was freed" (a shared
four-top, normal) and "two parties are still sitting here" (nothing happened at
all) read identically without it.

**In the POS, arrangements live under Open.** D92's partition holds — every
table on the branch is in exactly one place — and an arrangement's place is
**Open**, whether or not a party is on it. Deliberately not filed by status like
a physical table: under this record an arrangement can be occupied AND still
have chairs, so status would make it flicker between destinations as parties
come and go, hiding the very table the next party is meant to join. A first pass
gave them a separate "Joined" chip; the PO wanted them under Open, which is also
the truer reading of D92. Tapping a group opens a small prompt for the guest
count and the tab name — physical tables keep their one-tap seat, because that
is the commonest action in service and a dialog on it would tax every cover to
serve the rarer case. Occupancy (`liveTabs`, `seatsTaken`) is computed by the
SERVER on `listOpenTables`: D70 scopes the open-session list to the caller's own
tabs, so a client adding up what it can see would miss a colleague's party and
offer seats that are not there.

**Not in scope.** Seat-level assignment (which chair): seats stay a count.
Moving or merging tabs. Reservations on arrangements — D49 still refuses
non-PHYSICAL tables. And note the claim "physical tables keep one tab" is about
`openSession`: takeaway and delivery already insert sessions directly on their
synthetic WALK-IN / DELIVERY tables and never pass through it, so nothing here
runs on those paths.

**Migration.** `20260908000000_add_table_session_tab_name`: one nullable TEXT
column. Purely additive — null on every existing row means "the table's name
stands alone", which is exactly what those rows already meant, since before this
record a table could not have a sibling tab to be distinguished from.

**Two assertions were superseded, not accommodated** (D16 forbids the latter):
`open-tables.service.spec.ts`'s "**always** archives the closing open table" —
"always" was load-bearing under D49 and is now conditional, replaced by the pair
(archives when last / leaves it standing when not) — and a POS render assertion
from the same day that a tap on an arrangement "still resumes rather than seating
a second session on it".

Paired per D30 throughout, and mutation-proven inline: the render spec's five
mutations fail 7/4/1/1/1 of its 7 tests (dropping the arrangement fetch kills
all seven, which is the shape of the original defect — total absence), and the
integration spec asserts every refusal beside the acceptance that proves the
server has not simply started saying no.

---

### D105 — a table already inside an open table is not offered to another one

PO, 2026-09-07, immediately after D104 landed: "in the main hall I joined M2
and M3, then after creating a join table [they still show] in that place" —
the **New open table** picker was still listing M2 and M3 while the arrangement
holding them, `minin`, was in service with three tabs and eight guests
physically at those two tables.

**This narrows D50 to `AVAILABLE` only.** D50 had widened member eligibility by
exactly one status, admitting `RESERVED` so two unrelated pairs could each hold
their own arrangement over one free four-top. That widening was sound while an
arrangement meant exactly ONE tab — "already shared" and "has a party at it"
were then mutually exclusive, which is what D50's own sentence *"a table with a
party physically at it is not shareable; a table already shared is"* relies on.

**D104 dissolved that distinction.** Occupancy is recorded on the arrangement,
never on its members: seating `minin` moves `minin` to OCCUPIED while M2 and M3
stay `RESERVED`. So after D104 a `RESERVED` row means "held by an arrangement,
which may or may not be full of people", and neither the service nor the picker
could tell the two apart from the row alone. The rule was not merely stale — it
was offering the floor tables that had guests sitting at them.

**Nothing is lost, because D104 replaced the mechanism.** D50's worked example
is now served better by a second **tab** on the existing arrangement than by a
second arrangement over the same furniture: one bill each, one named tab each,
and the physical tables released when the last of those tabs closes. Refusing
here is how the floor gets pushed onto that route rather than onto a duplicate
arrangement that no longer buys anything.

**What changes.** `DiningService.createOpenTable`'s eligibility becomes
`isActive && kind = PHYSICAL && status = AVAILABLE`. The picker's filter
narrows to match, its "shared" hint goes with the rule that produced it, and
its copy now names the replacement route instead of promising sharing. The
existing `MemberTableUnavailableError` is unchanged and its wording — *"it is
in service, archived, or already part of another open table"* — becomes true
for the first time.

**What deliberately does NOT change.** No migration and no schema change:
`OpenTableMember` stays many-to-many. Restoring
`@@unique([memberTableId])` would need a migration and would reject rows
already written under D50, and the service is the authority in any case — the
many-to-many shape simply stops being reachable through the create path. D50's
member-level last-one-out logic in `releaseOpenTable` stays as written, correct
and now practically unreachable, because it is what keeps rows created before
this record honest. `releaseMemberTable` (Unreserve) is untouched and remains
the escape hatch.

**One assertion was superseded, not accommodated** (D16 forbids the latter):
`open-tables.service.spec.ts`'s *"D50: a table already RESERVED by another open
table can be shared"*, which asserted the create RESOLVES. It is now its
opposite, and `RESERVED` joins the `it.each` refusal table beside SEATED /
OCCUPIED / BILLING / CLEANING / BLOCKED, which is the tidiest statement of the
new rule and leaves that test's message assertion untouched.

Paired per D30 in three places, and mutation-proven inline with measured
counts: the service spec asserts the refusal AND that nothing was written, and
restoring `|| RESERVED` to the predicate fails 2 of its 22 tests; the picker —
which had **no test at all** before this record — asserts a free table present
beside the joined ones absent, and the same restoration fails 2 of its 3; and
the integration spec refuses a member of an arrangement that is unseated AND
one that is in service, then proves the same tables become joinable again once
the last tab closes, which is what stops the pair passing against a server that
has simply started saying no.

---

### D106 — a joined table is shown, not offered

PO, 2026-09-07: "after the open table, like I join M1 and M3, then under the
Main Hall section it shows the table with the button Unreserve — I think don't
show, please. It shows Reserved status, can't click button. I think that is the
best."

It was more than a preference. Pressing that button is what broke the live
floor: `minin` was found serving **three tabs and eight guests while holding
zero tables** — M2 and M3 had been unreserved out from under the party sitting
on them.

**Why the guard never fired.** `releaseMemberTable` refused when the table had
its own live session:

    const ownSession = await tx.tableSession.findFirst({
      where: { tableId: table.id, status: IN_SERVICE_SESSION_STATUSES },
    });
    if (ownSession) throw new TableInServiceError();

A joined member never has a session of its own — the tab lives on the OPEN row —
so the check could not fire for exactly the case it appeared to cover. It read
like a safety rail and was one only for tables that were not joined.

**Why the permission is withdrawn rather than fixed in place.** D50 allowed this
deliberately, as the compaction escape hatch: two parties of three shared a
four-top and a two-top, the first is billed, and the remaining three now fit on
the four-top alone — only a human can see that. **D105 ended table sharing**, so
that scenario cannot arise: there is no second arrangement whose departure frees
furniture the first no longer needs. And **D104** made the failure expensive,
because an arrangement now carries several tabs and several parties.

**The card keeps its job, which was never the button.** A member table still
shows the `Reserved` badge and the "Held by …" line naming the arrangement —
that line is the whole answer to "where did my table go", and it is why the card
is worth reading. What it no longer has is anything to press. The badge wording
is unchanged on the PO's say-so, and it is shared with the dashboard and the POS
picker.

**Recovery was already correct and is now the only route.** Close the tabs — the
last one releases every member automatically (D104) — or **Dissolve** the
arrangement, which has always refused while a tab is live. An arrangement nobody
has sat at yet can still have a member released, which is the honest half of the
old behaviour and stays.

**Server, not just screen.** Frontend hiding is usability only, so the rule
moved into the service: `releaseMemberTable` now counts live tabs on the
**arrangements holding the member** and throws the existing
`OpenTableInServiceError`. The member's own-session check stays as well — a
table can be RESERVED and separately mid-service in states this method has no
business touching. No new error code, no new route, no migration; the endpoint
and its route-matrix entry are untouched.

Paired per D30 on both sides, and mutation-proven inline with measured counts:
the floor spec asserts the card's CONTENT and its EMPTY action slot as separate
tests, and restoring the button fails 1 of those 2; the service spec asserts the
refusal beside the still-working unseated release, and deleting the holder probe
fails 1 of its 23 tests and 2 of the 12 integration tests — which also assert
the membership row and the member's RESERVED status survive the refusal, and
that the member comes back by itself when the last tab closes.

---

### D107 — merging `main` into the restaurant branch: how each clash was decided

`feature/restaurant-pos-reshin` (131 commits since PR #8) was merged into
`merge/restaurant-changes`, a branch cut from `main`, which had moved on by 51
commits of its own: a `SALESPERSON` role, UTC storage with per-business
timezones, customer-level credit and receivables, per-unit fixed discounts,
numbered pagination, and QuickBooks fixes. Thirty files conflicted textually;
what follows is every decision that was more than "take both lines", so the
next person can see why the merged code reads as it does.

**Production's migrations are `main`'s, and none of them was touched.** The
one genuine migration clash: both branches created `Sale_tenantId_completedAt_idx`
— `main` in `20260901101500_index_sale_completed_at` (deployed) and this
branch inside `20260822000000_add_universal_settlement_document` (never
deployed). Two `CREATE INDEX` for one name fail whichever runs second, in
*either* order. The branch's migration gives the statement up; `main`'s is
byte-identical to what production has applied. Proven by replaying both
shapes on scratch databases: an empty one takes all 68 in order, and a
production-shaped one takes `main`'s 27 first, then the merged set — with a
credit-account payment (`saleId NULL`, `main`'s model) seeded in between and
still present afterwards, the index present exactly once, and zero drift
against the merged schema in both. The other narrowing this branch carries,
`PrintJob.saleId SET NOT NULL` (D68), touches a table `main` never changed.

**`SALESPERSON` joins the single role authority, owner-equivalent, exactly as
`main` defined it.** `main` added it as an enum role with `ALL_PERMISSIONS`,
no discount ceiling, and two copies of an `ADMIN_LEVEL_ROLES` /
`isAdminLevelRole` helper (API and web). This branch had already moved
`UserRole` into `packages/shared/authorization.ts` with a Prisma-enum parity
spec, so the role went there, the helper went there once, and both apps
re-export it. One real reconciliation: on `main`, "holds the full permission
set" and "is owner-level" were the same three roles. Here they are not —
ADMIN is owner-level for guard-rail overrides but Restaurant Pilot Change 1
withholds the six creator-scoped permissions from it — so `main`'s spec
asserting the two lists are equal now asserts them separately. The
consequence to notice: the salesperson holds `PLATFORM_PROFILE_MANAGE` and
every restaurant permission, and the parity spec that enumerated who may
change a workspace profile now names it. That is what owner-equivalent means;
it is recorded here because `main` never saw those permissions exist.

*Not done, deliberately, and flagged for a decision:* this branch has four
hard-coded `OWNER || ADMIN` checks `main` never touched — the branch-scope
bypass in `branch-scope.guard.ts`, the role-grant right in `users.service.ts`,
and two in `auth.repository.ts`. Main's own rule says `isAdminLevelRole` is
the only place that question should be answered, which would extend each of
them to the salesperson. They are security decisions on code `main` never had,
so they were left as they were rather than widened in a merge.

> **Resolved 2026-09-08 by [D108](#d108--the-salesperson-is-the-hardware-templates-role-with-a-row-of-its-own):**
> all of them now ask `isAdminLevelRole`, so the Salesperson is cross-branch
> and may hold branch access through the role, like the owner.

**The salesperson demo user exists; the manager and accountant do not come
back.** This branch retired both on 2026-08-17 and its seed actively deletes
them, so re-adding them would be undone on the same run. The e2e fixtures and
tests that depended on them (`accountantApi`, `managerApi`, PERM-008, and the
second user in MARK-016) were dropped or moved to the cashier; the four
salesperson tests `main` added were kept. No `SALESPERSON` role *template*
was added, so the seeded salesperson is unlinked and resolves through the
enum fallback — it works, and the platform console will show its role as
"Not set". Whether the hardware workspace should offer Salesperson as a
template is a product question, not a merge one.

> **Resolved 2026-09-08 by [D108](#d108--the-salesperson-is-the-hardware-templates-role-with-a-row-of-its-own):**
> the hardware template seeds a `SALESPERSON` row, `usr_salesperson` links to
> it, and the console shows "Salesperson".

**Per-unit discounts run through the one money engine.** `main` implemented
the `UNIT` basis twice in float arithmetic — the sale pipeline and the
quotation calc — each carrying a comment that it had to match the other to the
cent. This branch had already replaced both with `computeDocumentLine` (D59).
The engine learned the basis (`discountBasis`, multiply first, round once,
clamp at the line) and exports `discountAmountOf`, and both callers use it; a
quotation and the sale it becomes cannot now disagree because they no longer
have separate arithmetic. Proven with the engine's own specs, including the
half-cent case that distinguishes round-once from round-then-multiply.

**Timezones and document kinds compose.** `main` stamps receipts in the shop's
timezone; this branch labels a receipt with a local document kind when there
is no accounting provider. The receipt and return services take both.
`DocumentProfile` is now `DocumentSettings & { timezone }`, so the bill
preview (D96) builds one from the tab's unsaved values plus the page's
timezone state.

**Relocated, not conflicted.** `main`'s 16 hunks of retail-POS work
(credit-limit warning, invoice date, stock-tracking labels, pagination,
per-unit discount wording) were written against `app/(app)/pos/page.tsx`,
which this branch had reduced to a dispatcher after extracting that body
verbatim into `components/pos/pos-retail-checkout.tsx`. The diff was applied
to the extracted component instead; every hunk landed, and the two lines the
extraction had changed (the export and the D85 sheet height) are intact.

**Small unions worth naming.** `RestaurantConfig`-style route classification:
`main`'s two new routes are in the matrix — `GET /customers/:id/credit` under
the customers controller's class-level guard, and `POST /sales/:id/marked-paid`
given the route-level `RETAIL_POS` guard every other sales write carries.
`customers.repository.markQuickBooksSyncFailed` mirrors its status to
`ExternalEntityRef` like its sibling, per D63. `ProductsModule` imports
`SettingsModule` for the timezone-aware product report. The migration-set
tripwire lists all 68 with the eight from `main` annotated.

### D108 — the Salesperson is the hardware template's role, with a row of its own

**Decision (PO, 2026-09-08).** `SALESPERSON` is specific to the **hardware**
workspace template. It grants exactly what the hardware Owner grants — the same
permissions and the same screens — and it has a **linked role row**: a built-in
template keyed `SALESPERSON`, seeded into hardware workspaces and no others,
with the seeded demo salesperson linked to it like every other seeded user.

**Why.** D107 brought the role across from `main` as an enum value with a
permission set and nothing else. That left it half a role: authority resolved
through the legacy enum fallback, the platform console showed "Not set", the
workspace picker could not offer it, and — because the enum is platform-wide —
nothing said which kind of business the role belongs to. The product answer is
that a Salesperson is a hardware-shop job: the person on the counter who runs
the shop as the owner would. A restaurant, cafe, bakery or hotel has no such
post, and a template that appears in a picker is a template someone will
assign, so it is offered nowhere else.

**What changed.**

- **Template catalogue** (`packages/shared/src/types/role-templates.ts`).
  `BUILT_IN_ROLE_TEMPLATES` gains Salesperson (`isBuiltIn: true`, so a tenant
  cannot delete or edit it; `permissions: ROLE_PERMISSIONS.SALESPERSON`).
  `HARDWARE_ROLE_TEMPLATES` is now Owner, Salesperson, Cashier. GENERAL used to
  seed from the built-in list *as a whole*, which would have handed it the
  Salesperson by accident; it now selects Owner and Cashier explicitly through a
  new `GENERAL_ROLE_TEMPLATES`. Food-service and hotel lists are untouched.
  "Built in" now says who owns a role's definition; the per-template lists say
  who gets a row — the two were the same thing until this decision.
- **Authority by reference** (`authorization.ts`). `ROLE_PERMISSIONS.OWNER` and
  `ROLE_PERMISSIONS.SALESPERSON` are bound to one constant, not two spellings of
  `ALL_PERMISSIONS`. "The same as the owner" is a structural fact the parity
  spec asserts with `toBe`, not an equality that holds until someone edits one
  side. No permission changed hands: the set was already the owner's.
- **Owner-level checks that read the enum.** Five sites still decided
  cross-branch access on `role === 'OWNER' || role === 'ADMIN'`: the branch
  scope guard, `AuthRepository.hasBranchAccess` and `listAccessibleBranches`,
  and `UsersService`'s `roleGrant` and last-branch revoke guard. All five now
  ask `isAdminLevelRole`, the one place that answers "is this role
  owner-level" (D107), so a salesperson reaches every active branch exactly as
  the owner does. This is the "same UI" half of the decision: the accessible
  branches, the branch-scoped screens and the branch-access console treat the
  two identically. Nothing else in the web app keys on the enum — navigation
  derives from permissions and modules, the dashboard resolver already sent
  SALESPERSON to the admin dashboard, the discount ceiling was already
  unlimited, and the product screens already used `isAdminLevelRole`. The one
  visible difference is the profile chip, which prints the enum: "Salesperson".
- **Seed and provisioning.** The demo `usr_salesperson` is linked by
  `linkUsersToRoles` on key match, like the owner and the cashier, so it
  resolves from the database and the console shows "Salesperson". A hardware
  workspace created from the platform console seeds the row through the same
  `seedTenantRoles` call as its other roles; the console's role picker reads
  the workspace's own rows (D55.1) and so offers Salesperson in a hardware
  workspace and in no other. `baseUserRoleFor('SALESPERSON')` already mapped to
  its own enum value. `provision-tenant.ts` — the command-line production path
  — never linked anyone to a row; it now validates each `--user` role against
  the business type's templates (a SALESPERSON in a restaurant is refused, not
  left on the fallback as an owner-equivalent) and links every user on
  creation.
- **Reserved keys.** A custom role keyed `SALESPERSON` in a restaurant would
  have mapped to the owner-level enum underneath and been adopted — marked
  built-in, permissions `set` to the owner's — by the next role seed. So
  `RolesService.create` now refuses every enum value and template key
  (`ROLE_KEY_RESERVED`), and `seedTenantRoles` refuses, rather than adopts, a
  tenant-created row under a template key, and names a display-name collision
  before writing instead of failing on the unique constraint half-way through.
  `linkUsersToRoles` links to active rows only. The hole predates this
  decision (ADMIN, MANAGER, ACCOUNTANT keys were free everywhere); D108 is
  where it became worth closing because it is the first template offered to
  one business type and withheld from the rest.
- **Tests.** The parity spec pins seven templates, the exact built-in and
  non-built-in sets, the exact hardware set, the absence of Salesperson from
  every business type in `BUSINESS_TYPE_VALUES` but HARDWARE with a positive
  control per type, the by-reference binding, and mutation proofs for a
  narrowed salesperson and a leaked template; the domain-registry spec pins
  the same "HARDWARE only" fact at the registry. `branch-scope.guard.spec.ts`
  (new) proves with a Prisma stub that the set of roles the guard passes
  without a grant is exactly `ADMIN_LEVEL_ROLES`, and mutation-proves it by
  loading the real guard with `isAdminLevelRole` reverted to the old
  `OWNER || ADMIN` and showing the set collapse; the quotations and
  workspace-roles unit specs derive their owner-level sets from the same
  authority. Integration: role-seeding (the row, its permissions, the two
  refusals, linking), workspace-provisioning (the console's role list and a
  console user on the Salesperson row), role-authority (a SALESPERSON user
  links in a hardware tenant and not in a restaurant), role-management (the
  exact tenant-facing role list, the built-in's immutability, the reserved
  key, and the enum column moving with the row on assignment and demotion),
  branch-scope (cross-branch reach for every owner-level role and refusal for
  every other), platform-profile (every enum value in the read and write
  matrices) and discount-approval (a salesperson PIN approves beyond the
  manager cap). Web: the console users test's fixtures are the real hardware
  and restaurant sets, and the rail, settings and shell specs assert the
  Salesperson renders the owner's surface. End to end: PERM-014 (the
  salesperson's rail equals the owner's in a browser), PERM-015 (a 50% line
  discount needs no approval from a salesperson and is refused for a cashier)
  and PERM-016 (the seeded salesperson resolves from its row).

**No migration.** The enum value already exists (`main`'s
`20260831090920_add_salesperson_role`); the row is data, written by
`seedTenantRoles`, which is idempotent and never deletes.

**Rollout to existing hardware tenants.** Production has had the `Role` table
since the initial migration, empty: the two role migrations were additive and
wrote no data, and `main`'s seed seeds no roles. So after this merge deploys,
the pilot's users — its salesperson included — keep resolving through the
legacy fallback until the tenant's rows are seeded and they are linked. That
is an operator step, deliberately not a migration (§12.1): the new
`prisma/backfill-tenant-roles.ts <slug> [--write]` runs the catalogue sync,
`seedTenantRoles` for the tenant's business type (a no-profile tenant is
HARDWARE, D57) and `linkUsersToRoles` in one transaction, lists the users it
cannot link (an enum with no template — MANAGER, ACCOUNTANT, ADMIN — is a
re-role decision for a person), and refuses on any collision with a
tenant-created role. `role-authority-report.ts` is the confirmation. The
runbook (`06-migration-and-rollout.md`) carries the step. Nothing is lost in
the gap: a fallback salesperson holds the same permissions; only the console's
"Not set" and row-based resolution wait on it. (D87 and D94 say their template
grants reach existing users "through `pnpm db:seed`"; that is true of the
development tenants only — on production the same backfill is the path.)

**Not changed, on purpose.** The demo salesperson still has no PIN, as `main`
decided. PINs only answer in-POS approval prompts here (D48), so the practical
meaning is that the seeded salesperson cannot act as an approver in the demo
while the owner's 2222 can; a real salesperson is given a PIN like any other
user. The seed comment now states the difference instead of claiming the
credentials mirror the owner's.

### D109 — the account menu names the person and their role, nothing else

**Decision (PO, 2026-09-08).** The menu behind the profile button in the
header shows the user's name and role. The two lines beneath them — the branch
("Main Dining") and the register ("Counter 1") — are removed.

**Why.** The menu is about the account: who is signed in, what they are, and
the way out. The till's location is a property of the session, not of the
person, and on a one-branch, one-register shop the two lines were the same
noise under every name. Nothing else changes: the session still carries the
branch and register for the screens that need them, and the header's own
branch and register chips were already gone (DASH-015).

### D110 — merging `fix/table-tab`: how each clash was decided

`origin/fix/table-tab` (nine commits, 2026-09-01 to 09-08, branched from the
restaurant tip `4f0be1b`) was merged into `merge/restaurant-changes` after D107
had brought `main` in and D108/D109 had landed. It carries D99–D106: roll
calibration, the kitchen board's ergonomics and ticket recall, the 86 switch,
print geometry, the "Menu" rail entry, one joined table with several tabs and
its two follow-ups — plus `roleName` on the session, the customer capture
popup's address fields, the order detail drawer, the reservation dialog,
QuickBooks-gated customer screens with mobile-number validation, and a
portalled tooltip. Ten files conflicted; what follows is every decision that
was more than "take both".

**Decision numbers.** Both branches appended after D98. Theirs cite D99–D106 in
code, specs and two migrations; today's three records were newer and cited by
nothing outside this branch, so they moved up — D99→D107, D100→D108,
D101→D109 — in one commit before the merge, every reference and anchor
included. The log now reads in the order the decisions were made.

**The unnamed migration is dropped.** Their branch carried
`20260831055102_setup1`: a DROP and re-ADD of `InventoryReceiptLine_productVariantId_fkey`
with `ON DELETE SET NULL`. That is the D44 drift — the migration wrote
`RESTRICT`, the schema declares the relation without `onDelete` and so means
`SetNull` — which every feature migration since `20260826` deliberately strips
from `migrate diff`'s output, and their own tripwire refused to count it: "its
owner must add a decision record for it or remove it". Removed. Production
never had it; a developer database that applied it needs a `prisma migrate
reset` (or its `_prisma_migrations` row deleted and the constraint re-added as
`RESTRICT`) — `migrate resolve --rolled-back` only takes a migration that
failed. The drift itself is unchanged and still stripped; whether `RESTRICT`
or `SetNull` is the intended behaviour for a variant a receipt line still
references is open (O6).

**Production's migrations are `main`'s, and none was touched.** The merged
set is 70: this branch's 60, `main`'s 8 and their two, both purely additive
nullable columns (`Product.soldOutAt`, `TableSession.tabName`) on tables the
feature migrations create earlier in lexical order. Proven as D107 was: an
empty database applies all 70 and `migrate status` reads up to date; a database
at `main`'s 27, with a customer-account payment (`saleId NULL`) seeded in
between, applies the remaining 43 and keeps the row, holds
`Sale_tenantId_completedAt_idx` once, and reads up to date. On both, `migrate
diff` emits exactly the D44 FK pair and nothing else.

**Their role display, our menu.** The account menu shows their
`roleName` — the role row's name, so a waiter reads "Waiter" rather than the
CASHIER enum underneath, falling back to the enum for a session minted before
the field existed — inside D109's two-line menu with no branch or register.

**`main`'s pagination stays.** Both the sales and customers lists conflicted
between `main`'s one `Pagination` component (D107: "numbered pagination
everywhere, from one component") and their older hand-rolled pager, which hid
itself when the total fit the smallest page size. The component won; the
hide-when-small rule did not survive, and is recorded here as a product
question rather than silently re-added inside a merge.

**The customers list keeps `main`'s columns and takes their gating.** "Credit
limit" and "Available credit" (with the hover explanation) stay; the Sync
column, the QuickBooks badges and the QuickBooks detail fields on the customer
page render only when the QUICKBOOKS module is enabled, resolved from the
platform profile (D31) — a restaurant customer no longer sees "Not synced".
Their commit also dropped the **Type** column (Retail / Wholesale / Credit)
from the list. The merge restored it for want of a stated reason; the PO
confirmed the same day that the removal was intentional, so it is gone
again — the Type filter above the list stays, as their branch left it. The
empty-state `colSpan` mirrors the header row in one named constant (five
fixed columns plus Sync) instead of two scattered literals.

**One tooltip, `main`'s.** Both sides replaced the CSS-only tooltip with a
portalled one for the same clipping reason. `main`'s follows the trigger on
scroll, clamps to the viewport edges and guards server rendering; theirs
dismissed on scroll. `main`'s is kept whole; nothing imported anything else
from theirs.

**The settings preview takes both props.** Their `set` and `showCalibration`
(D99's calibration strip lives on the Preview tab) and `main`'s `timezone`
(a document profile is the settings plus the shop's zone).

**Tests and the catalogue.** Their branch changed nothing under `apps/e2e`,
so D103's relabel left three Playwright assertions pinning the old rail
(RPW-001, WS-401, WS-402: "Inventory" present, "Menu" absent); all three now
assert the D103 rail, positively and negatively. Their seed ships three dishes
86'd, and the tablet counter spec clicked "the first priced tile", which can
now be a disabled one; it clicks the first enabled tile. Their orders list
became a page object (`items`, `total`, `page`, `pageSize`) and stopped
reading `limit`; the two counter specs that read it as an array (POS-CTR-301,
POS-CTR-401) now read the page. Those two still fail for an older reason —
they expect a seeded "Chicken Kottu" with modifiers that no seed has carried
since before D99 — which is recorded with the other pre-existing browser
failures rather than fixed here. Their eight decisions
added no rows to `testcases.md`; rows are added under the existing prefixes,
and UI-006, which still described the account menu D109 emptied, is corrected.
The header gains a render test for the two-line menu and the `roleName`
fallback, which neither D109 nor their change had.

**What their permission reaches.** D101's `PRODUCT_AVAILABILITY_SET` is
granted to the food-service Waiter and Cashier templates and, through
`ALL_PERMISSIONS`, to OWNER and ADMIN and MANAGER — and to SALESPERSON, which
is the owner's set by reference (D108). Their branch never saw that role;
recorded here the way D107 recorded what `main` never saw.

**Route matrix.** 288 routes, 200 module-guarded, 88 ungated: their three
(availability, ticket reopen, order detail) and `main`'s two (customer credit,
marked-paid), totals taken from the spec that checks the document.

**Open, for a product decision — tracked as O6 and O7.** (1) Whether a
variant still referenced by a receipt line may be deleted with the line's
reference nulled (`SetNull`, the schema's meaning) or must be refused
(`RESTRICT`, the database's behaviour); settling it ends the churn with either
an explicit `onDelete: Restrict` in the schema (no migration) or a named
migration. (2) Whether the pager should hide when a list fits one page — their
Orders screen still does; every `main` list renders it.

---

### D111 — the kitchen board rings for tickets it has not seen

PO, 2026-09-04: "i created new order but in restaurant view or cashier
kitchen view not sounding." The orders queue had a chime since it was
built; the kitchen board — the screen a kitchen is NOT staring at between
tickets — had none. Every mainstream KDS beeps on ticket arrival; a
silent wall-mounted board is a dish nobody starts.

The board now rings the same synthesised two-note chime the orders queue
uses (`lib/restaurant/new-order-chime.ts` — built for "live queue
screens", now finally plural), on the same baseline discipline: the first
load never rings, a filter switch re-baselines instead of ringing for
cards that merely became visible, and audio stays best-effort (a blocked
autoplay drops the ding rather than queueing a burst).

Two deliberate differences from the queue's rule:

**Ids, not a total.** The queue compares `total` because its list is
paged and ids shift between pages. The board is unpaged, so the baseline
is the id SET, and a poll rings when an unseen id appears — including
when one ticket is bumped in the same poll another arrives, where a count
stays flat through exactly the arrival the pass must hear.

**Only "To make" rings.** A new id on the Done tab is someone bumping,
not work arriving. A ticket appearing on To make because ANOTHER screen
recalled it does ring: to this pass it is new work regardless of why.

Deliberately NOT gated on `KITCHEN_STATUS_UPDATE`: D94 gives the till
`KOT_VIEW` alone precisely so a read-only board can hang where food is
made; a chime keyed to the write permission would silence the one
mounting that needs it most. Sound follows the screen, not the role —
the same reason the orders queue rings for whoever watches it.

Paired per D30 in `kitchen-board.render.test.tsx`: silent first load
with tickets rendered (positive control), ring on an unseen id, silence
on an unchanged poll, ring on bump+arrival with the count flat, and
silence across a filter switch and Done-tab growth. Verified live on the
dev stack: oscillator instrumentation shows 0 notes opening either
screen and exactly one two-note chime on the poll after a takeaway order
lands, on both `/kitchen` and `/orders`.

---

### D112 — the floor hears the bump: a food-ready bell on the tables screen

PO, 2026-09-04, closing the loop D111 opened: sounds now travel TO the
kitchen (order chime) but not back FROM it. Every mainstream expo flow
has the return signal — the kitchen bumps, the runner is paged, the food
does not die under the lamp. The waiter-facing half did not exist here.

**The signal path is open-sessions, not the kitchen board.** The waiter
template deliberately lacks `KOT_VIEW` ("a waiter has no business on the
kitchen display") and this record does not weaken that: instead
`GET /open-sessions` — the route that already answers "my tables", D70
scope and all — now carries `readyTicketIds` per session: the ids of its
COMPLETED kitchen tickets, resolved by one extra query walking ticket →
round → order → session. Ids rather than a count or a flag, so the
client can ring exactly once per NEW bump, and so a recalled ticket
takes its acknowledgement with it when it leaves the list — a re-bump
is fresh news and rings again. Asserted through the real routes in
`kitchen-board.spec.ts`: empty before the bump, the id after, empty
again after recall.

**The floor plan gets its first live loop.** `/tables` loaded once and
went stale; it now refreshes SESSIONS every 8 s (visible-tab gated,
catch-up on return — the orders queue's cadence and manners; 5 s is the
kitchen's urgency, not the floor's). The furniture (areas, tables) keeps
its explicit loads: admin-cadence data has no business on a poll.

**A bell, not the chime.** Two taps on one note (E6·E6) against the
order chime's rise (A5→D6) — distinguishable across a room, which is the
entire job of a second sound. Same synth module, same autoplay manners
(first load never rings, blocked audio drops the ding).

**The badge and its acknowledgement.** The ring points at a card:
"Food ready" with a concierge bell on the table (joined open tables
included). There is no "served" verb to clear it server-side — carrying
the plate IS the acknowledgement — so opening the order (View order)
answers the bell per device, persisted in sessionStorage exactly like
the POS cart. Another tablet's bell keeps ringing until ITS holder
looks: serving is whoever carried the plate.

Paired per D30 in `table-floor.ready.render.test.tsx`: first-load
silence WITH a standing badge (the positive control that separates
"state to read" from "arrival to announce"), ring+badge on a new bump,
silence on repeat, ack clearing without reviving, and the
recall-then-rebump second ring. Verified live: floor open on M5 =
0 notes; ticket bumped through the kitchen route = one E6·E6 bell
(instrumented frequencies 1319/1319) and one Food-ready badge inside
the 8 s window.

Housekeeping under this record: `global-setup.ts` of the integration
suite spawns `pnpm.cmd` through a shell on win32 — before that, ENOENT
killed every integration spec on a Windows dev machine before the first
test.

---

### D113 — the board gets a Preparing state, and the queue follows the kitchen

PO, 2026-09-04: "in kitchen view there is only option as mark done. but
in there add option to preparing, then done, so when that happen need to
update orders page according to status change. please do like industry
pos system handle." Which is exactly the mainstream KDS bump bar: a
ticket is NEW, someone taps it and it is COOKING, they tap again and it
is BUMPED — and the order status the rest of the house sees is driven by
those taps, not by anyone re-typing it.

**One enum value is the whole schema change.** `KitchenTicketStatus`
gains `IN_PROGRESS` (migration `20260908000000_…`, ALTER TYPE ADD VALUE
IF NOT EXISTS — additive, no rows, no defaults). The board's OUTSTANDING
filter already means "not COMPLETED", so a started ticket stays exactly
where outstanding work belongs. D111's chime baseline diffs ids, not
statuses, so starting rings nothing.

**The derivation was already waiting.** The Orders queue's
`unifiedStatusForRestaurantOrder` has mapped round IN_PROGRESS/READY
since the queue was built — dead branches, because nothing ever moved a
round. `syncKitchenProgress` now RESTATES the ticket set onto the round
after every kitchen verb (any started/bumped → IN_PROGRESS, all bumped →
READY, recall recomputes honestly — DELIVERED and CANCELLED are floor
verdicts the kitchen never touches), and the queue lights up with no
change to the queue itself. The unit spec pins the once-dead branches.

**Takeaway advances with the kitchen, forward only.** The profile is
what the customer was told, so the kitchen moves it
PLACED → IN_KITCHEN → READY as it works, never backward past that — with
one exception: a recall retracts READY to IN_KITCHEN, because "your food
is ready" has stopped being true. It retracts to IN_KITCHEN even if
nothing is cooking at that moment, never to PLACED. HANDED_OVER stays
the cashier's alone (it settles the Sale); the manual stepper keeps
working and the kitchen never overrides a cashier who stepped ahead.

**On the board: one verb per state.** Start preparing (chef hat) on a
queued card, Mark done on a started one — never both stacked; two 48px
buttons would halve the tickets a pass can see, and the taps are
adjacent in time anyway. Starting swaps the card IN PLACE (verb flips,
a warning-tone Preparing badge joins the age timer, which keeps
counting from creation); only the bump still drops the card. Start is
idempotent and a stale start never un-completes a bumped ticket —
Recall stays the only path down, and recall still lands on QUEUED
(D100 unchanged): the cook taps Start again if the pan is already on.

WS-408's till contrast now matches "any write verb" (`start preparing|
mark done`) — the claim was always "the till cannot work the board",
not the absence of one label. Paired per D30: board render tests pin
one-verb-per-state both ways plus the in-place flip; a new
`unified-status.spec.ts` pins the derivation branch by branch;
integration proves the whole ripple through the real routes (ticket →
round → unified feed → takeaway profile, up on start/bump and back
down on recall). Verified live: tapping Start preparing on /kitchen
flipped the card, /orders showed "Preparing" and then "Ready" on its
own poll after the bump, and the takeaway profile advanced
PLACED → IN_KITCHEN → READY untouched by hand.

---

### D114 — the counter hears the handover: a ready bell on the Orders queue

PO, 2026-09-07: when an order goes Ready, the cashier's queue moved the
row and ticked the Ready tab — silently. Mainstream systems put a sound
on exactly one slice of readiness: the alert follows **whoever hands
the food over**. Dine-in readiness pages the floor (D112's bell,
built); a takeaway or third-party order going READY is the counter's
news — bag it, call the name or the rider — and the counter heard
nothing.

**One number from the server.** The queue's envelope gains
`readyHandoverCount`: READY rows on TAKEAWAY + THIRD_PARTY, tallied in
the same derivation pass as `statusCounts` — before the status filter,
after channel/search — and DINE_IN is excluded on purpose: a till that
dings for every plated table is noise, and that bell already rings
where the runner is. Counted server-side because the page only sees 25
rows of whatever tab is open; the tally sees the whole picture.

**The bell rings whichever tab is open.** The page keeps a second
baseline (keyed on channel|search, NOT status — the tally ignores the
status tab, so reading "Pending" must not deafen the counter), rings
`playFoodReadyChime` — the same E6·E6 service bell the floor uses, one
sound per meaning across the house — only when the count GROWS, and
re-baselines on filter changes. A falling count (a handover) is silent;
the next order up rings again. First load never rings: bags already on
the pass are state to read, not an arrival.

Paired per D30: the polling suite pins silent-first-load-with-ready,
ring-on-growth with the order chime explicitly NOT firing (total flat —
the two sounds stay distinguishable), silence on the falling count then
ring on the next rise, ring across a status tab, re-baseline on a
channel switch; integration pins the tally through the real routes —
0 while in kitchen, 1 on the takeaway bump, 0 again on recall, and 0
for a READY DINE-IN order (the negative that keeps the till quiet for
the floor's food). Verified live: /orders open on the Pending tab,
baseline silent; the kitchen bumped RO-000059 and the queue rang
1319/1319 Hz inside the poll window.

The sound story is now closed on every screen that owns a next move:
order in → rising chime where it lands (kitchen D111, queue D111);
food up → service bell where the handover lives (floor D112 for
dine-in, counter D114 for takeaway/third-party).

---

### D115 — four lanes on the board, and cancellation finally reaches the pass

PO, 2026-09-07: "kitchen add to tabs called preparing and cancelled."
The board's two tabs become the bump bar's four lanes — **To make ·
Preparing · Done · Cancelled** — each ticket in exactly one.

**Preparing is a view, not a fetch.** To make and Preparing split the
one outstanding list client-side (queued family vs IN_PROGRESS), so
flipping between them is instant, both chips carry live counts at once,
and D111's chime keeps a single baseline across the pair — keyed on the
FETCH now, not the tab, so an arrival rings whichever of the two the
cook is reading. Start moves the card one lane along instead of
flipping it in place: the D113 flow, now with somewhere to move to.

**Cancelled fixes a real hole.** Tickets have no cancelled status —
cancellation lives on the order side (today only the takeaway profile
is ever written; the read also honours a cancelled round or order so a
future cancel verb lands here for free) — and until now it never
reached this screen: **the kitchen kept cooking food nobody was coming
for.** The `CANCELLED` pseudo-filter (a peer of D68's OUTSTANDING)
collects called-off work at any ticket status, newest first;
OUTSTANDING and COMPLETED now exclude it, so cancelling pulls the
ticket off the working lanes mid-cook and Done never celebrates a dish
that was called off after the bump. The lane's cards are read-only —
muted, red badge, no age (nobody is waiting), Details only: there is
nothing left to DO to dead work but see what it was.

Deliberately not yet: a cancellation sound (the lane and its count say
it; a red klaxon can come if the pilot loses food to unseen cancels),
and item-level voids on tickets (KitchenTicketItem is a snapshot with
no link to the order item — schema work for its own record).

Paired per D30: render tests pin the lane split both ways (Start on To
make / Mark done on Preparing, never both; the started card leaving one
lane AND arriving in the other), the Cancelled lane's badge + absent
verbs with Details as the positive control, and the till still naked of
verbs on both working lanes; integration pins the read through the real
cancel — on the board before, gone from OUTSTANDING and listed under
CANCELLED after, and a completed-then-cancelled ticket leaving Done
too. Verified live: cancelled the leftover RO-000049 takeaway — its
ticket left To make and sat alone in the Cancelled lane (screenshot),
chips carrying live counts.

*(Superseded in part by D116, same day: the board's Cancelled LANE was
removed — the read exclusions and the CANCELLED pseudo-filter stand.)*

---

### D116 — cancelling is the queue's verb, not the kitchen's

PO, 2026-09-07, on seeing D115's lane: "remove cancel from kitchen add
it to orders page and need option to cancel the order." Which is the
cleaner division of labour: **the kitchen decides doneness, the counter
decides whether an order still exists.** The board goes back to three
lanes — To make · Preparing · Done — and cancelled work simply vanishes
from it (D115's read exclusions stand unchanged; so does the CANCELLED
pseudo-filter, unsurfaced, for whatever later wants to list called-off
work). The strip is pinned as the exact three-label set so a lane
cannot creep back unnoticed.

**Cancel order lives in the queue's drawer.** For a takeaway row still
in play — not handed over (a settled Sale is refund territory), not
completed or already cancelled — the drawer offers a danger-styled
Cancel order behind a confirm dialog that names the order, the customer
and the item count. It drives the EXISTING takeaway status machine
(`PATCH /restaurant/takeaway/:profileId/status`, permission
`TAKEAWAY_CREATE` — the same hands that create takeaways may cancel
them) rather than growing a parallel cancel route; the detail view
gains `takeawayProfileId` so the drawer can address it. On success the
queue refetches at once (new `onMutated` plumbing) and the kitchen's
ticket leaves the board on its next poll via D115's read.

Deliberately narrow: **dine-in has no queue-side cancel** — its items
are voided at the table, where the bill lives, under ORDER_VOID_SENT's
deliberate restrictions; **third-party rows** belong to the platform
that sent them. The button is absent, not disabled, where it does not
apply — the View-bill rule.

Paired per D30: the drawer suite pins eligibility from both sides (a
live takeaway offers it; handed-over, dine-in, and an unpermitted
viewer do not), the confirm flow to the exact API call, and backing
out calling nothing; the board suite pins the exact lane strip.
Verified live end-to-end: RO-000051 on the kitchen board → cancelled
from the Orders drawer (confirm dialog screenshot) → row reads
Cancelled at once → the board no longer shows it.

---

### D117 — payment settles; handover is a hand

PO, 2026-09-07: "i found the bug, when takeaway place it shows handed
over. but it need to show like other pending, preparing, handed over,
also no need completed tab hide it." Correct on both counts. The
counter popup's step 2 was `updateStatus(HANDED_OVER)` — not because
the bag had crossed the counter, but because handover was the only
verb that closed the session into a Sale for payment to land on. The
side effect was the bug: every counter order read "Handed over" for
its entire cook time, and D113's kitchen-driven statuses could never
touch it (forward-only stops at what the customer was told).

**Money and handover are different instants.** New
`POST /restaurant/takeaway/:profileId/settle` closes the session into
a Sale — totals via the shared calculator, lines via the fulfilment
projection, the exact block handover used, now extracted as
`settleSessionIntoSale` and shared — while the profile keeps its
lifecycle status. Idempotent (an already-CLOSED session returns its
Sale); refuses a CANCELLED order; same TAKEAWAY_CREATE permission.
The popup's step 2 becomes settle: the customer pays up front as
before, the receipt still prints from the Sale (D98 untouched), and
the order now reads **Pending, paid** — flowing Preparing → Ready as
the kitchen works (D113), ringing the counter's bell on READY (D114).

**Handover becomes a button.** The queue drawer gains one-tap
"Mark handed over" beside D116's Cancel (no confirm — it is the
routine positive act), driving the same status verb, which now REUSES
the settled Sale rather than minting one. The takeaway workspace's
stepper still works unchanged for unsettled (waiter-created) orders,
where handover still creates the Sale.

*PO amendment, same day: the button is offered ONLY on READY rows —
food the kitchen has not called up cannot be handed to anyone, and a
skip-the-kitchen button invites exactly the premature "Handed over"
this record kills. The workspace stepper stays the deliberate escape
hatch. Pinned both ways in the drawer suite (absent on PENDING and
IN_PROGRESS with Cancel present as the positive control).*

**No Completed tab.** COMPLETED is the dine-in shell's closed state;
its rows stay reachable under All Orders and an old
`?status=COMPLETED` bookmark still filters — the strip now shows the
lifecycle the counter actually works: Pending → Preparing → Ready →
Handed over, plus Cancelled.

Paired per D30: integration walks the whole life — placed+settled is
PLACED with a Sale, settle again returns the SAME Sale, the kitchen
still advances a settled order, handover reuses the Sale, and a
cancelled order refuses to settle (400); the drawer suite pins the
one-tap handover to its exact call and its absence on a handed-over
row. Verified live: create → settle → pay (the popup's exact calls)
read PENDING/paid on the queue, Preparing on start, Ready on bump,
Handed over from the drawer with the Sale id unchanged — and the tab
strip reads exactly All · Pending · Preparing · Ready · Handed over ·
Cancelled.

---

> **Corrected 2026-09-08 by [D119](#d119--merging-fixissues-restaurant-how-each-clash-was-decided):**
> the "manual stepper" named here (and in D113) as the escape hatch was
> deleted with the `/takeaway` cutover on 2026-08-10; `/takeaway*` redirects
> to `/pos?mode=takeaway`, which only creates orders. With the drawer's
> handover offered on READY alone, an unbumped ticket has no hand-over path
> in the product today — tracked as O9.

### D118 — sound lives in the kitchen alone

PO, 2026-09-07: "remove sound from waiter and cashier, only need
kitchen staff kitchen." Two days of D111–D114 built a sound per screen;
the PO ran it and wants one: the kitchen's new-ticket chime stays,
everything else goes quiet. Their restaurant, their ears — and it is a
defensible shape: the kitchen is the one station facing AWAY from its
screen, while the counter and the floor look at theirs.

Removed: the orders queue's arrival chime (D111's second home) and the
food-ready bell on BOTH the waiter floor (D112) and the queue (D114).
Kept, deliberately: every VISUAL signal those sounds accompanied — the
floor's "Food ready" badge with its per-device ack and
recall-re-badges behaviour, the queue's Ready tab and counts — and the
server's `readyHandoverCount` tally (integration-tested, one field,
the bell's whole backend) so re-inviting a sound is a frontend-only
change. The audio module shrinks to the kitchen chime and remains the
single home for POS audio.

Pinned as tripwires, not deletions: the polling suite re-runs the
exact polls that used to ring (total growth, handover-tally growth)
against a fully-stubbed audio module — including the REMOVED export
under its old name — and asserts silence with the fetches proven; the
floor suite keeps every badge behaviour and asserts the ring-poll
badges without sound. The kitchen board's chime tests are untouched.

### D119 — merging `fix/issues-restaurant`: how each clash was decided

`origin/fix/issues-restaurant` (three commits, 2026-09-07 and 09-08, cut from
`fix/table-tab` on 09-04 — before that branch's joined-table tabs) was merged
into `merge/restaurant-changes` after D110. It carries D111–D118: the kitchen
board's new-ticket chime, the food-ready badge on the tables screen, the
Preparing state and the bump bar's Start, the ready bell on the orders queue,
the board's lanes and cancellation reaching the pass, cancelling as the
queue's verb, payment settling without handing over, and sound living in the
kitchen alone — plus the product wizard's validation and character limits.
Five files conflicted.

**Decision numbers, again.** The branch numbered its eight records D104–D111.
`fix/table-tab` went on to use D104–D106 for the tabs (merged in D110) and this
branch holds D107–D110, so theirs moved up by seven — D104→D111 … D111→D118 —
in one commit on the branch's own history, every reference included, the
migration's comment among them. A probe confirmed `migrate deploy` — the
production path — does not re-check an applied migration's file, so nothing
changes for a deploy. `migrate dev`, the development path, does: a developer
database that applied the migration under its old comment will report it as
modified and wants a reset (or its `_prisma_migrations` checksum updated) —
most likely only the branch author's. (The same sed had touched a base64
image whose bytes happened to spell "D104"; that file was restored before the
merge.)

**The migration is additive and proven.** `20260908000000_add_kitchen_ticket_in_progress`
adds one enum value with `ALTER TYPE … ADD VALUE IF NOT EXISTS`; 71 in the
set. An empty database applies all 71 and reads up to date; a database at
`main`'s 27, with a customer-account payment seeded between, applies the
remaining 44, keeps the row, carries the new value, and reads up to date.
`migrate diff` emits only the D44 FK pair on both, as before (O6).

**The floor plan carries both: several tabs, and the badge.** `fix/table-tab`
made a table's sessions a LIST (D104: one link per tab, "Add a tab"); this
branch put a per-device "Food ready" badge on each session (D112, D118: visual
only) — written against the single-session floor. The union keeps the list:
each tab is an `OpenSessionView` with its bumped-ticket ids; an arrangement's
badge counts unanswered bumps across every tab and clears tab by tab as each
tab's link is opened; a physical table still carries one. The Unreserve
control their side still rendered on a held member is not carried — D106
removed it, for the reason it records. Their new render test learned the
tab's name field.

**Everything else is theirs or a union.** The kitchen ticket's tab name (D104)
survives their Preparing/lanes edits to the kitchen service; the orders page
object (D110) survives their filters, counts and cancel; WS-408 keeps the
seeded ticket and matches either write verb ("Start preparing" or "Mark done");
the seed keeps both the 86'd dishes and the tabs; the win32 shell line keeps
its explanation. Route matrix: 290 routes, 202 module-guarded, 88 ungated.
The wizard's validation and character limits ride along without a record of
their own, as the Type column did in D110.

**Tests and the catalogue.** Their branch touched one Playwright test
(WS-408). Nothing else went stale: the labels they renamed are pinned at unit
level (the board's three lanes, the queue's tabs), and the tablet board test
now names the Preparing lane too. Their float ready spec covered one physical
table and no arrangement; the union adds the case it introduced — a joined
table with two tabs, one bumped: one badge on the arrangement, none on its
members, cleared tab by tab. The reopen unit spec gains the Preparing case
(a preparing ticket is not recalled). Their eight records added no catalogue
rows; eleven are added under KIT, POS, OTBL, UI and PROD. Their `migrate
dev` note above, and two comments in the takeaway service that still said
the Sale lands on handover, are corrected.

**What their permissions reach.** The bump bar's Start is gated on
`KITCHEN_STATUS_UPDATE` like completing, so Kitchen staff hold it and the
till's read-only board (D94) does not; the chime, though, is a property of
the screen, not the role — a cashier watching the board hears it. Settle is
`PAYMENT_COLLECT`. Both reach the Salesperson by reference (D108). O7 (the
pager) is unchanged by this merge.

**Two consumers D113 did not visit.** The restaurant dashboard's "Kitchen
queue" tile counted `QUEUED` tickets, which was the whole outstanding set
until Preparing existed; it now counts `OUTSTANDING`, so a kitchen with every
ticket on the stove no longer reads zero. The board's empty Preparing lane
told whoever was looking to "Start a ticket from To make" — the till (D94)
reads the board without that verb; it now reads "Nothing on the stove." The
two D118 silence tripwires (orders queue, tables screen) mocked a chime
module neither screen imports, so a bell rung any other way would have
passed; they now stub the browser's `AudioContext` and assert it is never
constructed, with a positive control that the real chime does construct it.

**Open, for a product decision — O9.** D113 and D117 lean on "the takeaway
workspace's manual stepper" as the escape hatch when the kitchen forgot to
bump. It was deleted with the `/takeaway` cutover (2026-08-10); the drawer
offers handover on READY only. Today the only way to hand over an unbumped
ticket is the API. Refuse, restore a stepper, or offer a confirm-gated "Hand
over anyway" — a decision, not a merge edit.

**Open, for a product decision — O8.** D116 made cancelling the queue's verb
and D117 let payment settle a counter order without handing it over. Where
the two meet, the server's takeaway status write still has no transition
guard — it never did — so a counter order that has been settled and paid can
now be cancelled from the queue with its Sale left PAID and no refund. The
drawer's client-side gate does not cover it either, because a settled order
no longer sits at HANDED_OVER. Not changed in a merge; recorded for a
decision (refuse, or refund).

---

## 2026-08-28 — Retail template

### D120 — the Retail template returns: clothing first, local inventory, one workspace per shop

**Supersedes D57** on its retail half. PO decision, 2026-08-28.

D57 removed `TILE_SHOP` and `RETAIL` from `BusinessType` on 14 August, on the
finding that the Hardware template and the Tile Shop were the same entity and
that **there was no Retail template**. That was true of the world it was written
in: the enum was ten days old, the three retail values carried zero rows, and no
retail customer existed. *"A transition for ghosts protects nothing."*

What changed is the customer, not the reasoning. A clothing retailer is now in
scope, with grocery behind it, and a template that does not exist cannot serve
them. D57 is superseded on its facts rather than corrected on its logic — the
removal was right, and re-adding is cheap in the direction that matters:
`ALTER TYPE … ADD VALUE` is additive, so this record needs none of the
destructive-migration exception D57 had to carve out in
`provider-contract.spec.ts`.

**`RETAIL` returns; `TILE_SHOP` stays removed.** The Tile Shop finding is
untouched — it really is a Hardware workspace, and the pilot tenant remains
classified `HARDWARE`.

#### What a Retail workspace is

A `RETAIL` business type with its own `DomainDescriptor` in
`packages/shared/src/domains/`, registered in `DOMAIN_REGISTRY` — which is total
and has no fallback (D56), so the value cannot exist without the descriptor.

- **Providers:** `InventoryMode.LOCAL` + `AccountingProviderKind.NONE`. Retail
  does not integrate with QuickBooks. This needs no code: both values already
  exist, and D63's quarantine already assumes tenants that never speak to it.
- **Modules:** `SHARED_CORE_MODULES` + `RETAIL_MODULES` **minus `QUICKBOOKS`**.
  `RETAIL_CAPABILITIES` is adopted as-is — it already declares
  `catalogue.variants` and `collections` true, `fulfilment.kind: IMMEDIATE`,
  `channels: ['COUNTER']`.
- **Navigation and permissions** follow D93: a rail entry is gated on what the
  screen can do. A retail till legitimately holds `SALE_CREATE`; nothing may use
  it as a proxy for anything else.
- **Catalogue fields** arrive through `catalogue.attributeSchema` (D64) —
  description in `attributes`, behaviour in columns. Clothing and grocery each
  declare their own; neither adds a migration.

#### One workspace per shop

**A Retail workspace serves exactly one shop, with one branch.** A chain of three
shops is three workspaces.

This is a deliberate acceptance of an existing limit rather than a design
preference. `LocalInventoryProvider` counts a tenant's active branches and
**refuses every stock operation when there is more than one** — the guard D10
describes as protecting against a shared `Product.quantityOnHand` being
decremented by two shops at once. D10 calls that *"a known architectural defect …
not an acceptable permanent limitation"* and schedules the fix as Phase 2.5.
**That fix is not a retail dependency and is not being brought forward.** With one
branch per workspace the guard is never reached.

What the model gives up, recorded so nobody discovers it in front of a customer:
stock, catalogue, customers and reporting are per shop; there is no cross-shop
lookup, no transfer, and no consolidated head-office view. The product-import
path makes seeding a second shop practical. The first customer who needs one
number across two shops reopens D10 Phase 2.5.

#### The sellable unit is the variant

Retail sells a size, a pack, a weight — not a style. `ProductVariant` and its
dimensions already exist, `SaleItem.productVariantId` is already nullable with SKU
and name snapshots (D44), and goods receipts already write per-variant stock into
`BranchInventory`.

**The sell path does not.** It aggregates cart lines by `productId` and decrements
the global `Product.quantityOnHand`, so selling a Medium reduces a shared "shirts"
number and leaves the Medium count untouched. Per-variant stock accuracy is a
requirement of this template, and closing that gap is the first implementation
phase.

Two properties carry forward unchanged: the conditional stock write that prevents
two tills selling the same last unit — moved, never reimplemented — and the
`trackInventory` check that keeps non-stocked lines moving no stock.

#### Tax

Per **category** and **global**, resolved most-specific-first, with
`Product.taxable` honoured as an exemption and the resolved rate **snapshotted
onto the sale line** so a rate change cannot rewrite an old receipt — the same
reasoning D44 applies to variant names.

**No price bands.** Considered and rejected: the band-boundary behaviour is
visible to a shopper whenever a discounted item crosses one, and no confirmed
format needs them.

Prices are **displayed tax-inclusive**. Storage is unchanged — net, tax and gross
stay separate; only presentation changes. The inclusive figure is never stored as
the price, because converting it back to net drifts by a cent at some quantities
and the receipt would then disagree with the ledger. This finally gives
`AppSettings.taxInclusive` a meaning; it has been persisted and read by nothing.

Per-line tax replaces the single order-level figure. D8's requirement that tax
treatment stay tenant-configurable is unaffected.

#### Formats

**Clothing and grocery are the confirmed formats. The clothing pilot ships
first.** Scales and weighed goods are grocery-only and are not on the clothing
path.

Further retail formats — pharmacy, electronics — are added as a descriptor and a
seed pack, never as code. If a third format requires a new table, a DTO change or
a branch in a service, the mechanism has failed and the mechanism is what gets
fixed. The one legitimate exception is a format needing genuinely new *behaviour*,
which is a feature with its own record, gated by a capability.

#### Billing audit: A4 and A8 only

Of the five open items in `hardcoded-audit.md`, the retail work claims **two**:

- **A4** — promotions are surfaced by the POS catalogue and never applied at
  close. Retail needs working promotions, and the fix lives in a new applier plus
  the retail sale path.
- **A8** — reports coerce `Decimal` to float and back, so totals cannot tie to the
  payment ledger. This is fixed **before** retail reporting is built on the same
  code, not after.

**A2, A3 and A7 are deliberately not claimed here.** They are restaurant-side
defects, they contribute nothing to the clothing pilot, and they live in files
another developer is modifying daily. Ownership of those three is unresolved at
the time of writing; if they return to this work, that is a separate record
appended later rather than an edit to this one.

**A4 is larger than "wire up the existing service".** `PromotionsService` is CRUD
only and the evaluator exports one function answering whether a promotion is
inside its schedule window. There is no discount calculation anywhere; it must be
built.

#### Discounts do not stack

**A manual line discount overrides any promotion on that line.** Manual discounts
carry role-based approval limits; a promotion stacking on top would take the total
past a figure nobody approved, and the approval would be for one number while the
customer paid another.

`stackable` continues to govern promotion-against-promotion. The override is per
line, not per basket.

#### Not in scope

QuickBooks for retail tenants · multi-branch inventory, transfers and branch
management · price-band tax · schema-per-tenant · migrating Simply POS data,
which is a reference implementation only.

`ModuleKey.EXCHANGES` remains as D2 left it — a reserved key with an A4 document
renderer and no transaction. The retail template builds that transaction; until it
lands, D2's instruction stands and exchange behaviour must not be represented as
implemented.

> **Superseded 2026-09-07 by [D128b](#d107b).** The transaction landed in Phase 7.
> The caveat is lifted; read D128b for what "implemented" does and does not mean.

---

## 2026-08-31 — Stock authority for a product with variants

### D121 — stock is tracked by variant id, not product id

**Direction (supervisor, 2026-08-31):** *"Stock should be tracked by product variant
id, not product id."*

`BranchInventory` already keys on `(branch, product, variant?)` per D44, and both the
write path (1a) and the per-variant read (1b.1) obeyed this. The **item-level read**
did not: `sellable.service` set `availableQuantity` and `stockState` from
`Product.quantityOnHand`.

That column is the D10 rollup mirror. It is maintained on sale and receipt, so it is
not abandoned — but it is a mirror, and it can drift. It was observed reading
`350.000` for a product whose four variants held 22 units between them, and the till
showed the 350.

**Decided.** For a product with `hasVariants` and at least one active variant, the
item level is **derived from the variant rows**:

- `availableQuantity` — the **sum** across sizes. Deliberately not `null` as `sku` and
  `unitPrice` are for a variant parent: those are null because using them would be
  *wrong* (a sale at the parent price is a financial error, a parent-SKU scan is
  ambiguous), whereas a total misleads nobody once nothing caps by it. The sell cap is
  `stockCap(product, variant)`, which asks the chosen size.
- `stockState` — `OUT` only when every size is out; `LOW` when no size is `IN_STOCK`,
  each size measured against **its own** reorder point.

`Product.quantityOnHand` keeps its D10 role for variant-less products and QuickBooks
caching, and is still mirrored on write. It is simply **not read** for a product that
has variants.

The derivation lives on the **server** (`aggregateVariantStock`, beside `stockStateFor`
in `common/stock-state.ts`), not in the till. D31 makes the server the authority, and
the alternative put the same rule in `pos-retail-checkout` and `quotation-builder` —
two copies of one threshold rule, which is how two screens come to disagree.

Not gated on `capabilities.catalogue.variants`: that capability governs whether a
client is *shown* the sizes. How much stock exists is not a display question.

No migration. Read-model behaviour only.

---

## 2026-09-01 — Applying the RETAIL enum migration

### D120a — `RETAIL` is added in its own migration, and used in a later one

**D120 already authorises this migration.** It says in terms that
`ALTER TYPE … ADD VALUE` is additive and that the record "needs none of the
destructive-migration exception D57 had to carve out". Nothing here re-authorises
it. This entry records **how** it must be applied, because getting that wrong
fails at apply time rather than at review.

#### The constraint

PostgreSQL is 16.14. Since PG 12, `ALTER TYPE … ADD VALUE` may run inside a
transaction block — but **the new value cannot be used in the same transaction
that adds it**. Prisma wraps each migration in a transaction, so a single
migration that adds `RETAIL` and then references it (a seed, a backfill, a
`DEFAULT`, a check constraint, a partial index predicate) fails with
*"unsafe use of new value of enum type"*.

The failure is not a data risk — the transaction rolls back — but it strands a
migration in a failed state that every developer then has to resolve by hand.

#### Decided

**Two migrations, in order:**

1. **`add_retail_business_type`** — `ALTER TYPE "BusinessType" ADD VALUE 'RETAIL';`
   and nothing else. No seed, no backfill, no constraint mentioning the value.
2. **Anything that uses `RETAIL`** — a separate, later migration.

**Written with `IF NOT EXISTS`**, following the closest precedent in this repo —
the D44 variants migration (`20260812000000`), which uses
`ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'RECEIPT'`. The older
auto-generated form (`20260709145818`, `PaymentMethod` → `'QR_PAYMENT'`) omits
it. Both work; the explicit form is chosen because it is re-runnable against a
database where the value already exists, which is the state a developer lands in
after a partially-resolved migration.

Verified on the project's own PostgreSQL 16.14 rather than assumed:

```
BEGIN; ALTER TYPE t ADD VALUE IF NOT EXISTS 'B'; INSERT INTO … VALUES ('B'); COMMIT;
  ERROR:  unsafe use of new value "B" of enum type
  HINT:   New enum values must be committed before they can be used.

-- split across two transactions: succeeds
-- re-running the ADD VALUE:  NOTICE: enum label "B" already exists, skipping
```

#### Ordering within the enum

`RETAIL` is appended, not positioned with `BEFORE`/`AFTER`. Enum ordinal order is
not a display order anywhere in this codebase — the console picker sorts by
`DomainDescriptor.template.order` (D55), and `BUSINESS_TYPE_VALUES` is used for
validation messages, not ranking. Appending keeps the migration a pure addition.

#### What this does not do

Adding the value **puts no card in the console picker** and creates no template.
`WORKSPACE_TEMPLATES` filters `DOMAIN_REGISTRY` through the hand-maintained
`OFFERED_TEMPLATE_KEYS` allowlist, and `DOMAIN_REGISTRY` is total over
`BusinessType` — so the enum value without a descriptor is a **compile error**,
by design (D56).

Practical consequence: the migration and the descriptor land together or the
build breaks. That is the intended pressure, not an obstacle to work around.

---

## 2026-09-02 — Phase 3 tax: scope, and backwards compatibility

### D122 — per-line tax snapshots; per-category rates wait for grocery

Tech Lead, 2026-09-02. Supersedes nothing; narrows the Phase 3 scope D120
authorised.

#### What D120 said, and what changed

D120 authorises "per-category and global tax, no price bands, displayed
tax-inclusive". Building it was scoped as `TaxRate` and `TaxRule` tables with a
resolution hierarchy.

Two facts, established by reading the code rather than the plan:

1. **The flat-rate engine already works for retail.** `computeDocumentTotals` is
   shared by sales, quotations and restaurant (D59). Setting a tenant rate on a
   clothing workspace and selling produced `1,850 → 333 tax → 2,183` with no code
   written.
2. **Per-category rates are a grocery requirement, not a clothing one.** Zero-rated
   staples beside standard-rated goods is what forces a hierarchy. Clothing is
   uniformly standard-rated, and grocery is parked pending a customer (open
   decision 12).

#### Decided — option B

Phase 3 narrows to what the clothing pilot needs and what is correct regardless:

- **No `TaxRate` / `TaxRule` tables.** The flat rate stays.
- **Three additive columns** (below).
- **Returns stop prorating** and read the per-line snapshot.
- **Receipts show a tax breakdown.**

Per-category resolution moves to sit **with grocery**, where the requirement
lives. It stays cheap to add later: the columns below are the hard part, and a
resolution service writes into them.

The deciding argument is not effort. Building a rate hierarchy means surgery on
the one engine all three templates share, for a capability the clothing pilot
cannot demonstrate — and this branch has just spent a day proving it does not
break the restaurant and hardware teams (2.15). Guessing at a grocer's categories
before a grocer exists is the same mistake refused for grocery attributes.

#### The three columns

| Table | Column | Type |
|---|---|---|
| `Product` | `taxable` | `Boolean @default(true)` |
| `SaleItem` | `taxRatePercent` | `Decimal? @db.Decimal(5, 2)` |
| `ReturnItem` | `taxRatePercent` | `Decimal? @db.Decimal(5, 2)` |

No new tables, no enum, no backfill. One migration — **D120a's two-migration rule
does not apply**, being scoped to `ALTER TYPE … ADD VALUE`, and nothing here adds
an enum value.

#### Why `taxable` defaults to TRUE

**Because it is already true of every product in the system.** There is no
per-product exemption anywhere today; tax is one rate on the whole bill, so every
product is taxed. The column writes down the existing fact rather than changing
it.

A default of `false` would assert that every product in every tenant is exempt.
The moment anything read it, a restaurant selling a Rs 2,000 meal would charge
**Rs 0 tax instead of Rs 360** — silently, across every tenant.

The name misleads, which is why this is recorded: `taxable = true` reads as
*turning tax on*. It means *this product is subject to whatever rate the tenant
has configured*, which for a tenant configured at 0% is still zero.

In the first step neither default changes behaviour, because nothing reads the
column. `true` matters later, and later it means "carry on exactly as before".

#### Why the rate snapshots are NULL, not 0.00

**`0.00` means zero-rated. `NULL` means no rate was recorded.** They are different
facts and the distinction is load-bearing.

Defaulting to `0.00` would claim every historical sale was zero-rated, and a
return against one would refund no tax at all. With `NULL`, the returns path reads
"this line predates per-line tax" and falls back to today's proportional method —
so **every existing sale keeps refunding exactly as it does now**.

This follows `RestaurantBranchConfig.taxRatePercent`, nullable for the same stated
reason: *"0 is a meaningful rate and must be distinguishable from unset"*.

#### Why returns must stop prorating

`returns.calc.ts` refunds tax as `saleTax × (line's share of the taxable base)`.
That is correct **only** while one rate covers the whole bill, and its own comment
says so: *"Tax was a flat rate on the sale's taxable base."*

The moment rates differ per line it is wrong:

> Rice (0%, Rs 1,000) and soap (18%, Rs 1,000). Total tax Rs 180. The customer
> returns the rice. Proration refunds `180 × (1000/2000)` = **Rs 90 of tax on a
> zero-rated item.**

`SaleItem.taxRatePercent` is what makes the correct answer reachable, and
`ReturnItem.taxRatePercent` records what was reversed so a credit note is
self-contained and a later rate change cannot alter a past refund. Copied from the
sale line, never re-resolved — the rule 1a.20 established for variants.

#### Backwards compatibility

Nothing reads the new columns in the schema step. It ships **inert**, the pattern
`RestaurantBranchConfig.taxRatePercent` used: *"No UI yet, deliberately; the column
and fallback ship first."*

| Domain | Effect |
|---|---|
| Restaurant | none — `taxable` true is today's behaviour, rate columns null and unread |
| Hardware | none |
| Retail | none until the resolution logic lands |

---

### D123 — promotions allocate per line, frozen at sale time

Tech Lead, 2026-09-03. Supersedes nothing; scopes Phase 4 (audit item **A4**).

#### The question

Phase 4 builds the discount engine — the models, the four types and the schedule
exist, but nothing turns a promotion into money. Before writing the applier, one
question had to be answered: **where does a promotion discount live**, and how is
it reversed when part of the sale comes back?

Two candidates. Bake it into the line, the way a manual discount already works;
or hold it as an order-level figure with its own proportional allocation, the way
the storewide order discount works.

#### Decided — per line, baked into `lineTotal`, frozen at sale time

A promotion reduces the line it applies to. The amount is computed **once, when
the sale is written**, and never re-derived afterwards. A return reverses it by
the same `× frac` scaling the per-line manual discount already uses.

**Returns allocate; they do not re-evaluate.** Returning one item of a "2 for 1"
does not recompute the basket as though the promotion never qualified. This
follows D122's returns rule directly — *"allocation, not recomputation: a return
can never refund a different amount of tax than the sale charged"* — and extends
it from tax to promotions.

#### Why not the order-level shape — the argument that decided it

Two shirts at 1,000 and a tie at 500, tie free under buy-two-get-one. The
customer pays **2,000** and returns the tie.

Allocating the 500 saving order-wide by line value gives the tie a weight of 500
against the shirts' 2,000, so the tie absorbs 100 of it:

    refund = 500 (its subtotal) − 100 (its share) = 400

**Rs 400 refunded on an item the customer paid nothing for.**

That is the same defect D122's `3.11` removed — refunding tax on a zero-rated
line — with the same cause: a basket-wide proportional allocation applied to a
saving that was never basket-wide. A BOGO discount belongs to the free *item*,
not to the basket by value.

Per line, the tie carries `promotionDiscountAmount = 500` and `lineTotal = 0`, so
the refund is `500 − 500 = 0`. Correct, with no special case.

#### Composition order

    unit price × quantity
      → line discount   (manual OR promotion — never both, see the invariant)
      → order discount  (computed on the subtotal AFTER the above)
      → tax             (on the base narrowed by `Product.taxable`, D122)

A promotion therefore **does** reduce the base a storewide order discount is
computed against. This needs no new logic: `sales.service` already resolves the
order discount against `subtotal − totalDiscount`, so a promotion inside that
rollup is inside the base by construction.

#### The invariant: manual and promotion are mutually exclusive per line

A manual line discount **overrides** any promotion on that line, so at most one of
`discountAmount` and `promotionDiscountAmount` is non-zero on any line. Enforced
in the applier and pinned by test, not by a database constraint — the repository
uses neither CHECK constraints nor triggers, and a rule that lives in one place in
code is easier to prove than one split across both.

Why manual wins: a cashier discounting is acting deliberately, usually under a
role-based approval limit the system enforces. An automatic promotion stacking on
top would push the total past a figure nobody approved.

#### Bundle allocation

`BUNDLE_FIXED_PRICE` spans lines, so its saving is distributed **proportionally to
gross line value, with the largest-remainder method for the final cent**. The
distribution happens inside the applier, once, at sale time, and is then frozen —
so the printed rows sum to the printed total and a later reader never re-divides
it differently.

This is the same reasoning that put the tax breakdown's remainder on the largest
row rather than letting four renderers each round independently.

#### The four columns

| Table | Column | Type |
|---|---|---|
| `SaleItem` | `promotionDiscountAmount` | `Decimal @default(0) @db.Decimal(12, 2)` |
| `SaleItem` | `promotionId` | `String?` |
| `SaleItem` | `promotionNameSnapshot` | `String?` |
| `ReturnItem` | `promotionDiscountAdjustment` | `Decimal @default(0) @db.Decimal(12, 2)` |

All additive, all defaulted or nullable, no backfill, no table rewrite. They ship
**inert** — nothing reads them until the applier lands.

`promotionNameSnapshot` exists because a promotion can be renamed or deleted after
the sale, and a reprinted receipt must still name what the customer was given.
That is D44's snapshot rule applied unchanged.

**`promotionDiscountAmount` is a mirror, not the authority.** `lineTotal` is
already net of it and is what tax and returns read. The column exists so a
promotion is separately reportable in Phase 8 without a second source of truth —
the same relationship D121 records between `Product.quantityOnHand` and the
per-variant rows.

#### What this buys with no further work

- **Tax follows automatically.** `taxableBase` reads `lineTotal` (D122, 3.14), so
  a promoted line is taxed on what the customer actually pays.
- **The returns denominator stays correct.** `computeReturnLine` derives its
  order-discount base from `sale.subtotal − sale.totalDiscount`, and the promotion
  is inside `totalDiscount`.
- **The till and the server agree**, provided the applier lives in
  `@hardware-pos/shared` and both call it — the rule 3.14 was written to enforce.

#### What this deliberately does not solve

**Bundle breaking.** Return one shirt from a buy-two-get-one and the customer
keeps a free tie, having paid for one shirt. The shop absorbs the difference.

Re-evaluating the basket would recover it, but the refund would then depend on the
order items came back in, could be zero, and could produce a debt — a customer
being told they owe money on a return. We take the loss by default. If the
business wants protection it must be an **explicit rule an operator can see** —
refusing or flagging a partial return that breaks a bundle — never a silent
recomputation.

#### Restaurant impact: none

`ProjectedSaleItem` carries only the fields it lists, so restaurant settlements
write none of these columns and take the defaults — the same mechanism that leaves
`taxRatePercent` null there (3.16). Additive and nullable only; no reader may
assume non-null on `SaleItem`.

---

### D124 — `PROMOTIONS` is its own module key

Tech Lead, 2026-09-03. Corrects the D45 hotfix; unblocks Phase 4 for retail.

#### What was wrong

`/promotions` was gated on `MENU_MANAGEMENT`, a **food-service** module. A retail
tenant has no such module, so the Promotions screen answered **"Feature not
available"** — after Phase 4 had built the entire discount engine behind it.

The controller predicted this in its own docblock:

> Gated on `INVENTORY` because … `INVENTORY` is the one module that BOTH
> Restaurant and Retail tenants carry by default. **Restaurant-only modules like
> `MENU_MANAGEMENT` would refuse Retail's later use of promotions.**

A later "D45 hotfix" changed the gate to `MENU_MANAGEMENT` anyway, because
restaurant tenants turned out **not** to carry `INVENTORY`. The hotfix fixed food
service and caused exactly the failure the docblock warned about. Phase 4 is
"Retail's later use of promotions".

#### Why neither existing module works

Verified against the module sets rather than assumed:

| Set | Members |
|---|---|
| `SHARED_CORE_MODULES` | `CUSTOMERS` `REPORTING` `USERS` `BRANCHES` `SETTINGS` `BRANDING` |
| `RETAIL_MODULES` | `RETAIL_POS` `INVENTORY` `QUOTATIONS` `RETURNS` `EXCHANGES` `SUPPLIERS` `QUICKBOOKS` |
| `FOOD_SERVICE_MODULES` | `MENU_MANAGEMENT` `DINING` `TABLE_MANAGEMENT` `TAKEAWAY` `KITCHEN` `RESERVATIONS` |

`INVENTORY` is retail-only. `MENU_MANAGEMENT` is food-service-only. **No module
common to both governs a catalogue admin surface**, so every choice among the
existing keys refuses one tenant type. Accepting either module would encode the
confusion rather than resolve it, and would leave the next reader unable to say
what actually gates the screen.

#### Decided

**A dedicated `PROMOTIONS` module key**, in both default sets.

Promotions are not a food-service feature that retail borrows, nor an inventory
feature: they are their own admin surface that both templates own. The key says
so, and a gate that names the thing it protects needs no comment explaining why
it names something else.

| Change | Where |
|---|---|
| `PROMOTIONS` added to the `ModuleKey` enum | `schema.prisma` + migration |
| …and to `MODULE_KEY_VALUES` | `packages/shared/src/types/platform.ts` |
| Added to `FOOD_SERVICE_MODULES` | `domains/modules.ts` |
| Declared on the RETAIL descriptor, **not** on `RETAIL_MODULES` | `domains/retail.domain.ts` |
| `@RequireModule(ModuleKey.PROMOTIONS)` | `promotions.controller.ts` |

#### Why retail declares it and food service does not

`HARDWARE` composes its default set from `RETAIL_MODULES`, and
`platform.constants.spec` pins that set as **byte-equal to
`LEGACY_TENANT_DEFAULTS`** — the modules a tenant with no business profile falls
back to. Adding `PROMOTIONS` there would silently widen another team's template
and the legacy fallback with it, so the RETAIL descriptor declares the module
instead and `RETAIL_MODULES` is untouched.

`FOOD_SERVICE_MODULES` has no such equality test and food service **must** gain
the key, because regating the controller would otherwise take away a screen they
have today.

**Hardware is left as it was, deliberately.** It never had a working Promotions
screen either — the D45 hotfix gated it on `MENU_MANAGEMENT`, which hardware also
lacks — so this changes nothing for them. Whether they want it is theirs to
decide; a `TenantModule` row enables it per tenant in the meantime.

#### No backfill, and no tenant loses the screen

`resolveModules` composes the default set for the business type and **adds**
explicitly-enabled rows; an explicit row only ever wins as a *revocation*. Its own
docblock states the consequence: *"a tenant created before a new module shipped
picks it up without a data migration."*

Checked against live data rather than trusted: of five tenants, four carry no
`TenantModule` rows at all and one carries twelve. All five gain `PROMOTIONS`
from the default set, because none of them has an explicit `isEnabled: false` for
a key that did not exist until now.

#### Migration shape

One statement, `ALTER TYPE "ModuleKey" ADD VALUE IF NOT EXISTS 'PROMOTIONS'`.
D120a's two-migration rule is about **using** a new enum label in the transaction
that adds it; nothing here writes a row with the new value, so one migration is
correct. `IF NOT EXISTS` follows the D44 and D120a precedent.

#### What this does not change

Food service keeps its promotions screen — it gains `PROMOTIONS` in the same
change, so the hotfix's fix is preserved rather than reverted. No route, screen or
permission moves; only the module that names the gate.

---

## D126 — a cart-level promotion is an order discount, not a line discount

**Status:** accepted, 2026-09-04. Supersedes nothing. Extends D123.

### The requirement

`FIXED_AMOUNT_DISCOUNT` could only ever mean *"Rs 1,000 off these products"*:
`validateTypeShape` demanded at least one `BUY` item, and `applyFixedAmount`
spread `amountOff` across those products' lines. The requirement is the other
reading — *"Rs 1,000 off the cart once it reaches Rs 10,000"* — which the model
could not express at all. There was no threshold column, and no way to say
"applies to the whole basket".

### The decision

Two shapes of the same promotion type, told apart by whether it names products:

| `items` | Meaning | Where the discount lands |
|---|---|---|
| non-empty | *"Rs X off these products"* — unchanged | the participating **lines** |
| **empty** | *"Rs X off the cart"* — new | the **order** |

`Promotion.minimumSpend` is the threshold. NULL means none, which is what every
row predating this decision means, so the backfill is to do nothing.

### Why the order level, and not `SaleItem`

`SaleItem` holds a single `promotionId` (D123). A cart-level promotion has to
coexist with the line-level promotions that already claimed those lines, so
allocating it onto lines would either need a second promotion column per line or
would displace a line promotion that is already correct.

The order level already solves this exact problem for the **manual** order
discount — `Sale.orderDiscountAmount` with `Return.orderDiscountAdjustment`
allocating it back on a refund. A cart-level promotion is the same shape, so it
gets the same treatment rather than a new mechanism:

```
Sale.promotionOrderDiscountAmount   +  promotionOrderId  +  promotionOrderNameSnapshot
Return.promotionOrderDiscountAdjustment
```

Kept **separate** from the manual columns rather than folded into them: a refund
has to be able to say which part of a discount was the cashier's decision and
which was automatic, and `orderDiscountApprovedById` beside the manual figure
means something that would be a lie next to a promotion.

Like D123's line columns, `promotionOrderId` carries **no foreign key** and the
name is snapshotted, so deleting a promotion never rewrites a document that has
already been sold.

### At most one cart-level promotion per sale

There is one set of columns, so the applier picks the single best eligible
cart-level candidate. This is a real limit, stated rather than hidden: a second
concurrent cart-level promotion would need a child table and its own decision.
Line-level promotions are unaffected — any number still apply, one per line.

### What the threshold measures

The **eligible net amount**: line subtotals less any line-level promotion, summed
over lines that carry no manual discount.

- *Net, not gross* — the threshold is compared against the money this discount
  would actually reduce. Measuring gross would let a heavily discounted basket
  clear a threshold it no longer reaches.
- *Excluding manually discounted lines* — D123 already makes such a line
  invisible to promotions. A threshold that counted it would be counting money
  no promotion is allowed to touch.

The discount is capped at that same amount, so a cart-level promotion can never
drive an order below zero.

### Evaluation order

Line-level promotions resolve first, then the cart-level pass runs against what
they left. That is what makes the threshold well-defined, and it is why a
cart-level promotion is **never discarded because a line was claimed** — it does
not compete for lines at all.

Basket exclusivity (4.4) still governs it: a non-stackable promotion that has
taken the basket blocks the cart-level pass too, and a non-stackable cart-level
promotion will not join something already applied.

### Tax is not touched

Confirmed with the PO. The cart-level discount reduces the order total **after**
tax is computed on the line totals, exactly as the manual order discount has
always done (3.14). `Rs 12,600 → Rs 1,000 off → Rs 11,600`. No tax-base change,
no new tax path, one code path for both order-level discounts.

### A cart-level promotion never requires a promotional product

`rewardEntitlements` only produces an entitlement for a rule carrying a `GET`
item, and `buyXGetYOutcome` returns null for any type other than `BUY_X_GET_Y`.
So `FIXED_AMOUNT_DISCOUNT` — either shape — cannot create an outstanding reward
and cannot block payment. That was already true and is now pinned by test.

### BOGO qualifying units are not consumed

Also confirmed with the PO, and recorded here because it was previously implicit.
`applyBuyXGetY` claims only its **reward** lines; the BUY units that earned the
reward stay available to other stackable promotions. Two shirts may take a
percentage discount *and* earn a free tie.

The consequence is deliberate and worth stating plainly: a unit can be counted by
more than one promotion — a shirt inside a bundle can also count toward a BOGO
threshold. That is the intended generosity, not an accounting error; each line
still carries exactly one promotion, so every figure remains persistable and
refundable.

---

## D125 — the option library, SKU generation, and what to do about the barcodes

**Status:** proposed, 2026-09-04. Covers Phase 5 steps 1-4. Blocks `5.1`.

Every figure below was measured against the pilot database on 2026-09-04, not
estimated. The catalogue is small (6 retail products, 48 variants), which makes
the findings *more* alarming rather than less: the drift the plan predicted at 400
products is already present at six.

---

### Part 1 — A tenant-level option library, ADDED BESIDE the per-product dimensions

#### The evidence

`ProductVariationDimension` is keyed `@@unique([productId, name])` — a dimension
belongs to one product. With six products the catalogue already contains:

| Dimension name | Products defining it separately |
|---|---|
| `Colour` | 4 |
| `Color` | 1 |
| `Size` | 6 |

Two spellings of one concept, and `Size` defined six times over five different
option sets (`1-4 inch`, `30/32/34/36`, `S/M/L/XL`, `XS/M/L`, `13½/15½`). Worse,
`Colour :: Black/Blue/Red` and `Color :: Black/Blue/Red` are the *same set*
spelled two ways. Nothing in the model can see that they are the same, so nothing
can group by colour, filter by size, or generate a stable SKU segment.

#### The decision

Introduce `AttributeDefinition` and `AttributeOption`, scoped to the **tenant**:

    AttributeDefinition   (tenantId, name)        unique per tenant
    AttributeOption       (definitionId, code)    unique within a definition
                          + `name`, `position`

and give the existing per-product rows an OPTIONAL link to them:

    ProductVariationDimension.attributeDefinitionId  String?
    ProductVariationOption.attributeOptionId         String?

**Additive, not a promotion of the existing tables.** The alternative — moving
`ProductVariationDimension` to tenant scope by dropping `productId` — rewrites the
key that `ProductVariantOptionValue` already points at, on live variant data, and
would have to run in the same migration as the backfill. This way the library can
be populated, reviewed and corrected by an operator *before* anything depends on
it, and a product that never adopts it keeps working exactly as it does now.

**`code` lives on the option, not the dimension.** It is what SKU generation
consumes (`BLK`, `30`, `XL`), and it is the reason the library exists at all:
`Colour/Black` and `Color/Black` cannot produce one SKU segment while they are two
unrelated rows.

**Migration of existing data is a UI task, not a SQL task.** Eleven dimension rows
across two tenants is small enough for an operator to map by hand, and the
`Colour`/`Color` decision is a judgement nobody should make in a migration script.
The link column stays nullable so the mapping can be done incrementally.

---

### Part 2 — SKU generation reuses `DocumentSequence`

#### The decision

`<CATEGORY>-<SEQ>[-<OPTION CODE>…]`, generated by default and overridable, unique
per tenant. The sequence comes from the existing `DocumentSequence` table with a
new `docType` of `SKU`:

    DocumentSequence  @@id([tenantId, docType])
    nextDocumentNumber(tx, tenantId, 'SKU')   -- INSERT … ON CONFLICT … RETURNING

**No new table and no new concurrency design.** That function is already the
repository's answer to "two tills allocate a number at the same moment", proven by
sale, return, quotation, table-session and restaurant-order numbering. Inventing a
second mechanism for SKUs would be a second thing to get wrong.

**Gaps are accepted.** `nextDocumentNumber` increments inside the transaction, so a
rolled-back product creation burns a number. A gap-free sequence would need a lock
held across the whole create, which is exactly the contention the existing design
avoids. A SKU is an identifier, not an audit trail; nobody counts them.

**Uniqueness is already enforced.** `ProductVariant.sku` carries
`@@unique([tenantId, sku])` today, so a generated SKU that collides with a
hand-typed one fails at the database rather than silently duplicating. Generation
retries on collision rather than assuming the sequence is enough.

---

### Part 3 — Barcodes: the constraint is safe, the existing values are not

#### Measured, not assumed

    48 variants   20 with a barcode   28 null   0 empty strings
    duplicates within a tenant:  NONE
    duplicates across tenants:   NONE
    every barcode: 13 digits, numeric, prefix 2001 or 2990

So `@@unique([tenantId, barcode])` can be added **cleanly, with no remediation
step and no backfill**. That was the open question blocking this record, and the
answer is that there is nothing to clean up.

#### The finding that was not expected

**18 of the 20 existing barcodes have an invalid EAN-13 check digit.**

The algorithm was verified against four published EAN-13 codes and three
deliberately corrupted ones before this was believed.

    2001000000015   INVALID   BRSH-1IN
    2001000000022   INVALID   BRSH-2IN-V
    2990001000000   INVALID   TSHIRT-S-BLACK
    2990001000001   valid     TSHIRT-S-WHITE   <- valid by coincidence

The two that pass do so by accident: a sequential counter lands on the correct
check digit about one time in ten. There are two different generators here
(`2001…` and `2990…`), and neither computes a check digit.

**Why it matters.** These are 13 numeric digits beginning with `2`, which is the
GS1 range reserved for in-store use — so the *prefix* choice is right. But any
scanner or label renderer that validates the check digit will reject them, and a
`EAN-13` barcode image cannot even be rendered from an invalid payload. Phase 5
step 5 renders labels as `CODE128 / EAN-13`; that step would have failed on 18 of
20 rows, and the cause would have looked like a rendering bug.

#### The decision

1. **Generate barcodes with a correct EAN-13 check digit**, from
   `nextDocumentNumber(tx, tenantId, 'BARCODE')` plus a per-tenant prefix.
2. **A configurable prefix map per tenant**, set during workspace setup. The plan
   already records the sequencing constraint — *configured before any allocation,
   or the tenant reprints every label* — and this record adopts it as binding.
3. **Reissue the 18 invalid codes.** They are unprinted pilot data: 20 variants
   across two development tenants, nothing in a customer's hands. The cost is a
   backfill script now versus a label reprint later.
4. **Validate on write.** A barcode that is 13 numeric digits must carry a correct
   check digit, refused at the DTO. Supplier barcodes that are genuinely not
   EAN-13 (CODE128 alphanumerics) are accepted as-is — the rule keys on shape, not
   on origin, so it cannot reject a valid supplier code.

**Supplier vs internal stays a flag, not a separate column.** A variant carries one
barcode; where it came from is provenance. `barcodeSource: SUPPLIER | INTERNAL`
answers "may I regenerate this?", which is the only question the system actually
asks of it.

---

### What this does not decide

- **Label geometry** (step 6) — the settings blob is JSON and already scoped
  `(tenantId, branchId)`, so it needs no migration and no decision.
- **Label rendering** (step 5) — a new `PrintJobType` on the existing queue. Blocked
  on Part 3 being done first, for the reason above.
- **Whether `Colour` or `Color` wins.** An operator's call, made in the UI.

---

## D125a — two nullable columns D125 did not model: `categoryId` and `swatchHex`

**Status:** accepted, 2026-09-07. Extends [D125](#d104), supersedes nothing.
Ships with the `5.1` migration.

D125 modelled `AttributeDefinition (tenantId, name)` and
`AttributeOption (definitionId, code, name, position)`. Two requirements that
are already written down elsewhere have no home in that shape, and both cost
nothing today and a migration over live variant data later.

### 1. `AttributeDefinition.categoryId String?` — bind a scale to a category

`04-format-packs.md` §3 is explicit: *"Bind scales to categories so Footwear
offers 24–46 and Apparel offers XS–XXXL. This is the one idea worth taking from
Simply POS, and it is what makes a 400-product catalogue tractable."*
`PROGRESS.md` carries it into the step itself — `5.1` reads *"tenant-level
attribute/option library, **category-bound**"*. D125's model has no category,
so the requirement had nowhere to be written.

**Nullable, and a BINDING HINT rather than identity.** An unbound definition
(`Colour`) applies to every category; a bound one (`Size — footwear`) is what
the picker offers under Footwear. The hint narrows what a screen suggests; it
never decides what is legal, so a product may still adopt any definition.

**`categoryId` is deliberately NOT in the unique key.** `@@unique([tenantId,
name])` stands exactly as D125 wrote it. Adding the category would look more
correct and would be wrong: Postgres treats NULLs as distinct in a unique
index, so `(tenantId, NULL, 'Size')` is insertable twice and the library
silently re-acquires the duplication it exists to remove. Two scales therefore
carry two names — which is how `04-format-packs` §3 already writes them, in the
same table that asked for the binding.

**`ON DELETE SET NULL`.** Deleting a category unbinds its scales; it does not
delete a library other categories may also be using. Cascade here would let a
routine category tidy-up destroy the `Size` scale every apparel product points
at.

### 2. `AttributeOption.swatchHex String?` — the colour picker's swatch

`04-format-packs.md` §3 asks for it by name: *"Colour — named values with a
swatch. `swatchHex` for the picker."*

**Nullable, because only a colour scale has one** — `Size :: XL` has no colour —
and because a colour with no swatch yet is still a usable option. `#RRGGBB`,
validated at the DTO against a shared pure function so the server's rule and
the form's live preview cannot drift apart, which is the `4.15` / `4.21` /
`4.22` failure this phase is explicitly guarding against.

**A hex string, not a named palette.** A palette would be a third table to
seed, migrate and localise, and it would still have to answer "what if the
shop's teal is not our teal". The picker needs a colour to draw; the shop
already knows which one.

### Why both now rather than when they are consumed

Neither field has a consumer in `5.1`. Both are added anyway, because the
alternative is a second migration over `AttributeOption` rows that products,
variants and generated SKUs will by then depend on. Two nullable columns in a
table that is empty on the day it ships cost one line of SQL each; the same two
columns after `5.3` cost a coordinated deploy. This is the same reasoning D123
used to ship `4.1`'s four columns inert, three steps before anything wrote to
them.

### What this does not change

- **D125 stands unamended.** The additive shape, the nullable links, the
  `DocumentSequence` decision for SKUs, and all three barcode findings are
  untouched. D125a adds two columns to the tables D125 defined.
- **Whether `Colour` or `Color` wins** is still an operator's call in the UI.
- **Category binding is not enforcement.** Nothing refuses a product that
  adopts a scale bound to another category; `5.1` ships the column and the
  picker hint, not a rule.

---

## D127 — a label print job has no sale, so `PrintJob.saleId` becomes nullable

**Status:** accepted, 2026-09-07. Required by Phase 5 step `5.7`. Touches a
table the restaurant and hardware modules both write to, which is why it gets a
record rather than riding along inside the step.

### The problem

The Phase 5 plan says label rendering is *"a new `PrintJobType` on the existing
queue, reusing the existing print-job queue and print agents"*. That reuse is
right — the queue, the agent polling, the `PENDING → PRINTED → FAILED`
lifecycle and the retry behaviour all already exist and are in production use.

But `PrintJob.saleId` is `String`, **required**, with a cascading FK to `Sale`.
Every job the system has ever created belongs to a sale: a customer receipt, a
warehouse picking slip, a return receipt. A sheet of shelf labels belongs to no
sale at all — it is printed from the catalogue, often for stock that has not
been sold and may never be.

### What was rejected

**A separate `LabelPrintJob` table.** It would duplicate the status lifecycle,
the agent's polling query, the retry logic and the print-agent registration —
four things that are correct today and would then exist twice. The second copy
is where they drift. This is the same argument D124 made for `PROMOTIONS` and
the same one D125 Part 2 made for reusing `DocumentSequence`.

**A synthetic sale.** Inventing a `Sale` row so a label job has something to
point at would put fictional rows in the table every report, every Z-reading and
every tax reconciliation reads. Not seriously considered, recorded so nobody
proposes it later.

### The decision

1. **`PrintJob.saleId` becomes `String?`**, FK `ON DELETE CASCADE` unchanged for
   the rows that have one.
2. **`PrintJobType` gains `PRODUCT_LABEL`.**
3. **No existing row changes.** Every current job keeps its `saleId`; the column
   simply stops being mandatory for new kinds of job.

### Why this is safe for the restaurant and hardware modules

Measured against the code, not assumed:

- Every existing writer — `receipts.service`, `returns.service` — passes a
  `saleId` and continues to. Nothing about their behaviour changes.
- Every existing reader filters by `saleId` **optionally**
  (`QueryPrintJobsDto.saleId?`), so a job without one is simply not returned by
  a sale-scoped query. That is the correct answer, not a gap.
- Widening a column from `NOT NULL` to nullable cannot fail on existing data and
  cannot lose any.

The one real risk is a consumer that reads `job.saleId` and assumes a string.
The compiler names every such site the moment the client is regenerated, which
is the check that makes this a safe widening rather than a hopeful one.

### What this does not decide

- **Label geometry** — `5.8`, and it needs no migration: the settings blob is
  JSON and already scoped `(tenantId, branchId)`.
- **Whether a label job is branch-scoped.** It inherits whatever the queue
  already does. If shelf labels turn out to need a branch the queue does not
  carry, that is a separate change with its own evidence.

---

## D125b — a correction to D125 Part 2: a rollback does not burn a sequence number

**Status:** accepted, 2026-09-07. Corrects one factual claim in
[D125](#d104) Part 2. **The decision D125 made is unchanged**; only its stated
reason was wrong.

### What D125 said

> **Gaps are accepted.** `nextDocumentNumber` increments inside the transaction,
> so a rolled-back product creation burns a number.

### What is actually true

Measured during `5.3`, against a real Postgres, in
`sku-generation.spec.ts`:

A rolled-back batch burns **nothing**. `nextDocumentNumber` is an
`INSERT … ON CONFLICT DO UPDATE … RETURNING` executed inside the caller's
transaction, so it rolls back exactly like every other statement in it. In the
observed case the `DocumentSequence` row did not even survive at zero — it was
never committed, so the next allocation started again at 1.

The reasoning in D125 confused "increments inside the transaction" with
"increments outside the caller's control". The first is true and is precisely
why a rollback undoes it.

### Where the gaps really come from

**The collision retry.** Generation allocates a number, composes the SKU, and
finds the composed string already taken by a hand-typed one. It abandons that
number and allocates the next. The abandoned number is gone for good, and that
write commits — so this is a real, permanent gap. Asserted directly: after one
such retry the sequence sits at 2 with a single generated variant.

The same is true of `BARCODE` allocation (`5.5`), which uses the identical
mechanism.

### Why the decision stands anyway

D125 accepted gaps in order to avoid holding a lock across a whole product
creation. That trade-off is unaffected: the retry still must not reuse an
abandoned number, because a reused barcode would eventually reissue an
identifier already on a printed label. A SKU is an identifier, not an audit
trail, and nobody reconciles them.

### Why this is recorded rather than quietly fixed

The claim is load-bearing for anyone reasoning about whether these sequences can
be made gap-free. Someone reading D125 would conclude that gaps are unavoidable
because of rollbacks and stop there; the truth is that rollbacks are clean and
the retry is the only source, which is a much smaller and more tractable
surface. Both behaviours are now pinned by tests, so a future change to
`nextDocumentNumber` that made rollbacks leaky would fail rather than silently
vindicate the old wording.

### What this does not change

- The `DocumentSequence` decision itself, its concurrency argument, or the
  `SKU` / `BARCODE` doc types.
- Anything in D125 Parts 1 or 3.

---

## D125c — the barcode unique constraint already existed, and `IF NOT EXISTS` hid it

**Status:** accepted, 2026-09-07. Corrects [D125](#d104) Part 3. Found by a
`pnpm db:migrate` that failed against the developer database.

### What D125 Part 3 said

> So `@@unique([tenantId, barcode])` can be added **cleanly, with no remediation
> step and no backfill**. That was the open question blocking this record, and
> the answer is that there is nothing to clean up.

The investigation measured duplicates — correctly, and found none. It never
asked the prior question: **is the constraint already there?**

### What is actually true

It has been there since **D44**, 12 August. `20260812000000_add_product_variants_and_purchase_receipts`
creates it:

```sql
CREATE UNIQUE INDEX "ProductVariant_tenantId_barcode_key"
    ON "ProductVariant"("tenantId", "barcode")
    WHERE "barcode" IS NOT NULL;
```

A **partial** unique index. Prisma cannot express a partial index, which is
precisely why it is not declared in `schema.prisma` — the same situation as
`ProductVariant.isDefault`, whose own comment says so in as many words.

### The failure this caused

Two mistakes compounded.

**1. `@@unique([tenantId, barcode])` in the schema created permanent drift.**
Prisma models that as a FULL unique index. It sees the partial one, decides the
full one is missing, and generates a corrective migration — **on every
`migrate dev`, forever**. That is what happened: Prisma wrote a new migration
containing one `CREATE UNIQUE INDEX` and it died with `42P07 relation already
exists`, leaving a failed row in `_prisma_migrations` that blocked all further
migrations on the developer database.

**2. `CREATE UNIQUE INDEX IF NOT EXISTS` in the `5.6` migration was a silent
no-op.** `IF NOT EXISTS` keys on the NAME. The name was taken, so the statement
did nothing — and reported success. The migration appeared to work on every
database it ran against, including a from-scratch replay, because the D44
migration had already created the index the tests then observed.

**This is the hazard of `IF NOT EXISTS` on a named object:** it protects against
re-running the same statement, and it silently accepts a *different* object that
happens to share the name. It converts "this already exists differently" —
which should be loud — into "fine".

### The decision

1. **`@@unique([tenantId, barcode])` is NOT declared in `schema.prisma`**, with
   a comment recording that D44's partial index is the real constraint and why
   Prisma cannot model it. Verified: `migrate diff --from-migrations
   --to-schema-datamodel` now reports *"This is an empty migration."*
2. **The `5.6` migration is left exactly as it is.** It is already applied on
   two databases and its checksum is recorded; editing it would fail every
   future `migrate deploy` with a modified-migration error. Its index statement
   is a harmless no-op on any database, because D44 always runs first.
3. **No data or index changes.** The two forms are behaviourally identical here:
   Postgres treats NULLs as distinct in a plain unique index too, so the 28
   variants with no barcode are unaffected either way. There is nothing to
   migrate.
4. **The test now proves WHICH index does the work** — it asserts the
   `indexdef`, including the `WHERE (barcode IS NOT NULL)` predicate, and the
   raw `P2002` from the database rather than only the service's friendly 409.
   The previous assertion was `rejects.toBeDefined()`, which would have passed
   for any error at all and is why this was not caught earlier.

### The rule this leaves behind

**Before adding a constraint, check whether it exists — in the migrations, not
only in the data.** D125's investigation was thorough about the rows and silent
about the schema, and the two mistakes above are both downstream of that one
missing question.

**Prefer a plain `CREATE UNIQUE INDEX` in a migration over `IF NOT EXISTS`**,
unless the statement genuinely needs to be re-runnable. A name collision should
fail loudly at migrate time, which is the cheapest place to find it.

### What this does not change

- D125 Parts 1 and 2, D125a, D125b, and everything in Part 3 about check digits,
  the reissue pass and `barcodeSource`. Those stand unaltered.
- The measured finding that **18 of 20 pilot barcodes are invalid**. Still true,
  still the reason `5.9` exists.

---

## D128 — an exchange is a link between a return and a sale, not a third money path

**Status:** accepted, 2026-09-07. Covers Phase 7 (`7.1a`–`7.5`). Carries the
migration mandate for the `Exchange` model.

### The problem

`ModuleKey.EXCHANGES` has been a reserved key with an A4 document renderer and no
workflow since the Phase 0 audit recorded it in **D2**. It is already present in
`RETAIL_MODULES`, so a retail tenant can reach an exchange document today for a
transaction that cannot happen.

Everything an exchange needs already exists: the return path allocates promotions
per line and refunds the tax each line actually paid (D123, `3.11`), the sale path
prices and charges, stock has moved at variant grain in both directions since
Phase 1 (`1a.20`, `1c.6`), `payments` is an array and the till offers Split
Payment, and `STORE_CREDIT` is both a tender and a refund method that QuickBooks
already maps to a credit memo.

What is missing is the thing that joins them.

### The decision

**An exchange is a RETURN followed by a SALE, settled through store credit.**

```
1. Return the Medium   → refundMethod = STORE_CREDIT, value R
2. Sell the Large      → tender STORE_CREDIT for R, plus (P − R) by any method
3. If P < R            → the balance is refunded on the return leg instead
```

`ExchangeService` orchestrates and records. It computes no prices, moves no stock,
touches no tax and writes no payment of its own.

### Why it is composed rather than atomic

`ReturnsRepository` and `SalesRepository` each open their **own** `$transaction`
and neither service accepts an external one. Making an exchange atomic would mean
refactoring the two money paths that the restaurant and hardware modules both
depend on — the largest blast radius available on this branch, spent on a rare
edge.

**The failure mode is recoverable, and it is what the money already means.** If
the replacement sale fails after the return has committed, the customer holds
store credit worth exactly what they handed back. Nothing is lost, nothing is
double-counted, and the operator retries the replacement. That is also how a shop
would handle it at the counter.

**Composition is what makes it correct, not merely cheap.** A bespoke exchange
transaction would have to re-implement promotion allocation, tax snapshots, stock
movement and QuickBooks document typing — four rules that are right today. The
second copy is where they drift, which is the lesson `2.12` and `4.15` each taught
at a cost.

### The model, and why each field is shaped as it is

    Exchange
      tenantId, branchId          ownership, matching Return and Sale
      exchangeNumber              `X-000042`, from DocumentSequence 'EXCHANGE'
      originalSaleId              the sale being exchanged against
      returnId                    the return leg — REQUIRED
      replacementSaleId           the sale leg — NULLABLE
      createdByUserId
      idempotencyKey              nullable, unique per tenant

**`replacementSaleId` is nullable, deliberately.** The return commits first, so
there is a real interval in which an exchange exists with no replacement. A
required column would make the row unwritable until both legs succeeded, which
destroys the recoverable state this record just chose. Unresolved is its own
state (D28/D31), and here it is the state the operator retries from.

**No `status` enum.** The nullable `replacementSaleId` already answers the only
question anyone asks — is the replacement done? A second field encoding the same
fact is a second thing to keep in step. Added later if a real third state appears.

**No line table.** An exchange owns no lines. The returned lines belong to the
`Return`, the replacement lines belong to the `Sale`, and both already snapshot
what they need. A line table here would be a third copy of facts that are already
recorded twice, and it would be the copy nobody updates.

**`DocumentSequence` with docType `EXCHANGE`**, `X-` prefix, matching `R-` and
`S-`. Same mechanism as SKU and BARCODE in Phase 5, and the same accepted
consequence: the collision-free allocation is worth the occasional gap (D125b).

### Idempotency

`@@unique([tenantId, idempotencyKey])`, the shape `Sale` and `Return` already use.
A replayed request returns the existing exchange rather than refunding twice.
This matters more here than elsewhere: an exchange moves money in two directions,
and a duplicate would refund a customer for goods they kept.

### What this does not change

- **Nothing in Returns, Sales, Payments, Stock, Tax, Promotions or QuickBooks.**
  The orchestration calls the existing services and reacts to their results.
- **Return approval rules apply unchanged.** No exchange-specific bypass: a
  non-good-condition or over-limit return still requires approval, because the
  goods coming back are the same goods either way.
- **The replacement is priced at today's terms** — current promotions, current
  tax rate — while the returned line keeps its frozen snapshot. This falls out of
  composition rather than being chosen. A customer swapping M→L may therefore pay
  more or less than they originally did; the PO confirmed this reading.

### What this does change, outside the new model

`DocumentsService.buildExchangeDocument` hardcodes `taxAmount: 0` and passes
`showTaxColumn: false`. It was written before Phase 3 made tax per-line with
snapshots, so an exchange note would show no tax and **would not tie to the money
that actually moved**. Corrected in `7.3`, narrowly.

---

## D128a — an exchange settles GROSS, not through store credit

**Status:** accepted, 2026-09-07. Supersedes the settlement mechanism in
[D128](#d107); everything else in that record stands.

### What D128 said

> 1. Return the Medium → refundMethod = STORE_CREDIT, value R
> 2. Sell the Large → tender STORE_CREDIT for R, plus (P − R) by any method

### Why it cannot work

`ReturnsService.validateRefundMethod` refuses a store-credit refund unless the
original sale has a **saved, non-walk-in customer**:

```ts
if (!sale.customerId || sale.customer?.customerType === 'WALK_IN') {
  throw new BadRequestException(
    'Store credit requires a saved customer; convert the walk-in customer first');
}
```

That rule is correct. Store credit is a liability held against an account, and a
walk-in has no account to hold it. But **a clothing shop swapping a Medium for a
Large at the counter is almost always a walk-in**, so D128's settlement would
have failed for the common case — and only for the common case, which is the
worst kind of failure to ship.

Found by the `7.1b` tests, all nine of which failed on it. The design read
plausibly on paper and did not survive contact with an existing rule.

### The decision

**The money moves twice and nets at the drawer.**

```
1. Return the Medium   → refunded by `refundMethod`, default CASH, value R
2. Sell the Large      → paid in full by the caller's own tenders, value P
```

For an even swap the customer is handed R and pays P where R = P, so nothing
leaves their pocket and the drawer nets to zero. For an upgrade they are out
(P − R); for a downgrade they are up (R − P). The `Exchange` read model reports
`netDifference = P − R`, which is exactly what the A4 note prints as *"Balance
due from customer"* or *"Refund to customer"*.

### Why this over the alternatives

Three options were put to the PO, who chose this one.

**Rejected — exempt store credit created inside an exchange.** A narrow carve-out
in `validateRefundMethod`, on the argument that credit created and consumed in
one operation never outlives it and so is not a liability. Defensible, and about
five lines. Rejected because it changes an existing money-path rule for the sake
of a mechanism that gross settlement does not need.

**Rejected — require a saved customer for exchanges.** No code change anywhere,
but it puts a customer-creation step in front of every counter size-swap.

**Chosen — gross settlement.** It needs **no change to any existing money path**,
which was the hard constraint on this phase. It is also what actually happens
physically: the shop hands money back and takes money for a different item.

### What follows from it

- `refundMethod` is a caller field defaulting to `CASH`, passed straight to
  `ReturnsService`. Every one of its rules still applies, including the cap that
  a cash refund cannot exceed what was paid on the original sale, and store
  credit remains available for a saved customer who wants it.
- `payments` must cover the replacement **in full**, exactly as for any other
  sale. `SalesService` validates them against the total it computed; the
  exchange service asserts nothing about the money.
- The recoverable state is unchanged in substance and better in practice: if the
  replacement fails, the customer has already been refunded and the operator can
  ring the replacement up as an ordinary sale.

### A consequence worth stating plainly

**A single-line sale exchanged in full always requires manager approval.**
`Full-sale return` is an existing approval trigger, and a customer who bought one
shirt and swaps the size is returning the whole sale. D128 chose to leave return
approval rules unchanged, so this follows from that choice rather than from
gross settlement — but it is the shape most exchanges will take in a clothing
shop, and the till has to handle it. Recorded as a Phase 7 limitation.

---

## D128b — D2's "exchanges are not implemented" caveat is lifted

**Status:** accepted, 2026-09-07. Phase 7 step `7.4`. A status change, not a new
decision.

### What stood until now

The Phase 0 audit (**D2**) recorded `ModuleKey.EXCHANGES` as a reserved key with
an A4 document renderer and no transaction, and this log carried the instruction:

> `ModuleKey.EXCHANGES` remains as D2 left it — a reserved key with an A4
> document renderer and no transaction. The retail template builds that
> transaction; **until it lands, D2's instruction stands and exchange behaviour
> must not be represented as implemented.**

### It has landed

- `Exchange` model and migration — **D128**, `7.1a`
- `ExchangesService` / `ExchangesController`, `POST /exchanges` — `7.1b`
- Stock proven to move on both variants, once — `7.2`
- The A4 note rendered from a real exchange, carrying real tax — `7.3`

So the caveat is lifted, and the three places that repeated it are corrected:
the renderer's own comment, the characterisation spec's premise, and this entry.

### What "implemented" does and does not mean here

Stated precisely, because the caveat existed to stop exchanges being oversold.

**It does mean:** a completed sale can be exchanged for a different variant, the
money moves both ways and nets at the drawer, both stock figures move exactly
once, a replay cannot double-refund, and the customer can be handed a note whose
Balance Due is the figure the till actually took.

**It does not mean:**

- **Anything has been verified by hand.** The supervisor deferred manual UI
  verification to a single pass after all phases. Every Phase 4 defect that
  reached a screen was found by using the app, not by a green suite.
- **Multi-line, cross-branch, or cross-sale exchanges.** Out of scope for the
  thin slice by agreement; none is load-bearing for the phase gate.
- **That a single-line exchange is frictionless.** `Full-sale return` is an
  existing approval trigger, so a customer who bought one shirt and swaps the
  size needs a manager PIN every time. That follows from D128's choice to leave
  return-approval rules unchanged. It is the commonest shape of clothing
  exchange, and the PO may want it revisited — see D128a.

---

## D129 — A8 is handed to the restaurant team; retail adopts the rule instead

**Status:** accepted, 2026-09-07. Phase 8 step `8.1`. Amends the scope recorded
in **D120** and in `05-testing-and-governance.md` §7, which both claim A8 for the
retail template.

### What the plan assumed

The PO settled the billing audit on 2026-08-28: *"we own A4 and A8"*, and the
governance document drew a conclusion from it —

> Excluding [A2, A3, A7] means **no phase in this plan edits a restaurant file.**

**That conclusion is false for A8**, and nobody noticed because nobody opened the
file until Phase 8's pre-work.

### What is actually there

| Report service | Float-money sites |
|---|---|
| `sales/sales-report.service.ts` | 0 |
| `products/products-report.service.ts` | 0 |
| `dashboard/dashboard.service.ts` | 0 |
| `restaurant-reports/restaurant-reports.service.ts` | **15** |

**A8 exists only in the restaurant module.** Every retail report is already
`Decimal`-clean, so there is nothing on our side to fix.

### The decision

1. **A8 is handed to the restaurant team**, documented in
   `Docs/Implementation/RT-02-report-money-handover.md`.
2. **Retail adopts the rule A8 stands for**, as a tripwire over its own report
   services: no retail report may coerce a money `Decimal` to a JavaScript
   number. Mutation-proven, so a future report that reintroduces the pattern
   fails on the branch.
3. **The audit row stays OPEN.** It is not fixed, and marking it otherwise would
   be false. It has changed owner, not state.

### Why not simply fix it

Three standing constraints, any one of which is sufficient:

- The PO's *"do not touch the restaurant module"*, restated repeatedly.
- The developer's own constraint about parallel work in other repositories —
  and `fix/issues-restaurant` has commits from today.
- The governance guarantee above, which the retail branch has honoured through
  seven phases and which is worth more than one mechanical refactor.

The counter-argument — that the PO explicitly assigned A8 — is real, and is why
this is a record rather than a silent omission. The assignment was made from an
audit row, not from the file. Given the file, the assignment cannot be executed
without breaking three other commitments.

### A correction to the audit, which changes the urgency

The audit's impact reads *"Report totals will not tie out to the payment
ledger."* **Measured on 2026-09-07: they do tie out.**

| Test | Samples | Disagreements |
|---|---|---|
| Sum 2dp money, round to 2dp | 400,000 | 0 |
| Sum 3dp quantities, round to 3dp | 600,000 | 0 |
| Accumulate `0.01` ten million times | 1 | 0 |

IEEE-754 doubles carry ~15–16 significant decimal digits; summing 2dp values and
emitting a 2dp figure is exact far beyond any realistic report. The file also
contains **no division**, and D59 already permits a number boundary *"where every
engine output is a 2dp figure"*.

**Where it does break is division**, and that was measured too — an average over
`183.17, 145.76` is `164.47` exactly and `164.46` in float; three orders of
`0.615` average to `0.62` exactly and `0.61` in float. The obvious next
restaurant reports — average order value, margin percentage — are divisions.

So A8 is a **consistency defect with a real future failure mode**, not a current
mis-statement. Recorded here because handing over an overstated claim would have
cost the restaurant team an afternoon disproving it and, reasonably, some trust
in everything else we send them.

### Why the tripwire is the honest half

The PO asked retail to own A8. Retail cannot fix the file, but it can guarantee
the defect does not spread into the nine reports Phase 8 is about to write —
which is where new float money would otherwise appear. That is the part of the
assignment we can actually discharge, and it is enforced rather than promised.

### What this does not change

- **D120 stands unamended.** It claimed A4 and A8 and said why the other three
  were absent. A4 shipped in Phase 4. This record amends only where A8 is done,
  by whom, and on what evidence.
- **A2, A3 and A7 remain not ours.**
- Nothing in the restaurant module is modified by this branch.

---

## D130 — an exchange waives the full-sale-return approval, and only that one

**Status:** accepted, 2026-09-07. Supersedes one sentence of [D128](#d107).
No migration.

### What D128 decided, and why it was wrong in practice

> **Return approval rules apply unchanged.** No exchange-specific bypass: a
> non-good-condition or over-limit return still requires approval, because the
> goods coming back are the same goods either way.

Sound reasoning, and the Phase 7 tests then showed what it costs. `Full-sale
return` is an approval trigger, and **a customer who bought one shirt and swaps
the size is returning the whole sale**. So every single-line exchange — the
commonest shape in a clothing shop — demanded a manager PIN. Recorded as a Phase
7 limitation with the note *"probably not what a shop wants"*; the PO confirmed
on 2026-09-07 that it is not.

### The decision

**Inside an exchange, the `Full-sale return` trigger does not fire. Every other
trigger still does.**

The waived trigger exists because a full-sale return means the customer walks out
with the entire sale refunded and the shop holds the goods. In an exchange they
walk out with **replacement goods**, and the money largely nets at the drawer.
The condition the trigger detects is simply not present.

**Still requiring a manager, unchanged:**

| Trigger | Why it survives |
|---|---|
| Damaged / opened / defective goods | An exchange does not change what came back |
| Outside the return period | Nor how old it is |
| Cashier over their value limit | Nor who is authorised for how much |
| Refund method differs from the original payment | Money leaving by a different route |
| Cash refund on a non-cash sale | Same |
| Credit customer | Their account is still affected |
| `Other` reason | Still unexplained |

### How it is plumbed, and why not through the DTO

`withinExchange` is an **option on the service method**, not a field on
`CreateReturnDto`:

```ts
returns.complete(tenantId, actor, dto, idempotencyKey, { withinExchange: true })
```

A DTO field would let any caller of `POST /returns` assert it and skip the check
— an approval bypass reachable from the public API by writing one extra line of
JSON. Only `ExchangesService` can set this, and it always does.

### What proves it is narrow

Four integration assertions, and the second is the one that matters:

1. An ordinary size swap completes with **no approval token at all**.
2. **The same return, outside an exchange, still demands a manager.** Without
   this, *"the exchange worked"* would also pass for an implementation that had
   simply switched the trigger off for everyone.
3. A **damaged-goods** exchange is still refused without approval.
4. That same damaged-goods exchange **completes once approved** — so the refusal
   is a gate, not a dead end.

### What this does not change

- Every other part of D128 and D128a: composition over atomicity, gross
  settlement, the nullable `replacementSaleId`, idempotency.
- Standalone returns, which behave exactly as they did.
- The restaurant and hardware modules. `RETURNS` is retail-gated, and the flag
  defaults to `false`, so a caller that does not set it sees the old behaviour
  byte for byte.

---

## D131 — margin is costed at today's average, and the report says so

**Status:** accepted, 2026-09-07. No migration. Introduced by `8.5`.

### The question

`ProductVariant.averageCost` is maintained by every goods receipt — a weighted
average across every branch, refreshed on each receive — and until `8.5` no
report read it. A shop could see what it sold and never what it made on it.

The question `8.5` had to answer is not "how do we compute margin", it is **which
cost a historical sale is costed at**.

### What was decided

**Margin is `revenue − (quantity × the unit cost as it stands TODAY)`, and every
surface that shows it says that in words.**

`averageCost` moves. A sale from March costed today is only right if nothing has
been received since; a shop buying into a falling market will see its March
margin flattered, and one buying into a rising market will see it understated.
That is a real limitation, not a rounding detail.

### The alternative, and why it is not this phase

Costing a historical sale exactly means **freezing the unit cost onto `SaleItem`
at sale time** — a new column, a migration, a decision record, and a change to
the sale write path that every existing tenant runs through. It is the right
long-term answer and it is deliberately not being done here, for three reasons:

1. It could not answer for sales already taken. Every sale in the pilot database
   would still have to be costed at today's average, so the report needs this
   behaviour regardless.
2. `8.5`'s scope is "read the cost that already exists". Changing how sales are
   written is a different piece of work with a different blast radius, and the
   standing constraint is not to disturb paths that hardware and restaurant
   tenants run through.
3. The approximation is close to exact for the shops this template targets,
   whose costs move slowly.

**Revisit when** a client reports margins that do not match their own books, or
when stock valuation (a related, larger piece) is picked up.

### An unknown cost is not a zero cost

A variant nothing has ever been received against has `averageCost = NULL`. The
row's cost, margin and margin percentage are all `null`; the row is excluded from
the totals; and the excluded rows are counted and their revenue reported
separately, so a reader can see how much of the period the totals do not cover.

Costing NULL as zero would report a **100% margin** on that row — the most
flattering possible number, arrived at by accident. This is the same principle as
D28/D31's *unresolved is its own state*, applied to money.

### A variant never reads its parent's cost

Once `hasVariants` is true, `Product.unitPrice`, `Product.costPrice` and
`Product.averageCost` are legacy columns the schema states are not read, holding
whatever they held before the product gained variants. **D44** is the record of
what happens when a screen reads them anyway: the products list priced every
variant product at `Rs 0.00`.

A margin report reading a stale parent cost would be the same defect one column
over, and worse — it produces a *plausible* margin instead of an obvious zero. So
a variant line is costed from the variant or not at all; only a line sold without
a variant reads the product.

Each row reports which cost it used — `VARIANT_AVERAGE`, `LATEST_PURCHASE`,
`PRODUCT_AVERAGE` or `UNKNOWN` — rather than presenting one figure as though
every part of it were equally solid.

### What this does not change

- No column, table or migration.
- The receipt path. `averageCost` is still written only by
  `inventory-receipts.service`, exactly as before.
- The restaurant and hardware modules. This is a new read on a gated retail
  report route.

---

## D132 — a stock take states reality; it is not a guarded movement

**Status:** accepted, 2026-09-07. **Migration:** yes — `StockTake`,
`StockTakeLine`. Introduced by `8.7`.

### The question

Every shop counts its stock. Until now this system had no way to record that a
shelf holds four when the books say six: the only stock writes were a sale
(guarded), a return, a receipt, and a bulk-import adjustment.

### The decision, in one line

**A count is an assertion of reality by an operator, and the system records it
rather than arguing with it.**

Concretely:

1. It **sets** the branch's quantity to the counted figure. It does not decrement
   and it is not refused for going down. Refusing a count because it disagrees
   with the books would leave the books wrong and the shelf uncounted.
2. It **writes a `StockMovement`** for every line whose count differed, reason
   `ADJUSTMENT`, so the correction is as auditable as a sale.
3. It **never touches the oversell guard.** `reduceStock`'s conditional
   `updateMany({ where: { quantityOnHand: { gte } } })` is untouched, and no
   count path passes through it. Two things that look similar — "change the
   stock number" — are kept apart because only one of them is a race.

### Why a new provider method, not a service writing stock

`InventoryProvider.adjustStock` already exists and is documented for exactly this
("a stocktake correction is an assertion of reality by an operator"). It could
not be used as it stands: `LocalInventoryProvider.adjustStock` writes
`Product.quantityOnHand` only — no branch, no variant, no `StockMovement`. It is
the legacy bulk-import path, and widening it would change what the product import
does to every existing tenant.

Writing the stock directly from a new service was the other option, and it is
forbidden: *"stock movement lives in exactly one layer — the providers, and
nowhere else"* is an architectural tripwire with an exact file set, and D28/D31
put the routing decision in a provider rather than in conditionals inside a
service.

So `8.7` adds **`applyStockCount`** to the provider interface, exactly as D44
added `receiveStock`:

- `LocalInventoryProvider` implements it.
- `QuickBooksInventoryProvider` and `NoInventoryProvider` **throw**
  `ProviderOperationUnavailableError`. A silent no-op would look like a
  successful count that never moved anything — the same "document with no ledger
  effect" state D44 refused for receipts. QuickBooks stock is a cache of an
  upstream system whose ledger is not ours to write; `NONE` has no stock to
  count.

### Why the document is immutable and has no status

A `StockTake` row is a count that HAPPENED. There is no `DRAFT`, no `POSTED`, no
`status` column at all — a counting session that can be saved and resumed is a
different feature, and a status field with one legal value is the "reserved key
with nothing behind it" shape D2 recorded and Phase 7 spent a step undoing.
Adding a status later is a migration; adding it now is a promise.

The same reasoning gives the line its snapshots: `productNameSnapshot` and
`variantNameSnapshot` are frozen at count time (D44), so a rename cannot rewrite
what was counted.

### What a variance is worth

Each line carries `unitCost` and `varianceValue`, both nullable, resolved by the
same rule as D131 — the variant's own average, then its latest purchase, and for
a variant-less line the product's. **Null, not zero, when nothing has ever been
received**: a shrinkage report that valued unknown stock at zero would say a
missing item cost the shop nothing.

### Authorisation

`INVENTORY` module, and **`product:manage`** — no new permission was minted.

`product:manage` is the permission that already authorises writing stock
quantities: the bulk product import does exactly that today. It is held by Owner,
Admin and Manager, which is the set a count needs, and a cashier does not hold
it.

D44 minted `inventory:receive` rather than reusing `product:manage`, and the
argument it made — a floor manager who receives stock need not also be able to
edit the catalogue — applies equally to counting. It is not being acted on now
because no tenant has asked for that split, and vocabulary added in advance of a
need is vocabulary nobody can remove. **`inventory:count` is the natural next
step** the first time a client wants a counter who is not a catalogue editor.

### What this does not change

- The sale path, the return path, the receipt path: byte for byte.
- `adjustStock`, which the product import still calls, unchanged.
- Restaurant and hardware tenants. `applyStockCount` is reachable only through a
  new `INVENTORY`-gated route, and the restaurant module has no caller.

---

## D133 — brand is an entity, not a string on a product

**Status:** accepted, 2026-09-07. **Migration:** yes — `Brand`, plus a nullable
`Product.brandId`. Introduced by `8.9`.

### The question was settled in advance

D64 (`2.4`) chose the clothing attribute schema and deliberately left brand out
of it, recording why:

> **Why `brand` is absent.** It is a **column eventually** (Phase 8 — "brand as
> an entity"): filtered and reported on, and free text will not survive real
> data. Declaring it here now would mean migrating tenants' stored strings into
> an entity later. Leaving it out costs nothing today.

`8.9` is that entity. The prediction has been paid off rather than revisited, and
no tenant has a stored brand string to migrate — which is exactly the outcome
D64 was buying.

### Why an entity rather than a validated string

The test D64 states for attribute-vs-dimension does not apply here, because brand
is neither. The test that does apply is **what happens to the data over a year**:

- A free-text brand gives `Nike`, `nike`, `NIKE ` and `Nkie` as four brands. A
  buyer's "how did Nike do this season" then answers three quarters of the
  question, and nothing in the system can tell them so.
- An enum in the attribute schema would be worse: `attributeSchema` is a
  per-DOMAIN list in code, and brands are per-TENANT data. Every shop would
  share one list, and adding a brand would be a deployment.

So: a row per tenant per brand, referenced by id.

### The link is nullable, and stays nullable

`Product.brandId` is `String?` with `onDelete: SetNull`.

**Nullable** because most products in a hardware or grocery catalogue have no
brand worth recording, and a required link would make every existing product
un-editable until someone invented a brand for it. "Unbranded" is not a brand; it
is the absence of one, and null is how the schema says that (D28/D31 —
*unresolved is its own state*).

**`SetNull`** because retiring a brand must never delete a product. A shop that
stops stocking a label still sold those garments, and the sale lines that
reference them are history.

### Archived, not deleted

A brand is deactivated (`isActive: false`) rather than removed. Deleting one
would silently unlink every product that used it, and the products are the
records that matter. Archived brands stay readable so an old product still shows
what it was, and are filtered out of the pickers where a new choice is made.

### What `8.9` does NOT do

- **No markdown pricing.** Open question 6, answered by the PO on 2026-09-07:
  *"absolutely still no"*. Scheduled percentage promotions (Phase 4) already
  cover the selling behaviour; what is given up is the *was / now* pair on a
  shelf label and a "how much did we lose to markdowns" report. Deferred, not
  rejected. **`8.9` carries its migration alone**, exactly as the phase plan
  says.
- **No brand on a sale line.** A sale line snapshots the product NAME (D44); it
  does not snapshot a brand id, and reporting resolves the brand from the product
  as it stands today — the same choice, for the same reason, that `8.3` makes
  about product names.

### What this does not change

- Every existing product, which keeps `brandId = NULL` and behaves identically.
- The restaurant and hardware modules: one new table, one nullable column, and a
  `PRODUCT_*`-permissioned route set that no restaurant screen calls.

---

## D134 — weighed goods are a software prompt, not a hardware integration

**Status:** accepted, 2026-09-07. **Planning only — no code written.** Migration
required when built (`Product.quantityType`). Unblocks the **weighed-goods** part
of Phase 6; the rest of that phase stays parked (see the end of this record).

### The decision

A product declares how it is measured. A cashier selling a measured product is
asked for the measurement. Nothing else changes.

```
Product.quantityType : WHOLE | DECIMAL     default WHOLE
```

| Scenario | Flag | Behaviour |
|---|---|---|
| Cashier taps a shirt | `WHOLE` | Quantity 1 goes straight into the cart. No interruption |
| Cashier taps "Rice, Rs 200/kg" | `DECIMAL` | The cart addition is intercepted; a numpad asks for the weight. `0.750` is entered, read off an ordinary offline scale |

The line is then a normal line of quantity `0.750`, and every existing rule —
pricing, tax, stock depletion, returns — applies to it unchanged.

### Why this is the right shape

Digital-scale drivers and variable-measure barcode decoding are both real work
with real vendor variation, and neither is needed to sell rice. A shop already
owns a scale; the cashier can already read it. The system's job is to accept the
number, not to acquire it.

It also fails safe. A tenant that never sets `DECIMAL` on anything is running the
code that exists today, byte for byte.

### What was verified before accepting this, and what it changes

The premise "the backend foundation already supports this math" was checked
against the code rather than assumed. **It holds** — and one part of the
surrounding story does not.

**Confirmed:**

| Claim | Evidence |
|---|---|
| Quantities are `Decimal(12,3)` throughout | `SaleItem.quantity`, `BranchInventory.quantityOnHand`, `StockMovement.delta`, `ReturnItem.quantity`, `InventoryReceiptLine.quantityReceived` — all `@db.Decimal(12, 3)`. Three places is grams |
| The API already accepts a fractional quantity | `SaleItemInputDto.quantity` is `@IsNumber() @IsPositive()` — **not** `@IsInt()`. A `0.750` posted today is accepted and stored |
| Returns carry no whole-number assumption | No `IsInt` and no flooring in the returns DTOs or `returns.calc` |
| Nothing collides with the new column | `Product` has no unit-of-measure, weight or scale field to conflict with |

**Corrected — and this is the part worth carrying forward:**

> **Phase 6's weighed-goods work was never blocked by hardware. It is blocked by
> the till.**

`apps/web/src/lib/pos-cart.tsx` clamps every typed quantity to a whole number:

```ts
let q = Math.max(1, Math.floor(quantity));   // setQty
```

and the `+`/`−` stepper moves in units of one (`changeQty(lineKey, ±1)`). A
cashier who types `0.750` today gets `1`. So the work this decision authorises is
**frontend work on the cart**, not backend work and not driver work — which is a
smaller, better-understood job than the plan implied, but it is not nothing, and
the schema being ready does not make it free.

### The rule that must not be broken when this is built

**The numpad must not compute the price.** It collects a quantity; the line total
is computed where every other line total is computed.

This branch has paid for that lesson twice: `2.12` (four sale-line renderers, two
of them fixed, so the same sale printed differently from different endpoints) and
`3.10` (the till quoted 18% on an item the server then zero-rated). D59 says one
money engine. A weighed line is the easiest place in the system to grow a second
one, because `0.750 × 200` looks too simple to be worth centralising.

### Open sub-question — promotions on a measured line

**Not decided here. It needs an answer before this is built.**

`packages/shared/src/promotions/applier.ts` counts in whole units:

```ts
times  = Math.floor(quantityOf(lines, productId) / perBundle);
earned = Math.floor(buyPool / buyQty) * getQty;
req.set(it.productId, (req.get(it.productId) ?? 0) + Math.max(1, it.quantity));
```

"Buy 2, get 1 free" on 0.75 kg of rice has no defined meaning, and
`Math.max(1, it.quantity)` quietly rounds a 0.75 kg line **up** to one unit for
eligibility — so a customer buying 750 g today would count as a whole unit toward
a bundle. That is not a bug against current data, because no product can be
fractional yet; it becomes one the day this decision is implemented.

Three readings, in the order I would recommend them:

1. **Quantity-based promotions do not apply to `DECIMAL` products.** Percentage
   and fixed-amount promotions still do. Simplest, hardest to get subtly wrong,
   and matches how most grocers actually price ("10% off all rice", not "buy 2 kg
   get 1 kg").
2. Quantity promotions apply on whole units only, fractions ignored.
3. Quantity promotions apply pro-rata.

**Whoever picks needs to say so in a follow-up record**, and the applier needs a
test either way — a promotion that silently treats 0.75 kg as one unit is exactly
the kind of thing that ships green.

### Scope — what this does and does not unblock

**Unblocked:** selling by weight or measure. A grocer can price rice per kilo and
sell 750 g of it.

**Still parked, unchanged:**

- Per-category tax rates (`3.1`–`3.3`) — zero-rated staples beside standard-rated
  goods. A separate requirement with its own migration.
- The grocery `attributeSchema` (was `2.5`) — still closed rather than open:
  Q12 resolved *do not split `RETAIL`*, so a grocery tenant would be shown the
  clothing schema. Needs a grocery customer to say what a grocer records.
- Variable-measure barcode decoding (`21`/`22` prefixes) — genuinely a hardware/
  vendor concern, and **this decision is what makes it optional rather than
  prerequisite**. A shop can operate with the numpad and adopt scale labels later.
- Footwear size scales — unrelated, still needs a local retailer.

**Phase 6 is therefore not "unblocked" as a whole.** One of its four parked items
now has an implementation path that needs no hardware; the other three are
untouched.

### What must be true of the implementation

Recorded now so the sprint does not re-litigate it:

1. **`quantityType` defaults to `WHOLE`** on the column, so every existing row —
   restaurant, hardware, retail — reads as it does today with no backfill.
2. **The flag is read, never inferred.** No component may guess "this looks like
   rice". Same rule as D56: read a capability, never a business type.
3. **The server does not trust the client's arithmetic.** It already recomputes
   every line; a `DECIMAL` line changes no part of that.
4. **The prompt is cancellable**, and cancelling adds nothing to the cart. A
   half-added line is worse than no line.
5. **`0` is refused, not accepted as an empty line.** `@IsPositive()` already
   refuses it server-side; the numpad should refuse it sooner.
6. **Stock, returns and reports need no change** — they are already `Decimal`.
   `8.3`'s `formatReportQuantity` already renders `0.750` as `0.75`, which was
   written for loose goods before this decision existed.

---

## D134a — a measured product is invisible to quantity-based promotions

**Status:** accepted, 2026-09-07. **Planning only — no code written.** Closes the
open sub-question in [D134](#d113). No migration of its own.

### The decision

**Option 1**, chosen by the PO:

| Promotion kind | Applies to a `DECIMAL` product? |
|---|---|
| `BUY_X_GET_Y` | **No** |
| `BUNDLE_FIXED_PRICE` | **No** |
| `PERCENTAGE_DISCOUNT` | **Yes** |
| `FIXED_AMOUNT_DISCOUNT` | **Yes** *(both line-level and cart-level)* |

"10% off all rice" works. "Buy 2 get 1 free" on rice does not exist.

### Why

"Buy 2, get 1 free" on 0.75 kg has no meaning that a customer and a cashier
would agree on before an argument. The other two readings — whole units only,
and pro-rata — are both defensible and both surprising, and a promotion that
surprises a customer at the till costs more than one that never fires.

It also matches how grocers price in practice: percentage and amount-off on
weighed goods, bundles on packaged ones.

### Where it goes, and the shape it must take

`claimsFor` in `packages/shared/src/promotions/applier.ts` is already a single
dispatch on `rule.type`. The bypass belongs there — the two quantity-based
branches see a filtered line list, the other two see the full one.

**`PromotionCartLine` must carry the flag.** It currently holds `productId`,
`unitPrice`, `quantity`, `lineSubtotal` and `manualDiscountAmount` and nothing
else, so the applier cannot know a product is measured unless it is told. There
is a proven precedent for exactly this shape: `manualDiscountAmount` non-zero
already makes a line invisible to promotions (D123). This is the same idea,
narrowed to two of the four kinds.

**Both callers must set it.** The till builds a `PromotionCartLine` for the badge
and the server builds one for the charge. If only one sets the flag, the cashier
is shown a discount the server refuses — which is `2.12` and `3.10` again, and
this branch has paid for that lesson twice. A test must assert the two agree.

### The latent rounding this makes safe

`applier.ts` currently does:

```ts
req.set(it.productId, (req.get(it.productId) ?? 0) + Math.max(1, it.quantity));
```

which rounds a fractional line **up to one whole unit** for bundle eligibility.
Harmless today because no product can be fractional. With D134 shipped and
without this bypass, 750 g of rice would count as a whole unit toward "buy 2 get
1 free" — a customer getting a free bag for buying one and a half.

**The bypass is what makes that line safe, not a fix to it.** Leave it: it is
correct defence for a caller that forgets the flag, and a test should prove a
measured line never reaches it.

### What must be tested (D30)

Both directions, or the assertion is worth nothing:

1. **Positively** — a `PERCENTAGE_DISCOUNT` DOES discount a 0.75 kg line.
2. **Negatively** — a `BUY_X_GET_Y` naming that product yields no claim on it.
3. A **whole** product in the same basket still wins its bundle, so the filter
   removes the measured line and not the promotion.
4. The till's preview and the server's charge agree on the same basket.

---

## D134b — the measured-product contract: unit, switching, and entry bounds

**Status:** accepted, 2026-09-07. **Planning only — no code written.** Closes
`6.1-Q1`, `Q3` and `Q4` from the Phase 6 plan, and records the approved scope
(`Q5`, `Q7`). Extends [D134](#d113); no migration of its own beyond the column in
§1.

### 1. A measured product names its unit *(Q1 — yes)*

```prisma
model Product {
  quantityType   QuantityType @default(WHOLE)   // D134
  unitOfMeasure  String?                        // D134b
}
```

**Same migration as `quantityType`.** Adding it later would mean a second
migration *and* re-editing every measured product a shop had already set up.

**Free text — `kg`, `g`, `L`, `m`, `ft`.** Nothing computes on it; it is printed,
exactly like `material` in the clothing attribute schema. A controlled list would
be a guess about a market nobody in this project has met, which is the mistake
`2.6` refused to make about UK-versus-EU footwear scales.

It is what lets the numpad ask *"How many kg?"* rather than *"How many?"*, the
receipt print `0.750 kg`, and a shelf label read `Rs 200/kg`.

**Nullable at the column**, because a `WHOLE` product has no unit and a required
column would demand one for every shirt in every tenant.

> **New sub-question this creates — `6.1-Q2`.** Should `unitOfMeasure` be
> **required when `quantityType` is `DECIMAL`**? A measured product without one
> prints `0.750` and asks *"How many?"*, which is the state the field exists to
> prevent.
>
> **Recommendation: enforce it in the service, not in the column.** The database
> cannot express "required only when another column has a particular value"
> without a check constraint Prisma will not model, and the same rule then has to
> exist in the API anyway. One rule, in the place that can state it.

### 2. Switching `WHOLE` ⇄ `DECIMAL` is allowed, and warns *(Q3)*

**Allowed.** A shop that flags something wrongly on its first day must be able to
correct it, and blocking the change would trap them.

**Warned, because stored quantities are NOT converted.** `quantityOnHand: 100`
meant a hundred pieces yesterday; after the switch it means a hundred kilograms.
Historical sale lines keep whatever integer quantity they were sold at. Nothing is
corrupted and nothing is migrated — the *meaning* of stored numbers changes, and
only a person can say whether that is right.

**The warning must be specific and must name the counts**, on the screen where
the change is made:

> *"This product has **100** on hand and **14** recorded sales. Changing how it is
> measured does not convert them — 100 will now read as 100 kg."*

**No conversion factor is applied, ever.** Converting would require knowing how
much one piece weighed, which nobody can supply and the system has never
recorded.

### 3. Entry bounds at the numpad *(Q4)*

| Bound | Rule | Why |
|---|---|---|
| **Decimals** | **Maximum 3** | The column is `Decimal(12,3)`. A fourth place is silently truncated by the database, so it must be refused where the operator can still see it |
| **Minimum** | **None beyond "greater than zero"** | 5 g of saffron is a real sale. `@IsPositive()` already refuses `0` server-side; the numpad refuses it sooner |
| **Maximum** | **Existing stock, via `stockCap`** | Already decimal-safe and already the rule for every other line. No invented ceiling |

### 4. Approved scope *(Q5, Q7)*

**Track A only.** Steps `6.1`–`6.6`. Weighed goods, end to end.

**Track B — per-category tax — is deferred again**, and this is the record of why
it is safe to defer:

> **Zero-rated staples beside standard-rated goods already work today**, per
> product, end to end: `Product.taxable` (exposed in the wizard, `3.13`), the
> tenant rate (`3.15`), `taxableBase` removing exempt lines and their share of the
> order discount (`3.10`), the per-line snapshot of `0` (`3.9`), returns reading
> that snapshot (`3.11`) and the receipt breaking it down (`3.12`).
>
> The only capability Track B genuinely adds is **two different non-zero rates**
> in one basket. No customer has asked for it, and building it would edit
> `computeDocumentTotals` — the one money engine the restaurant module shares,
> which no phase in this plan has touched in eight phases.

**Track C — the grocery attribute schema — is deferred with the sprint**, but its
approach is now settled: see **D135**.

---

## D134e — the server refuses measured goods outside RETAIL

> Recorded at merge time (D136a) from commit `1887632`, which cites this
> record; the branch never wrote it. The text is the commit's reasoning.

The wizard stopped offering "How is this sold?" outside RETAIL, but hiding
is usability only and the server stays the authority. Until this record a
direct `POST /v1/products` could still make a hardware product `DECIMAL` —
and hardware runs the retail till, so a numpad would have appeared for it.

**Where it lives.** On `ProductAttributesService`, because `ProductsService`
may not reference `BusinessProfileService` (D28, with a tripwire enforcing
it) and that class exists for exactly this: domain data validation resolved
from the profile, thrown as an ordinary refusal
(`MEASURED_GOODS_NOT_OFFERED`, 400). It reads the domain registry's
`catalogue.measuredGoods` capability — RETAIL declares it; hardware and
food service do not — never a business-type conditional.

**It reads the incoming value, not the resulting state.** D134c's unit
check reads the resulting state, because measured-with-no-unit is invalid
however it is arrived at. This rule is the opposite, deliberately: a row
can be `DECIMAL` in a domain that no longer offers it — created before the
capability existed, or before the workspace changed type. Reading the
resulting state would refuse every edit to that row, including the one
that fixes it. So the rule is "you may not ASSERT measured here", not "no
measured row may exist here": an already-`DECIMAL` hardware product can
still be renamed, and switched back to `WHOLE`.

**Tests.** Six in `weighed-goods.spec.ts`, both sides: the refusal paired
with a positive control (the identical create succeeds for RETAIL), an
invisibility check (an ordinary `WHOLE` create in a hardware workspace
notices nothing) and a second domain (food service is refused too, proving
the registry is read).

## D135 — a tenant picks its catalogue attribute pack — **SUPERSEDED by D138**

> **Withdrawn unbuilt, 2026-09-09.** D138 answers the same problem by letting a
> tenant define its OWN field list rather than pick from lists we wrote, which
> needs no `cataloguePack` column and no migration. The two traps this decision
> identified were both real and are both answered there. Kept in full below
> because the reasoning that rejected splitting `RETAIL` and rejected merging
> the two lists still stands, and because "why not packs" is a question that
> will be asked again.

**Status:** ~~accepted, 2026-09-07~~ superseded. **Planning only — no code written.**
Migration would have been required when built (`TenantBusinessProfile.cataloguePack`).
Answers `Q6`; was to implement Phase 6 step `6.10`.

### The problem

`ProductAttributesService.schemaForTenant` resolves **one schema per business
type**:

```ts
const profile = await this.profiles.getEffectiveProfile(tenantId);
return domainFor(profile.businessType).catalogue.attributeSchema;
```

The `RETAIL` descriptor declares one list, and it is the clothing one —
`material`, `fit`, `careInstructions`, `gender`, `season`. Clothing and grocery
are both `RETAIL`, and **Q12 resolved: do not split `RETAIL`**.

So a grocer is asked for **Fit** and **Season**, and `validateAttributes` refuses
`allergens` as an unknown key. Not a missing feature — an actively wrong one.

### The decision

**A domain may declare named attribute packs; a tenant selects one.**

```ts
readonly catalogue: {
  /** Used when a tenant has selected nothing. Unchanged for every domain today. */
  readonly attributeSchema: readonly AttributeField[];
  /** Named alternatives. Absent for a domain with only one. */
  readonly attributePacks?: Readonly<Record<string, readonly AttributeField[]>>;
};
```

`RETAIL` declares `attributeSchema` as the clothing list **byte for byte as it is
now**, plus `attributePacks: { clothing, grocery }`.

Stored as **one nullable column**, `TenantBusinessProfile.cataloguePack String?`.

**Nullable is the safety property.** `NULL` means "use the default", so every
existing tenant — clothing, hardware, restaurant, every domain — resolves exactly
as it does today with no backfill. Only a tenant that explicitly selects a pack
sees anything different.

The resolver becomes:

```ts
const domain = domainFor(profile.businessType);
return (profile.cataloguePack && domain.catalogue.attributePacks?.[profile.cataloguePack])
    ?? domain.catalogue.attributeSchema;
```

The pack is chosen at workspace creation — the console already asks which
template — or later in Settings.

### Why not split the business type

Because `businessType` drives far more than catalogue fields, and clothing and
grocery are identical in all of it:

| What `businessType` decides | Clothing vs grocery |
|---|---|
| Modules enabled | same |
| Navigation | same |
| Capabilities | same |
| Role templates | same |
| POS workspace | same |
| Console template card | same |
| **Catalogue attribute fields** | **different** |

Splitting duplicates six identical things to vary the seventh, costs an enum
migration and D120a's two-migration dance, and re-opens a decision the PO has
already made (Q12). The pack targets the one row that differs.

### Why not merge the two lists

A clothing shop would be asked for **Allergens** and a grocer for **Fit**. It is
the cheapest option and therefore the one that will look tempting under sprint
pressure; it is recorded here as rejected so it does not get re-proposed.

### Two traps, both required in the build

**1. Switching a tenant's pack strands their stored attributes.**
`validateAttributes` refuses unknown keys, so a product holding `fit: 'Slim'`
fails its next full write once the tenant moves to the grocery pack. Same
mechanism D64 documents for removing a field, new trigger. **The build must
either refuse the switch once products carry attributes, or make it an explicit
operation with a warning naming the count** — the same shape D134b requires for
switching a product's measurement.

**2. A pack is a commitment, not a sketch.** Removing a field later strands
whatever tenants stored under it. D64 says this of the schema and it is equally
true of a pack.

### What this does NOT decide

**The grocery pack's field list.** `04-format-packs.md` §4 drafts
`countryOfOrigin · allergens · storageInstructions · nutritionPer100g`, and that
draft needs a real grocer before it is committed to — for exactly the reason
`2.5` was parked.

**Brand is not in it.** `04` listed brand as a grocery attribute; **D133** made it
an entity, so it is a column with a filter and a report, not a text field.

---

## D134c — a measured product must name its unit, enforced in the service

**Status:** accepted, 2026-09-07. **Planning only — no code written.** Closes
`6.1-Q2`, the sub-question [D134b §1](#d113b) opened. No migration; no change to
the column.

### The decision

**A product whose `quantityType` is `DECIMAL` must carry a non-empty
`unitOfMeasure`. The rule lives in `ProductsService`, not in the column.**

`Product.unitOfMeasure` stays `String?` — nullable — exactly as D134b §1
declared it.

### Why not the column

The requirement is **conditional**: mandatory for a `DECIMAL` product, meaningless
for a `WHOLE` one. A `NOT NULL` column would demand a unit of measure for every
shirt, every service line and every restaurant menu item in every tenant.

Postgres could express it as a `CHECK` constraint, but Prisma will not model one,
so it would live only in raw migration SQL — invisible to the schema, invisible to
the client, and reported to a user as a constraint-violation string rather than a
sentence. And the API would still need its own check to produce a usable 400, so
the rule would exist twice with only one of the two readable.

**One rule, in the place that can state it.**

### Where it goes

`ProductsService.create` and `ProductsService.update`, beside
`assertValidDocument` (D64 attributes) and `resolveBrand` (D133) — the service
already owns exactly this kind of cross-field validation.

**It must be checked against the RESULTING state, not the payload.** `update` is
partial (D133 relies on that: absent leaves a brand alone, `''` clears it), so
both of these must be refused:

| Request | Existing row | Result |
|---|---|---|
| `{ quantityType: 'DECIMAL' }` | `unitOfMeasure: null` | **refused** — turning a product into a measured one without saying in what |
| `{ unitOfMeasure: '' }` | `quantityType: DECIMAL` | **refused** — removing the unit from a measured product |
| `{ name: 'Rice' }` | `DECIMAL`, `'kg'` | allowed — a partial update that touches neither |
| `{ quantityType: 'WHOLE' }` | `unitOfMeasure: null` | allowed — a whole product needs no unit |

A check against the payload alone passes the first two, which are the only cases
worth guarding.

### The message matters

`"A product sold by weight or measure needs a unit — for example kg, g or L."`

Not `"unitOfMeasure is required"`. The person reading it is a shopkeeper adding
rice, and `4.19` cost two hours on a promotion that behaved correctly and
explained nothing.

### The client asks too, and is not the authority

The product wizard should require the field once `DECIMAL` is chosen, so the
operator is never allowed to reach a refusal they could have been shown. That is
usability; the server's refusal is what makes it true. **Frontend hiding is
usability only** — the standing rule in `CLAUDE.md`.

### What must be tested (D30 — both directions)

1. **Negative:** creating a `DECIMAL` product with no unit is refused.
2. **Negative:** clearing the unit on an existing `DECIMAL` product is refused.
3. **Positive:** creating a `WHOLE` product with no unit **succeeds** — otherwise
   the rule would pass for an implementation that demanded a unit from everyone.
4. **Positive:** a partial update that mentions neither field leaves both alone.

---

## D134d — a document prints the unit the line was SOLD in

**Status:** accepted, 2026-09-08. **Migration:** yes — `SaleItem.unitOfMeasureSnapshot`
and `ReturnItem.unitOfMeasureSnapshot`, both nullable. Introduced by `6.5`.
Extends [D134b §1](#d113b).

### The question

D134b §1 says the unit is what lets "the receipt print `0.750 kg`". A receipt
renderer has a `SaleItem`, and `unitOfMeasure` is on `Product`. So either the
renderer joins the product, or the sale line carries the unit.

### The decision

**Snapshot it, like every other thing a document prints.**

`SaleItem` already freezes `productName`, `sku`, `variantSkuSnapshot`,
`variantNameSnapshot` and `promotionNameSnapshot` at sale time, and D44 states
why: a document must show what was sold, **at the name it was sold under**. A
later rename must not rewrite a receipt printed last year.

The unit is the same kind of fact, and the failure mode of joining is worse than
a wrong name:

> A shop prices saffron per gram, then switches to kilograms. Every historical
> receipt reprints `0.750 kg` where the customer actually bought **0.750 g** —
> wrong by a factor of a thousand, on a document someone may be holding.

A snapshot cannot do that. Nullable, because every line written before this
column existed has no unit and `NULL` is the honest answer — the same contract
`taxRatePercent` uses (D122), where `NULL` means "not recorded" rather than a
fabricated default.

### `ReturnItem` gets it too, for the same reason

`3.8` added `taxRatePercent` to both tables in one migration because a credit
note is a document as much as a receipt is. A refund line printing a bare
`0.750` while the original receipt says `0.750 kg` is the same defect one
document over.

### What renders it

**One shared formatter**, `saleLineQuantity`, in `@hardware-pos/shared` beside
`saleLineLabel`.

`2.12` is the reason: four renderers print a sale line, `1c.7` fixed two of
them, and the same sale printed correctly from one endpoint and wrongly from
another. `sale-line-renderers.spec` enumerates all four and fails if one skips
the shared helper. Three of the four currently format quantity three different
ways — one of them a ternary whose branches are identical.

A line with no unit renders exactly as it does today, so every existing document
is unchanged.

### What this does not change

- Any money. The unit is printed, never computed on.
- The restaurant path: `ProjectedSaleItem` carries only the fields it lists, so a
  restaurant bill writes `NULL` here and prints what it always printed — the same
  mechanism that leaves `taxRatePercent` null there (3.16).

### D136 — merging `feature/retail-template`: how each clash was decided

`origin/feature/retail-template` (99 commits, 2026-08-28 to 09-08, cut from
the restaurant tip `4f0be1b`) was merged into `merge/restaurant-changes` after
D119. It brings the Retail vertical: the `RETAIL` business type and its
clothing domain (D120), stock tracked by variant (D121), per-line tax (D122),
promotions (D123, D124, D126), the option library, barcodes and labels (D125,
D127), exchanges (D128–D130), reports, stock takes and brands (D131–D133),
weighed goods (D134) and attribute packs (D135). Twenty-six files conflicted.
What follows is every decision that was more than "take both".

**Decision numbers, a third time.** The branch numbered its records D99–D114
with a–e sub-records; this branch already held D99–D119. Theirs moved up by
twenty-one — D99→D120 … D114→D135, sub-letters kept, anchors and migration
comments included — in one commit on the branch's own history. The first
pass missed D105–D109 (a pattern that covered 100–104 and 110–114 and skipped
the middle); the branch commit was amended and the merge re-pointed at it, so
the merge's second parent carries the whole renumber. Three migration
DIRECTORIES keep their old numbers in their names — `…_stock_take_d111`,
`…_brand_entity_d112`, `…_weighed_goods_d113`, `…_unit_snapshot_d113d` —
because a migration's directory name is its identity in `_prisma_migrations`
and none has been applied anywhere yet only by luck; their header comments
say D132, D133 and D134.

**Production's migrations are `main`'s, and none was touched.** Their
thirteen migrations are all additive: two enum values (`RETAIL`,
`PROMOTIONS` — each added in its own migration so a later one may use it,
D120a), nullable or defaulted columns on `Product`, `SaleItem`, `ReturnItem`
and `PrintJob` (`saleId` becomes nullable for label jobs, D127 — the D68
`SET NOT NULL` runs first in lexical order, then this), and seven new tables.
The merged set is 84. Proven as before: an empty database applies all 84 and
reads up to date; a database at `main`'s 27, with a customer-account payment
and a legacy product seeded between, applies the remaining 57, keeps both rows
(the product reads `taxable = true`, `quantityType = WHOLE`, no brand), holds
`Sale_tenantId_completedAt_idx` once and reads up to date; `migrate diff`
emits only the D44 FK pair (O6). Two names are created twice in the whole
set and both are a drop-and-re-add inside one migration; the barcode unique
index is created `IF NOT EXISTS` by D125c on top of D44's, harmlessly.

**The clothing Retail template is Owner + Cashier.** Their descriptor took
`HARDWARE_ROLE_TEMPLATES`, which meant Owner + Cashier when written. D108 has
since made that list Owner, Salesperson, Cashier with the Salesperson
hardware-only; the descriptor now takes `GENERAL_ROLE_TEMPLATES`, which is
exactly the two it wanted. Whether a clothing shop should also offer a
Salesperson is a product question (O10), not something a merge decides.

**Their own tripwire was red, and is green.** The providers-adoption spec on
their branch listed the stock-take module among the adopters but never
widened `ADOPTED_PATHS`, and three of their specs import from the providers
directory — one to pin the LOCAL provider's rollup rule, two to borrow the
testkit's source analyser. The spec now treats a `providers/testkit` import
as what it is (an analyser, not an adoption), `modules/stock-takes` is an
adopted path (D132 designed it as a provider consumer), and the rollup spec
lives beside the provider it pins, where the scan does not look.

**Unions.** `Sale` gains their two exchange relations beside `main`'s
`markedPaidBy` and the tabs' `billSplits`; the sales module imports both
`CreditModule` and `PromotionsModule`; the products module keeps one
`SettingsModule` import with both reasons; `sellable.service` keeps the 86
switch's `SOLD_OUT` state and gains their variant-grain rollup branch; the
retail receipt template imports both the credit/timezone helpers and
`taxRateLabel`; `provision-tenant.ts` keeps D108's role validation and linking
and gains their clothing pack and `--with-samples`; the integration harness
runs Prisma through `node` (their fix) — no shell, no `.cmd`; `.gitattributes`
keeps the superset (`text=auto` plus the LF rules, theirs was the `*.sh` line
alone). The remaining ten files — the retail till and its cart, the payment
page, the product wizard and detail page, the document renderer and the
settings page — are unions worked file by file; their outcomes and the doubts
they raised are listed in the merge commit and below.

**The ten worked files.** Each union was resolved by one agent and checked
by another, adversarially, against both parents; what follows is what the
check changed or could not settle.

- *The retail till, its cart and the payment page.* A line is priced from the
  size it names (`linePrice`) and discounted per unit or per line as `main`
  says (2026-09-07), so `computeDiscount` takes the quantity; the cap is
  `stockCap(product, variant)` in `cart.ts`, re-exported from the cart store
  so the stepper and the warning still read one function. `setQty` keeps
  their conditional clamp (a measured line floors at 0.001, D134) and
  `main`'s "floor last" order, so a cap of 0 leaves a line visibly short
  instead of clearing its warning. The one place the stock guard runs is
  `commitAdd`, judged against the chosen size; a scanned product whose every
  size is out is refused before the picker opens (both parents refused it,
  the first union let it through). The manager-approval dialog says which
  basis it is approving. `noteItem` looked its line up by product id against
  a line key — their latent bug; fixed. The payment page maps lines through
  the sale mapper, which now carries `discountBasis` and is pinned to; the
  page no longer states the basis a second time.
- *The product wizard and the detail page.* The union of both `WizardState`
  shapes; their `taxRatePercent` prop reaches the three `<StepDetails>` renders
  `main` had added without it (`null` — unresolved, which is what those tests
  are not about). Their `resolveImageUrl` wrap on the detail page's two
  `<ProductImage>` sites was dropped as a no-op: the component resolves the
  URL itself and neither side had touched it.
- *The document renderer.* One import list; the discount note and per-line tax
  amount both render; the shop-timezone date sits beside their columns.
- *The settings page.* Timezone and tax rate are two dirty flags and one
  `PUT`; the tax-rate render test's fixture gained the timezone field.

**A regression `main` had already fixed once, caught by the check.** Their
till reads the ONE read model (D101), and the read model decided "has a
count" from `sellableKind` alone. `deriveSellableKind` maps a QuickBooks
NonInventory item to `STOCK_ITEM`, and the migration that added the column
left every legacy Service row there too — so on the merged till a Tile Shop
NonInventory item at its placeholder 0 read `OUT`, was greyed out, and
blocked the cart it was in: POL-1976 again (`main` 1ba3900). The read model
now says UNTRACKED for anything whose type is not Inventory, which is the
sale guard's own rule (`trackInventory: product.type === 'Inventory'`); the
item carries its `type` so the tile can still say "Non-Inventory" rather
than "Service" (D16); both directions are pinned server- and client-side.
The held-basket mapper had the same silent drop as the sale mapper and now
IS the sale mapper plus the note.

**Counts and catalogue.** The route matrix reads 316 routes, 216 guarded,
100 open (their 309/210/99 plus the tabs' and the queue's routes); its
per-controller tables were already fifteen controllers behind the registry
before this merge and are left as they were — the totals are what the spec
enforces. The catalogue gained forty-three rows for D120–D135 (their branch
wrote none) — PROD, POS, SET, DOC, two new sections (STK, RPT) and the
Exchange rows, whose "not implemented" banner D128 has made false; EXC-T-005
stays blocked because retail runs no accounting provider. Writing them found
four records ahead of their code: D135's pack selector (planning only),
D134b's switching warning, D120's tax-inclusive display (`taxInclusive` is
stored and read by nothing) and D125's dimension-to-library mapping screen;
and two screens reachable only by URL (`/stock-takes`, `/products/barcodes`).

**Left as found.** Twelve `no-unused-vars` warnings in the API — eleven on
this branch before the merge, one theirs (`replacementValue` in the exchange
service); the cart store's hydrate effect reads `shopTz` outside its
dependency list, identical on both parents; prettier drift on lines each
side authored. None was introduced here.

---

### D136a — the four commits that followed, merged the same way

`origin/feature/retail-template` moved on by four commits the same day
(1887632 → 76ad3ac: the server refuses measured goods outside RETAIL,
D134e; a refunded or voided sale keeps its receipt and a void is stamped;
the SKU leaves the 80mm receipt and the A4 column defaults off for new
workspaces; the wizard's variations come from the attribute library,
D125). They were re-pulled and merged as a second merge commit.

**The same renumber, the same way.** The four were cherry-picked onto the
renumbered tip (`9c557af`) — two of them met the renumber commit on the
same comment lines and took the incoming text — and their twenty-three
references (D104 → D125, D104a → D125a, D109 → D130, D113c → D134c, D113e →
D134e) were moved in one commit on the temporary branch, which is the
merge's second parent. No migration, no schema, no decision-log change on
their side.

**No textual conflict; two of our specs pinned what they changed.** Git
auto-merged all fourteen files, six of which D136 had unioned by hand.
`product-availability.spec.ts` (D101) mocks the attributes service and
now also stubs the D134e gate; the D99 geometry round-trip in
`settings.service.spec.ts` used `showSku`'s default as its "untouched
field keeps its value" example — it now stores `true` first, which is the
value a flattening merge would actually lose. Both re-pointed at their
intent, neither weakened (D16, D30). The D10 column tripwire is unchanged.

**What a Tile Shop sees, for the record (D16).** Their 5.10 removes the SKU
line from the 80mm SALES receipt for every tenant — the return receipt
(`return-receipt.template.ts`) still prints it, so a refund slip now shows
what the sale slip hides — and moves the A4 SKU column's DEFAULT to off.
The settings service has written the whole documents object on every save
since its first version, so any tenant that ever saved its settings or
uploaded a logo keeps its column; only a workspace that never did loses
it, and the web's offline fallback profile still says `true`. Neither
change is covered by a decision record on their side — the commit calls it
"a deliberate product change" — and both reach the QuickBooks pilot.
Merged as written; flagged to the PO rather than reverted (O11). Their
reprint change is a fix, not a wording change: a fully returned Tile Shop
sale's receipt button has always rendered and now works. The VOID stamp is
dormant everywhere — nothing writes `Sale.status = 'VOIDED'` yet.

**What the review changed.** Four reviewers and two skeptics per finding
read the three-way diffs. Their commit cites a D134e that no branch ever
wrote; it is recorded above from the commit's own reasoning. Their
category-change reconciliation unmapped a dimension but left its options'
library links, exactly the shape the server refuses
(`ATTRIBUTE_LINK_INCOMPLETE`); the options now unlink with the dimension,
their names kept, asserted from both sides. Their DRAFT refusal comment
says the till no longer offers the button, but only the sale page was
gated — the sales list's reprint icon, whose handler swallows the
refusal, is now gated the same way. The API spec, the integration plan and
five catalogue rows that described the pre-D134e or pre-reprint behaviour
were re-pointed. Left as their design, for the PO: once a workspace has
any library definition, a pre-5.11 dimension renders as an unchosen
picker beside its typed options; and the create path runs the D134e gate
before the D134c unit check while the update path runs them the other
way round, so a hardware `DECIMAL` create with no unit is refused for the
domain and the same update for the unit.

### D137 — merging `fix/issues-restaurant`'s follow-up: an unbilled order is Unpaid

`origin/fix/issues-restaurant` moved on by one commit after D119
(`f6e45a6`, 2026-09-08): a restaurant order with no Sale of its own now
reports `paymentStatus: UNPAID` instead of `null`, the queue renders a
"Not tracked" badge where a row genuinely carries no payment state of ours
(a third-party order, a cancelled or draft one), and the products screen
gains the shared search normaliser, a Clear control and an accessible
name for its search box while its header loses the Categories button.
Seven files, no textual conflict, no migration, no reference to renumber.

**What the widening means.** Until now a Sale was written only at
settlement, so an order placed, cooked and handed over but never billed
carried no payment status — and the queue's Unpaid chip, an equality test
on that field, skipped exactly the orders somebody still has to chase. Their
change reads `UNPAID` as "nobody has taken the money yet"; `CANCELLED` and
`DRAFT` stay `null` because nothing was ever owed. The commit cites "D53"
for the narrower reading; this log holds no D53 record — D52 is followed
by D54, and no D53 heading ever existed in the history — and the narrower
reading lived only in the old code (`sale?.paymentStatus ?? null`). D52's
"a restaurant bill legitimately exists unpaid — `paymentStatus: UNPAID`
already records that" is about the Sale row and is not what was widened.
Nothing in D110, D117 or D119 reads `null` as "not yet billed", so no
consumer changes meaning; the derived field stays derived, and D117's
settled takeaway still reads from its Sale. The review found two places
their commit left behind: the order drawer still printed a bare dash where
the row now says "Not tracked" (both read the same badge now), and the
third-party projection's comment still promised a dash. A products render
test on our side never mocked the brands request the retail merge added;
it does now, so it no longer touches a live API.

**The products header.** Their commit drops the Categories button because
the inventory tabs above the list already carry a Categories tab to the
same route; the merged page still renders those tabs, so the screen stays
reachable for every business kind. The search box collapses runs of
whitespace the way Customers and Sales already do.

## D138 — a tenant defines its own business details, and D135's packs are withdrawn

**Status:** accepted and **built**, 2026-09-09. **Retail only.** No schema change,
no migration. **Supersedes D135**, which is withdrawn unbuilt.

### The problem, restated from D135

`ProductAttributesService.schemaForTenant` resolved **one schema per business
type**. The `RETAIL` descriptor declares the clothing list — `material`, `fit`,
`careInstructions`, `gender`, `season` — and clothing and grocery are both
`RETAIL` because **Q12 resolved: do not split `RETAIL`**. So a grocer was asked
for **Fit** and **Season**, and `validateAttributes` refused `allergens` as an
unknown key. Not a missing feature; an actively wrong one.

### Why D135's answer is withdrawn

D135 proposed that a **domain** declare named packs (`attributePacks`) and a
tenant select one, stored in a new nullable column
`TenantBusinessProfile.cataloguePack`.

It is withdrawn for three reasons, none of which were visible at planning time:

1. **It does not actually answer the question.** A pack is a list somebody else
   chose. The grocer whose problem opened D135 does not want *our* grocery pack;
   they want `expiryDate` because they sell dairy. D135 itself conceded this —
   "What this does NOT decide: the grocery pack's field list… that draft needs a
   real grocer before it is committed to". A pack ships the same wrongness with
   a different list, and then needs a code change and a deploy every time a
   tenant asks for one more field.
2. **It costs a migration to store a choice we already have somewhere to put.**
   `TenantSettings.data.catalogue` is a JSON blob that has held tenant catalogue
   configuration since 5.8. A tenant's own field list is exactly that shape.
3. **It is strictly less powerful for strictly more schema.** A tenant-authored
   list *contains* packs: "the grocery pack" is a list a tenant can type once.

### The decision

**A tenant whose domain allows it defines its own business details.** The list
lives in `TenantSettings.data.catalogue.businessDetails` and replaces the
domain's declared `attributeSchema` for that tenant.

```ts
// capabilities.ts — optional, for the same reason `measuredGoods` is.
readonly catalogue: {
  readonly configurableBusinessDetails?: boolean;
};
```

`true` on the **retail descriptor** only. It could not live in
`RETAIL_CAPABILITIES`, because that constant **is** the hardware template
(D134e's finding, unchanged); it sits on the one line where the two domains
differ. Optional rather than required, deliberately: required would mean editing
the hardware, food-service, hotel and general templates to declare that nothing
about them changes.

**Three states, all distinct:**

| Stored value | Meaning | Wizard |
|---|---|---|
| **absent** | the tenant has said nothing | the domain's list — every tenant today |
| **`[]`** | "we track none" | the step disappears (`visibleSteps`) |
| **a list** | the tenant's own fields | that list |

Absence is the safety property, and it is the same one D135 wanted from a
nullable column without needing the column: every existing tenant — clothing,
hardware, restaurant, every domain — resolves exactly as it does today with no
backfill. Only a tenant that opens the tab and saves sees anything different.

### One resolver, not two

`BusinessDetailsService.schemaFor` is the single resolver;
`ProductAttributesService.schemaForTenant` delegates to it. The wizard, `GET
/products/attribute-schema` and server-side attribute validation therefore
cannot disagree about what a tenant's fields are — which is the property D64
bought by declaring one list, and the one a second resolver would have spent.

**A stored list is ignored where the capability is off**, rather than obeyed. A
workspace that changes business type must not keep enforcing the previous
type's fields. The list is not deleted — changing back restores it.

### Field types

`text`, `enum` (dropdown) and the new `date` — the three the PO asked for. The
existing `integer`, `number` and `boolean` remain valid in the schema and are
still rendered and validated; they are simply not offered in the Settings
editor, because no tenant asked to author one and every type offered is a type
that must keep working forever.

`date` is a **calendar date**, validated as one:

```ts
export function isCalendarDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}
```

The round-trip comparison is the point: a pattern alone accepts `2026-02-31`,
and a browser date input on some platforms will hand exactly that over.

### D135's two traps, both answered

**1. Switching strands stored attributes.** D135 required the build to "either
refuse the switch once products carry attributes, or make it an explicit
operation with a warning naming the count". **The PO chose refuse.** Removing a
field, removing a dropdown option, or changing a field's type is refused with
409 and the count while any product records it:

> `3 product(s) still record "Material". Clear it on those products before removing the field.`

This matches `AttributeLibraryService.remove`, which refuses a definition a
variant points at. Nothing is cascaded and nothing is silently rewritten. The
guard fired for real on live data during development — the `Umbalakada` product
holds `careInstructions: "supiriyak"`.

**2. A field is a commitment.** The `key` is derived from the label once, when
the field is first saved, and then frozen. The Settings screen offers a rename
of the **label** and never of the key, because renaming a key orphans every
value already stored under it. D64 says this of the schema; it is equally true
of a tenant's own list.

### Why the API is not module-gated

`/products/business-details` is permission-gated (`product:read` / `product:manage`)
and **not** module-gated. Whether a workspace may define its own catalogue fields
is a **capability of its business type**, which the service reads and refuses on
(D56). A module gate would be a second, weaker answer to the same question —
right today, wrong the moment a second domain opts in. Hiding the Settings tab
is usability; the server remains the authority and refuses a workspace whose
domain does not offer it, whatever the browser draws.

### What this does NOT decide

**Whether any other domain gets it.** Retail alone, because retail alone has the
clothing-vs-grocery problem that opened D135. Hardware, food-service, hotel and
general are untouched, and a tripwire over the real registry asserts it.

**A grocery preset.** Deliberately not shipped. A tenant types its own fields;
that is the whole point of withdrawing packs. If a preset is ever wanted it is a
seed, not a schema.

---

## D139 — the Inventory tab bar is per workspace: Attributes and Barcodes are not for everyone

**Status:** accepted and **built**, 2026-09-09. No schema change, no migration,
no route removed, no API gate changed.

### The problem

`InventoryTabs` rendered a module-level array unconditionally, so every
workspace got the same seven tabs:

```
Products | Categories | Promotions | Attributes | Barcodes | Stock | Purchases
```

Two of those are not for every business:

- **Attributes** (D125's reusable variation-attribute library) pays for itself
  in a catalogue with many variants of the same few scales — Size, Colour, Fit.
  A hardware counter types a variation on the rare product that needs one and
  keeps no library of them. A kitchen's variants are not scales at all.
- **Barcodes** (Phase 5's in-store EAN-13 allocation, audit and shelf labels) is
  a stocked-goods activity. A kitchen does not barcode a portion of rice.

Both were doors to features those workspaces never walk through.

### The decision

| | Attributes | Barcodes |
|---|---|---|
| **RETAIL** | ✅ | ✅ |
| **HARDWARE** | ❌ | ✅ |
| **RESTAURANT / CAFE / BAKERY / HOTEL** | ❌ | ❌ |
| **GENERAL** | ✅ | ✅ |

Two optional capabilities, `catalogue.attributeLibrary` and
`catalogue.internalBarcodes`, resolved once by `resolveCatalogueTabs` in
`product-presentation.ts`. The tab bar reads flags and filters; it names no
capability and no business type.

### Why the two flags cannot live in the same place

`RETAIL_CAPABILITIES` **is** the hardware template — hardware reads it verbatim
and retail spreads it (D134e's finding, unchanged). Hardware and retail need
DIFFERENT answers for Attributes and the SAME answer for Barcodes, so:

- `internalBarcodes: true` on **`RETAIL_CAPABILITIES`** → hardware and retail
  both keep it, which is the point.
- `attributeLibrary: true` on the **retail descriptor's** spread → retail only,
  the same pattern `measuredGoods` and `configurableBusinessDetails` use.

`FOOD_SERVICE_CAPABILITIES` is **not edited at all**. Absent means false, so
restaurant, cafe, bakery and hotel lose both without the food-service template
being touched — which is the desired blast radius on a branch other teams merge
into.

### Why `GENERAL` keeps both

Nothing asked to change it. It showed both tabs before this decision, and
hiding two working screens from a template nobody was discussing would be a
regression smuggled in beside a requested change. Declared explicitly on
`GENERAL_CAPABILITIES` rather than inherited, because absent means false and
silence would have removed them.

### Why `HOTEL` loses both

It shares `FOOD_SERVICE_CAPABILITIES`. Giving it a different answer would mean
forking the hotel descriptor to contradict the capability set it exists to
reuse. HOTEL is the business type the seven hand-written predicates D56 replaced
had all independently forgotten; it is named in the tests for that reason.

### Why not `ProductBusinessKind`

The coarse `RESTAURANT` / `RETAIL` split already exists and is the obvious
shortcut. It cannot express this: its `RETAIL` bucket covers hardware, general
trade and retail together, and hardware must differ from retail on one flag and
match it on the other. A capability per surface is the only thing that says it.

### Hiding is usability — the routes and the API are unchanged

`/products/attributes` and `/products/barcodes` still render for anyone who
types the URL and holds the permission, and `/attribute-library` stays **shared
core**: D125 gated it on permission rather than business type deliberately, so
any workspace that does want a library may use one. This decision changes what
the bar draws and nothing else. CLAUDE.md: *frontend hiding is usability only;
the server remains the authority.*

That is also why nothing here is a security boundary, and why the change needed
no server work at all.

### Tests

`product-presentation.test.ts` asserts the exact map over the real registry —
walked from `BUSINESS_TYPE_VALUES`, so a new business type fails by name — plus
that the two flags disagree for hardware, which is the case a single shared flag
could not express.

`inventory-tabs.render.test.tsx` renders the real component and reads the tabs
off the screen, asserting the WHOLE sequence rather than the absence of one
label: "restaurant has no Barcodes tab" would hold for a bar that rendered
nothing, and rendering nothing is a live possibility when both capabilities are
optional.

Mutation-proven: removing the filter fails 5; swapping which flag gates which
tab fails 2 — and only the hardware case tells the swap apart, which is stated
in the spec.

---

## D140 — retail's bill prints on a roll; its quotations stay on the letterhead

**Status:** accepted and **built**, 2026-09-09. Frontend only. No schema change,
no migration, no route removed, no server behaviour changed.

### What was asked

Retail needs only a thermal bill. The A4 bill goes, and Settings' Layout and
Preview should be about the bill.

### Why it was not a one-line change

The Settings screen routed on `documents.proformaBill`, which means **"a
pre-payment bill is issued separately from the receipt"** — the bill a waiter
brings to a table before anyone has paid. It had been standing in for "prints on
80mm paper" since D96, and the two happened to coincide because food service was
the only thermal domain.

Retail breaks the coincidence twice over:

1. **A shop issues no proforma.** Flipping `proformaBill` to `true` for retail
   would assert something false about it in the domain registry — the proxy
   abuse D56 exists to prevent — and any future feature reading that capability
   for what it actually means would then be wrong about retail.
2. **Retail prints BOTH.** It rings up on a roll and quotes on a letterhead.
   `proformaBill` is one boolean between two surfaces, so it cannot say that at
   all: routing retail to the food-service surface strips the signature block,
   stamp, accent colour, logo placement, page size and column toggles — every
   one of which belongs to the **quotation** that retail still issues.

The second point is the one that decided the shape. Retail is not "A4 with a
thermal option" or "thermal with extras"; it genuinely prints two documents.

### The decision

**Two capabilities, replacing the proxy, and a third surface.**

```ts
readonly documents: {
  readonly proformaBill: boolean;   // unchanged, and no longer a discriminator
  readonly splitByItem: boolean;
  readonly thermalBill?: boolean;   // the BILL prints on an 80mm roll
  readonly a4Documents?: boolean;   // the tenant issues A4 documents on a letterhead
};
```

| | thermalBill | a4Documents | surface |
|---|---|---|---|
| **HARDWARE** | — | ✅ | `A4_DOCUMENTS` *(unchanged)* |
| **GENERAL** | — | ✅ | `A4_DOCUMENTS` *(unchanged)* |
| **RESTAURANT / CAFE / BAKERY / HOTEL** | ✅ | — | `THERMAL_BILL` *(unchanged)* |
| **RETAIL** | ✅ | ✅ | `THERMAL_BILL_AND_A4_DOCUMENTS` **(new)** |

`thermalBill` sits on the **retail descriptor's** spread, not in
`RETAIL_CAPABILITIES` — that constant **is** the hardware template (D134e), and
hardware still prints an A4 bill. `a4Documents` sits **on** the shared constant,
because hardware and retail both quote. `FOOD_SERVICE_CAPABILITIES` gains
`thermalBill: true`, which states directly what `proformaBill` had been standing
in for and changes no behaviour: food service resolved to the thermal surface
before this line and resolves to it after.

`proformaBill` is kept. A restaurant really does issue a pre-payment bill, and a
future feature may act on that. What it must never be again is a stand-in for
paper — a contract test now asserts it is read by **nothing**.

### What retail gets

| | |
|---|---|
| **Sale page** | "Print A4 bill" is gone. "Thermal receipt" stays — that IS the document |
| **POS payment** | the "Print A4 bill after payment" toggle is gone, and the auto-print is gated |
| **Branding** | unchanged — logo, accent, signature, stamp, all still the quotation's |
| **Layout** | the A4 page controls **plus** the read-only summary of what the slip prints |
| **Preview** | the bill preview and roll calibration **plus** the A4 chooser, minus "Invoice / Bill" |

### The one that would have been missed

The POS payment screen opened the A4 print window on **every completed sale** —
`printAfter` defaults to `true`. Removing the button from the sale page alone
would have hidden the door while the till kept walking through it. The auto-open
is now gated on the same flag the button is, and the flag is checked at the call
site as well as on the control: the toggle's state survives a profile that
resolves late, so a hidden switch left `true` would still have fired.

### Two structural changes this forced

**`LayoutTab` stopped being either/or.** It early-returned the bill summary,
because until now every workspace that printed a bill printed *only* a bill.
Each half is now guarded by its own flag, so all three surfaces read out of the
same code: summary only, controls only, or both.

**The Preview chooser drops "Invoice / Bill" where there is no A4 sale
document.** Previewing a document the operator cannot print is the dead control
D96 was written to remove. Quotation, return and exchange remain.

### A latent test defect this uncovered

The D96 contract test asserted the resolver "names the capability it routes on"
against **raw** source, so a capability named only in a doc comment satisfied it
— the exact vacuity D30 describes. It was live: after the discriminator moved,
the assertion still passed on a sentence explaining what the code no longer did.
It now runs on stripped source and pairs the positive with a negative.

### Hiding is usability

`/print/sales/[saleId]` stays ungated and a typed URL still renders an A4 bill,
exactly as D96 recorded. The server is unchanged; no API gained or lost a gate.
This decides what the screens offer.

### Scope deliberately not taken

The **A4 note** on the returns screen is offered to every workspace and is gated
by nothing at all — including food service, which has had no letterhead controls
since D96. That is a pre-existing inconsistency, older than this decision and
not what was asked for; it is recorded here rather than fixed in passing.

---

## D141 — a preview shows the operator's own trade, and their own name

**Status:** accepted and **built**, 2026-09-09. Preview/sample data only. No
schema change, no migration, no change to any real document.

### Two defects, both reported from a screenshot

A retail owner opened `Settings → Preview` and saw:

1. a **thermal bill full of restaurant food** — Chicken Fried Rice, Grilled
   Seer, Vegetable Kottu, Black Coffee — with a **service charge** row and a
   **table number**;
2. an **A4 quotation headed "Hardware POS"**, on a workspace whose business
   name has never been set.

Neither is cosmetic. The preview is the one place an operator checks whether
their logo is too wide, whether the note reads right, whether a long product
name wraps — and a bill full of somebody else's trade answers none of it. It
also reads as a bug, because it is one.

### Why the bill was full of food

`buildSampleBill` held one hard-coded catalogue, and it was a menu. That was
correct while food service was the only domain that previewed a thermal bill.
**D140 gave retail a thermal bill the day before**, and this list stopped being
read only by restaurants.

The service charge and the table are the same defect wearing different clothes:
a shop charges no service charge, so previewing that row shows a line its bill
will never print, and a table number on a counter sale is meaningless.

**The fix.** Two catalogues, selected by a new `billSampleKind` on the
presentation — `'FOOD_SERVICE' | 'RETAIL' | null`, resolved where every other
document decision is. The Settings component reads a flag and names no business
type, which is what the D96 contract test requires of it.

The retail basket is **groceries and clothing together**, because `RETAIL` is
one business type covering both (Q12 resolved not to split it) and a sample
showing one would look wrong to half the workspaces that see it. It carries a
size variant and a fractional weight deliberately: those are the two rows a
retail bill has that a restaurant's does not.

### Why the quotation said "Hardware POS"

`buildSampleDocument` fell back to the literal `'Hardware POS'` whenever
`documents.companyName` was unset — which is **every workspace that has not been
through Settings yet**. Checked against the database before believing it: every
retail tenant has `companyName: null`, so what the owner saw was the fallback,
not their data. The Settings field's placeholder was the same literal, which is
why it looked configured.

**The fix.** The preview now uses the **tenant's own registered name**. Swapping
one hard-coded vertical for another only moves the problem to whoever is not
that vertical; the tenant's name is the one answer right for all of them, and it
is what the operator would have typed anyway. Where even that is missing the
fallback is `'Your Business'` — neutral, because a missing name is not a reason
to claim a trade.

`previewHtml` became **async** to do it. That adds exactly one indexed lookup to
a Settings-screen render, and its spec's stub comment — which said the preview
path "never touches the database" — was corrected rather than left to mislead
the next reader.

### What was deliberately NOT changed

**The A4 sample line items are still hardware** — Portland Cement, TMT Steel
Bar, PVC Pipe. The same defect class as the bill's menu, and visible on a retail
quotation preview today.

It is left alone because fixing it properly means making `SAMPLE_ITEMS`
domain-aware, and the only home for a per-vertical catalogue that does not
re-introduce a business-type if-chain is the domain registry itself (D56) —
which would put preview illustration into the shared descriptors that every app
reads. That is a larger decision than a sample list deserves, and it was not
what was asked for. Recorded here so it is chosen deliberately rather than
found again.

It affects hardware, general and retail; food service never renders the A4
preview at all (D96).

---

## Open decisions

| ID | Question | Needed by |
|---|---|---|
| O1 | `mockSync()` fabricates QuickBooks document ids for a *disconnected Tile Shop tenant*, writing synthetic ids into financial records. Preserve, or change deliberately? | Phase 2 |
| O2 | Redis: yes or no? Determines the Socket.IO multi-replica adapter (D7, D11) and the settings-cache invalidation strategy. **Deferred at Phase 1.5 (D39): the abstraction ships without the dependency, and multi-replica operation stays unsupported until this is answered.** | Phase 4 |
| O3 | Service-charge tax treatment specifics, to be confirmed with an accountant (D8). | Phase 8 |
| O4 | Pilot restaurant: which tenant, how many branches, which printers, which channels. | Phase 4 |
| O5 | Commercial model (per-branch / per-register / per-module) — blocks subscription and entitlement design. | before entitlements |
| O6 | `InventoryReceiptLine.productVariant`: `RESTRICT` (what the database has since D44) or `SetNull` (what the schema implies)? Until answered, `migrate diff` keeps emitting the FK pair and it keeps being stripped (D110). | next migration |
| O7 | Should a list's pager hide when the rows fit one page? Their Orders screen does; every `main` list renders it (D110). | UI polish |
| O8 | Cancelling a counter order that D117 has settled and paid: refuse it, or record the refund? The takeaway status write has no transition guard (D119). | before the next restaurant deploy |
| O9 | How does the counter hand over a takeaway whose ticket the kitchen never bumped? The stepper D113/D117 named is gone (2026-08-10); handover is offered on READY only (D119). | before the next restaurant deploy |
| O10 | Should the clothing Retail template (D120) offer the Salesperson, the hardware-only owner-equivalent of D108? It seeds Owner + Cashier today (D136). | before the first Retail workspace |
| O11 | Their 5.10 (D136a) takes the SKU line off every 80mm SALES receipt (the return receipt still prints it) and turns the A4 SKU column's default off; both reach the Tile Shop, and a workspace that never saved its documents settings loses the column. Keep, or exempt the QuickBooks pilot (D16)? | before the next production deploy |
