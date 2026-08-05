# AxloPOS — engineering guide

Monorepo: `apps/api` (NestJS), `apps/web` (Next.js App Router), `apps/e2e`
(Playwright), `packages/database` (Prisma), `packages/shared`.

Phase 1 is documented in [`docs/restaurant-pos/`](./docs/restaurant-pos/).
[`00-decisions.md`](./docs/restaurant-pos/00-decisions.md) is the decision log and
takes precedence over anything inferred from the code.

## Commands

```
pnpm lint            pnpm typecheck        pnpm build
pnpm test            # unit (api + web) and Playwright via turbo
pnpm test:integration  # brings up the test Postgres, runs, tears down
```

Playwright needs a running stack and must be run serially. `pnpm test` includes it,
so it fails on a machine with no stack up — run the workspaces individually
(`pnpm --filter @hardware-pos/api test`, `pnpm --filter @hardware-pos/web test`)
when that is not what you want to exercise.

## Architectural-test integrity (decision D30) — MANDATORY

This is a **permanent engineering rule**, not a slice-scoped convention. It applies
to every structural, scope-control and source-inspection test in the repository.

It exists because Slice 6C-A shipped tripwires that were green while asserting
something false — including one that asserted the presence of a function whose only
remaining occurrence was a comment saying it had been removed. A vacuous test is
worse than a missing one: it is indistinguishable from a passing test and stops
anyone looking again.

**A structural test must not pass merely because:**

- Two counts happen to be equal.
- A searched string is absent from both the adopted and the unadopted path.
- An analyser silently ignored a file.
- A fixture does not represent the real production structure.
- A regular expression fails to match either the valid or the invalid state.
- A renamed symbol caused the test to inspect nothing.
- The test asserts only that a future feature is absent, without proving the
  expected current path exists.

**Required of every such test:**

1. Assert the expected current behaviour **positively**.
2. Assert the prohibited or future behaviour **negatively**.
3. Prefer exact file or importer **sets** over counts.
4. Use **runtime provider spies** where possible, in preference to source text.
5. **Mutation-prove** high-risk architectural tripwires.
6. Analysers must have tests for: valid source, invalid source, empty source, a
   renamed symbol, nested or multiline syntax, and every applicable import form.
7. **Fail** when the analyser inspects zero relevant files unexpectedly.
8. Report which architectural tests were mutation-proven.

Mutation proofs are written **inline**, in the same spec as the tripwire they
justify. Do **not** add repository-wide mutation-testing infrastructure.

Shared analysers, both of which throw rather than returning an empty result:

- `apps/api/src/modules/providers/testkit/source-analysis.ts`
- `apps/web/src/testkit/source-analysis.ts`

Neither may be imported by application code; a contract test enforces that.

## Provider abstractions (D28, D31)

Tenant behaviour varies by `InventoryMode` and `AccountingProviderKind`. The routing
decision belongs to a **provider or resolver**, never to conditionals scattered
through a service or a component.

- **Backend.** `ProductsService`, `SalesService` and `ReturnsService` resolve one
  provider per operation and react to a provider-neutral result. They must not
  inject `BusinessProfileService` to trade one hard-coded QuickBooks branch for
  several profile branches.
- **Frontend.** The product screens read view flags from the pure resolver
  `apps/web/src/lib/products/product-presentation.ts`. No product component
  compares an inventory mode. The mode comes from `GET /v1/platform/profile` and is
  never inferred from `quickbooksItemId`, `syncStatus` or the business type.
- **Unresolved is its own state.** While the profile is loading, and after a failed
  request, the client shows no external action and defaults to no mode. It never
  assumes the legacy QuickBooks configuration.

Frontend hiding is **usability only**. The server remains the authority and still
refuses operations whose controls are hidden.

## Conventions

- Comments explain *why*, especially where a decision looks arbitrary. Match the
  density of the surrounding file.
- Preserve existing QuickBooks (Tile Shop) behaviour and wording exactly unless a
  decision record says otherwise. Existing behavioural assertions must not be
  edited to accommodate a refactor (D16).
- No Prisma migration without an explicit decision record.
