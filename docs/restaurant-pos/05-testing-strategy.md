# Testing strategy

## Baseline (measured on `523d6af`, 2026-08-04)

| Suite | Files | Cases | Result |
|---|---|---|---|
| API unit (Jest) | 6 | 47 | ✅ pass |
| Web unit (Vitest) | 2 | 26 | ✅ pass |
| API integration (Jest, real PostgreSQL) | 4 | — | 🆕 added in Phase 1 Slice 2 |
| E2E (Playwright) | 18 | 113 | ⚠️ requires a live web + API + database |
| `testcases.md` | — | 365 rows | manual inventory; IDs map 1:1 to spec titles |

Pre-existing coverage gaps (before Phase 1): `sales.service`, `payments`,
`products`, `customers`, `auth`, all three guards, the sync queue and worker, every
QuickBooks adapter, tenant isolation, branch isolation, concurrency, idempotency.
There was **no database integration harness** — every API spec hand-mocks Prisma.

## Standing rules

1. **Existing behavioural assertions and production regression scenarios must
   remain unchanged** (decision D16). Test infrastructure, configuration, fixtures,
   and shared utilities may be extended. Coverage must never be weakened or
   removed.
2. **If a change requires editing an existing behavioural test, the change is not
   backward-compatible and must be redesigned.**
3. Every phase adds tests. Every phase runs the full gate before being declared
   complete:
   `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:integration` ·
   `pnpm build`, plus Playwright where the environment supports it.
4. **Structural, scope-control and source-inspection tests must meet the
   architectural-test standard (decision D30).** It applies to every slice from
   Slice 6C-A.5 onward and is reproduced in full in
   [`00-decisions.md`](./00-decisions.md#d30--architectural-test-integrity-standard-resolves-risk-ah).

## Architectural-test standard in brief (D30)

A structural test must never pass merely because two counts match, a string is
absent from both paths, an analyser silently skipped a file, a fixture does not
resemble production, a regex matches neither state, a renamed symbol left the test
inspecting nothing, or the only assertion is that a future feature is absent.

Required of every such test:

| # | Rule |
|---|---|
| 1 | Assert the expected current behaviour **positively**. |
| 2 | Assert the prohibited or future behaviour **negatively**. |
| 3 | Prefer exact file or importer **sets** over counts. |
| 4 | Use **runtime provider spies** where possible. |
| 5 | **Mutation-prove** high-risk architectural tripwires. |
| 6 | Analysers are tested against valid, invalid, empty, renamed-symbol, nested/multiline and every-import-form source. |
| 7 | **Fail** if the analyser inspects zero relevant files unexpectedly. |
| 8 | Report which architectural tests were mutation-proven. |

Mutation proofs are written inline, next to the tripwire they justify. No
repository-wide mutation-testing infrastructure is introduced for this.

The analysers themselves live at
`apps/api/src/modules/providers/testkit/source-analysis.ts` and
`apps/web/src/testkit/source-analysis.ts`. Both throw rather than return an empty
result when they are asked to inspect files that are not there.

## Four regression layers

**Layer 1 — Characterisation.** Specs authored against *unmodified* production code
and proven green there **first**. That is what makes them a baseline rather than a
rationalisation of a refactor. Phase 1 Slice 3 covers the sale, return, and
document paths (see [`phase-01-plan.md`](./phase-01-plan.md)).

**Layer 2 — Existing unit suites, unmodified.** All 47 API and 26 web tests.
`documents.preview.spec.ts` is the Exchange-document regression (decision D2).

**Layer 3 — Integration against real PostgreSQL.** Behavioural snapshots compared
before and after a refactor: `Sale` row, `SaleItem[]`, `Payment[]`,
`Product.quantityOnHand` delta, `SyncJob` count and shape, `SyncLog` messages.

**Layer 4 — E2E, unmodified.** All 113 Playwright cases against a live stack.

## Integration-test harness

Approved under decision D5. Design and safety barriers are documented in
[`phase-01-plan.md`](./phase-01-plan.md); the operational summary:

- `docker-compose.test.yml` — PostgreSQL 16, port **5433**, database
  `hardware_pos_test`, `tmpfs` data directory (ephemeral by construction).
- `assertTestDatabase()` runs in Jest `globalSetup` and throws **before any
  connection is opened** unless every safety condition holds. It has its own unit
  spec, because a guard nobody tests is a guard that silently stops working.
- Schema applied with `prisma migrate deploy` (never `migrate dev`), so tests
  validate the exact SQL production will receive.
- `TRUNCATE … RESTART IDENTITY CASCADE` between tests, with the table list
  discovered from `information_schema` so it cannot drift as models are added.
- Fixtures are independent of `prisma/seed.ts`, which is demo data and will drift.
- Registered as a **separate** turbo task, deliberately **not** part of
  `pnpm test`, so the default suite stays fast and needs no Docker.

## Tenant and branch isolation (decision D17)

A repeated 100/100 isolation test is necessary but not sufficient. The full set of
requirements is in
[`04-permissions-and-roles.md`](./04-permissions-and-roles.md#phase-2--tenant-and-branch-isolation-decision-d17).

## The 20 critical scenarios → phase mapping

| # | Scenario | Phase |
|---|---|---|
| 1 | Existing Tile Shop checkout still works | 1 (regression gate) |
| 2 | Existing quotations still work | 1 |
| 3 | Existing returns still work | 1 |
| 4 | Existing exchanges still work → **Exchange A4 document renders identically** (decision D2) | 1 |
| 5 | Existing supplier features still work | 1 |
| 6 | Existing QuickBooks tenant still works | 1 |
| 7 | Restaurant tenant works without QuickBooks | 1 (acceptance) |
| 8 | A table can be opened | 5 |
| 9 | Multiple rounds can be submitted | 5 |
| 10 | Each round creates only one KOT per station | 5-6 |
| 11 | A duplicate request does not duplicate a round | 5 |
| 12 | A duplicate webhook does not duplicate an order | 10 |
| 13 | A split payment totals correctly | 8 |
| 14 | A table cannot close with an unpaid required balance | 8 |
| 15 | A sent kitchen item cannot be silently deleted | 5 |
| 16 | Unauthorized users cannot void items | 5-8 |
| 17 | Unauthorized users cannot reopen bills | 8 |
| 18 | Two users cannot complete the same payment | 8 |
| 19 | Tenant A cannot access Tenant B restaurant data | every phase |
| 20 | Printer failure does not lose the order | 6 |

Scenario 4 is scoped precisely: a regression test for the Exchange *transaction*
cannot exist until the transaction does. `testcases.md` carries `EXC-*` rows marked
`Blocked — feature not implemented` so traceability stays honest.

## Test categories required per phase

Unit · service · API · database integration · permission · tenant isolation ·
branch isolation · Playwright · regression · concurrency · idempotency ·
printer failure · external webhook.
