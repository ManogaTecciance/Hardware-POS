# Migrations and deployment runbook

## Migration policy

**Additive, forward-only, one migration per phase.** Named
`<timestamp>_<phase>_<subject>`.

Permitted without special approval:
- `CREATE TABLE`
- `ADD COLUMN` (nullable, or `NOT NULL` with a default)
- `CREATE INDEX`, `CREATE UNIQUE INDEX` on new columns
- `CREATE TYPE` (new enum)
- **Appending** a value to an existing enum

Requires explicit written approval plus a documented backfill and rollback:
- `DROP` anything
- `ALTER COLUMN … NOT NULL` on an existing column
- `ALTER COLUMN … TYPE`
- any rename
- repurposing an existing column
- removing or reordering an enum value — PostgreSQL does not support this cleanly;
  treat persisted enum values as permanent identifiers (decision D3)

Every migration is reviewed as **raw SQL** before commit, not just as a schema
diff. Widening an existing table is a two-step: relax, deploy, backfill, then
tighten in a later migration if needed.

## Environment matrix

| Environment | Database | How migrations are applied |
|---|---|---|
| Local development | `hardware_pos` on `localhost:5432` (`docker-compose.yml`) | explicit developer command — `pnpm db:migrate` |
| Integration tests | `hardware_pos_test` on `localhost:5433` (`docker-compose.test.yml`, `tmpfs`) | automatic in Jest `globalSetup` — `prisma migrate deploy`, disposable database only |
| Staging | *does not exist yet* — blocks production deployment (decision D4) | separate approved step |
| Production | `hardware_pos` on the private compose network | **separate approved one-off step. Never on container boot.** |

## The production migration gate (decision D15)

The production API container **must not** run `prisma migrate deploy` on startup.
Several replicas may boot concurrently and race each other, and an unattended
migration alters the schema with no backup checkpoint and no operator present.

Implemented as `apps/api/docker-entrypoint.sh`:

| Command | Behaviour |
|---|---|
| `serve` *(default `CMD`)* | Starts the API. Migrates first **only** when `RUN_MIGRATIONS_ON_BOOT=true`, and logs a warning if that happens under `NODE_ENV=production`. |
| `migrate` | Applies pending migrations and exits. **This is the production deployment step.** |
| anything else | Executed verbatim (e.g. `sh` for a debug shell). |

`RUN_MIGRATIONS_ON_BOOT` defaults to `false` in the image (`ENV` in the Dockerfile)
and is documented as `false` in `.env.prod.example`. It is read **only** by the
container entrypoint — running `pnpm dev` on a host machine ignores it entirely.

## Deployment runbook

### Local development

```bash
docker compose up -d                 # PostgreSQL 16 on :5432 (+ LocalStack S3)
pnpm db:generate
pnpm db:migrate                       # creates and applies a migration (interactive)
pnpm db:seed
pnpm dev
```

### Integration tests

```bash
pnpm test:integration                 # brings the test database up, migrates, runs, tears down
# or, to keep it running between runs:
pnpm test:integration:up
pnpm --filter @hardware-pos/api test:integration
pnpm test:integration:down
```

### Production deployment — with a schema change

> **Do not proceed unless every decision D4 precondition is satisfied:** a
> production backup, a *tested* restore, a staging environment or sanitized
> restorable snapshot, a migration dry run, passing regression tests, and a
> rollback or forward-fix plan.

```bash
# 1. Back up, and verify the backup restores somewhere else.
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres -d hardware_pos -Fc > backup-$(date +%Y%m%d-%H%M%S).dump

# 2. Build the new image without starting anything.
docker compose -f docker-compose.prod.yml build api

# 3. Review exactly what will be applied.
docker compose -f docker-compose.prod.yml run --rm --entrypoint sh api -c \
  "pnpm --filter @hardware-pos/database exec prisma migrate status"

# 4. Apply migrations as a separate, one-off step — BEFORE touching replicas.
docker compose -f docker-compose.prod.yml run --rm api migrate

# 5. Only now start / update the application.
docker compose -f docker-compose.prod.yml up -d api

# 6. Verify.
docker compose -f docker-compose.prod.yml logs -f api
curl -fsS https://api.axlopos.com/v1/health
```

### Production deployment — no schema change

Skip steps 1, 3, and 4.

### Rollback

1. **Prefer forward-fix.** Ship a new additive migration that corrects the problem.
2. If the schema change must be reversed, apply the phase's documented rollback SQL
   manually, then redeploy the previous image tag.
3. Restore from backup only as a last resort, and only with explicit approval —
   it discards every transaction written since the dump.

Because the policy is additive-only, a rollback is almost always "deploy the
previous image and leave the new tables in place, unused". New tables that nothing
references are inert.

## Phase 1 migration

`<timestamp>_add_tenant_business_profile` — **not yet generated** (Slice 4 is not
authorised).

- Creates 4 enum types and 2 tables (`TenantBusinessProfile`, `TenantModule`).
- **Zero `ALTER TABLE` against any pre-existing table.** The two `Tenant` relation
  fields are Prisma-side back-references and emit no SQL.
- **Zero `UPDATE` / backfill.** Existing tenants have no profile row and resolve to
  QuickBooks defaults in code — this absence *is* the backward-compatibility
  contract.
- Locking: two `CREATE TABLE` plus two `ADD CONSTRAINT` referencing `Tenant` (a
  handful of rows). Effectively instant.
- Rollback: `DROP TABLE "TenantModule", "TenantBusinessProfile";` then
  `DROP TYPE "ModuleKey", "AccountingProviderKind", "InventoryMode", "BusinessType";`
  No pre-existing row references either table, so rollback is total and lossless.
