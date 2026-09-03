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

> **Partly superseded by D99 (2026-08-28).** `RETAIL` returns as its own business
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

---

## 2026-08-28 — Retail template

### D99 — the Retail template returns: clothing first, local inventory, one workspace per shop

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

---

## 2026-08-31 — Stock authority for a product with variants

### D100 — stock is tracked by variant id, not product id

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

### D99a — `RETAIL` is added in its own migration, and used in a later one

**D99 already authorises this migration.** It says in terms that
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

### D101 — per-line tax snapshots; per-category rates wait for grocery

Tech Lead, 2026-09-02. Supersedes nothing; narrows the Phase 3 scope D99
authorised.

#### What D99 said, and what changed

D99 authorises "per-category and global tax, no price bands, displayed
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

No new tables, no enum, no backfill. One migration — **D99a's two-migration rule
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

## Open decisions

| ID | Question | Needed by |
|---|---|---|
| O1 | `mockSync()` fabricates QuickBooks document ids for a *disconnected Tile Shop tenant*, writing synthetic ids into financial records. Preserve, or change deliberately? | Phase 2 |
| O2 | Redis: yes or no? Determines the Socket.IO multi-replica adapter (D7, D11) and the settings-cache invalidation strategy. **Deferred at Phase 1.5 (D39): the abstraction ships without the dependency, and multi-replica operation stays unsupported until this is answered.** | Phase 4 |
| O3 | Service-charge tax treatment specifics, to be confirmed with an accountant (D8). | Phase 8 |
| O4 | Pilot restaurant: which tenant, how many branches, which printers, which channels. | Phase 4 |
| O5 | Commercial model (per-branch / per-register / per-module) — blocks subscription and entitlement design. | before entitlements |

---

### D102 — promotions allocate per line, frozen at sale time

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
follows D101's returns rule directly — *"allocation, not recomputation: a return
can never refund a different amount of tax than the sale charged"* — and extends
it from tax to promotions.

#### Why not the order-level shape — the argument that decided it

Two shirts at 1,000 and a tie at 500, tie free under buy-two-get-one. The
customer pays **2,000** and returns the tie.

Allocating the 500 saving order-wide by line value gives the tie a weight of 500
against the shirts' 2,000, so the tie absorbs 100 of it:

    refund = 500 (its subtotal) − 100 (its share) = 400

**Rs 400 refunded on an item the customer paid nothing for.**

That is the same defect D101's `3.11` removed — refunding tax on a zero-rated
line — with the same cause: a basket-wide proportional allocation applied to a
saving that was never basket-wide. A BOGO discount belongs to the free *item*,
not to the basket by value.

Per line, the tie carries `promotionDiscountAmount = 500` and `lineTotal = 0`, so
the refund is `500 − 500 = 0`. Correct, with no special case.

#### Composition order

    unit price × quantity
      → line discount   (manual OR promotion — never both, see the invariant)
      → order discount  (computed on the subtotal AFTER the above)
      → tax             (on the base narrowed by `Product.taxable`, D101)

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
the same relationship D100 records between `Product.quantityOnHand` and the
per-variant rows.

#### What this buys with no further work

- **Tax follows automatically.** `taxableBase` reads `lineTotal` (D101, 3.14), so
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

