# Staging readiness — Phase 1.5.10

This is the reference document for setting up a staging environment for
AxloPOS. **No production infrastructure has been provisioned here** —
this document describes what a staging environment must look like, so
that the deployment gate (D4) can be satisfied later without further
design work.

Nothing in this document instructs anyone to touch production. Per
decision D4, production deployment is blocked absolutely and this
document does not reopen that. It describes staging.

---

## 1. Environment topology

- **One API replica** for the pilot.
  Rate-limit and settings caches are process-local (Phase 1.5.10). The
  API refuses to boot when `APP_REPLICA_COUNT` > 1 without a distributed
  rate-limit store (`assertReplicaSafetyOrExit`). Scaling out is not a
  configuration change; it requires a Redis-backed store and re-testing.
- **One web replica** behind the API's `WEB_ORIGIN`.
  The web app is stateless. Multi-replica is safe here at any time.
- **One PostgreSQL 16 instance** with `hardware_pos_staging` database.
  Staging must not share a database with production.
- **One S3-compatible bucket** for uploaded product images.
  LocalStack is acceptable for internal staging; a real bucket is
  required only if the pilot uses external QuickBooks.

## 2. Database setup

- Staging database is provisioned **empty**, then migrated via
  `prisma migrate deploy` as a separate step before the first API
  boot. `RUN_MIGRATIONS_ON_BOOT` remains **false** (D15).
- Seeding is optional: `pnpm db:seed` creates development tenants,
  which is fine for a *demo* staging but not for a *pilot* staging with
  real users. The pilot chooses one.
- Backup: run `pg_dump -Fc hardware_pos_staging > staging-<date>.dump`
  once per hour during pilot hours. Retain 7 days.
- **Restore verification:** every backup restores into a scratch
  database at least weekly. A backup that has never restored is not
  a backup.

## 3. Sanitized data policy

- **No production data ever lives in staging.** No exports of real
  customer records, no cloned QuickBooks connections, no live
  passwords or PINs.
- If the pilot needs realistic data, generate it (`pnpm db:seed`
  extended, `provision-tenant.ts` variants).
- Staging users get generated credentials rotated every 30 days. The
  rotation is a human step; no automation writes credentials to a
  shared store.

## 4. Secret management

- Every secret in staging is set via environment variable, not a file
  checked into any repository. `.env.example` is the reference; actual
  secrets live in the operator's secret manager.
- **JWT_SECRET, TOKEN_ENCRYPTION_KEY, DATABASE_URL, QuickBooks OAuth
  credentials** are all separate from production. A staging secret
  cannot decrypt a production value.
- Rotation: a new JWT_SECRET invalidates every session (by design). A
  rotation therefore ships with a maintenance-window notice, or picks
  a low-usage hour.

## 5. Deployment sequence

Every deployment to staging follows this sequence (matching D4/D15
for production):

1. **Back up** the current staging database. Verify the backup restores
   into a scratch database.
2. **Build the image** (`docker build ...`). Do not start it.
3. **Diff the migrations** to be applied
   (`prisma migrate status --preview-feature`). Review the SQL by hand
   for any DROP, ALTER, or destructive DML — additive-only per D15,
   and CLAUDE.md forbids new migrations without a decision record.
4. **Apply migrations** as a separate step
   (`prisma migrate deploy`). This is the point of no return; a failure
   here restores from the pre-migration backup rather than "fixing
   forward".
5. **Start / update** the API and web containers.
6. **Health checks**: `GET /v1/health` returns 200,
   `GET /v1/platform/profile` (as a test user) returns the expected
   business type, `POST /auth/login` succeeds with a known credential.
7. **Smoke tests**: the four Phase 1 R-assertions that do not require
   payment integration — R1 (sale completes), R2 (no SyncJob for a
   LOCAL tenant), R14 (sidebar excludes disabled modules), R16 (the
   sync worker finds nothing to do for a LOCAL tenant).

## 6. Rollback

- **Preferred:** re-deploy the previous image; the migration is
  additive so the previous code reads the newer schema without
  incident (that is what "additive only" guarantees).
- **If a defect requires reverting schema:** restore the pre-migration
  backup taken in step 1. Announce the rollback and re-load any data
  written since the migration by hand from the audit log if possible.
- **Never** run a manual `DROP COLUMN` or destructive UPDATE against a
  live database. Preserving audit history is more important than
  hiding the temporary defect.

## 7. QuickBooks sandbox isolation

- Staging talks to the Intuit **sandbox**, never production.
- Sandbox realm IDs are checked in the boot log. If the connection's
  `environment` field is anything other than `sandbox`, staging refuses
  to enable the QuickBooks module for that tenant. (This is a
  deliberate policy for staging; production tenants operate against the
  production realm and the check is a config, not a hard-coded refusal.)

## 8. Test-user policy

- Every staging user has a real email that reaches a real inbox owned
  by an internal team member — so password-reset flows can be tested
  end-to-end without spoofing.
- PIN users on staging use PINs that are not the same as any known
  production PIN.
- Test users are documented in a shared, access-controlled place
  (not in this repo).

## 9. Logs and auditing

- API logs to stdout at INFO. `LOG_LEVEL=debug` is opt-in per boot for
  troubleshooting and never left on in staging by default.
- Audit logs remain in the database. Retention: 12 months rolling in
  staging, longer in production (production policy is not decided
  here).
- No log stream ever includes: passwords, PINs, hashes, access tokens,
  refresh tokens, QuickBooks credentials, or `Authorization` headers.
  `sanitizeAuditMetadata` covers the audit table; log statements are
  audited by hand on every new module.

## 10. Health checks

The pilot monitoring watches:

- `GET /v1/health` — 200
- API process CPU / memory
- Database connection count (Prisma default pool is 10; a burst above
  8 warns)
- Rate-limit warning in the boot log — repeated appearance of the
  "isDistributed=false" line across restarts is expected today but a
  scale-out attempt would suppress it if the store were swapped.

## 11. Deployment approval gate

A staging deployment does not need Product Owner approval per
deployment; a **production** deployment continues to be blocked absolutely
per D4. Staging is where the runbook above is exercised so that a future
production deployment (when D4 is lifted) is a routine execution of a
tested procedure rather than a discovery exercise.

---

## What is NOT delivered in Phase 1.5.10

- No production infrastructure. No production credentials. No pilot
  tenant provisioning. No monitoring platform integration (Grafana,
  Datadog etc.).
- No penetration-test claim. The Phase 14 exit gate stated in the
  roadmap remains unsatisfied — a review of the introduced surface is
  the substitute delivered under Phase 14 (partial).
- No Redis. D39 defers the dependency; the abstraction is in place and
  will accept a Redis adapter without a policy change when Phase 4
  forces the question (Socket.IO adapter).
