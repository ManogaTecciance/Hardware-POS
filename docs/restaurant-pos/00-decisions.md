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

---

## Open decisions

| ID | Question | Needed by |
|---|---|---|
| O1 | `mockSync()` fabricates QuickBooks document ids for a *disconnected Tile Shop tenant*, writing synthetic ids into financial records. Preserve, or change deliberately? | Phase 2 |
| O2 | Redis: yes or no? Determines the Socket.IO multi-replica adapter (D7, D11) and the settings-cache invalidation strategy. **Deferred at Phase 1.5 (D39): the abstraction ships without the dependency, and multi-replica operation stays unsupported until this is answered.** | Phase 4 |
| O3 | Service-charge tax treatment specifics, to be confirmed with an accountant (D8). | Phase 8 |
| O4 | Pilot restaurant: which tenant, how many branches, which printers, which channels. | Phase 4 |
| O5 | Commercial model (per-branch / per-register / per-module) — blocks subscription and entitlement design. | before entitlements |
