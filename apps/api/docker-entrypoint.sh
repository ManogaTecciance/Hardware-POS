#!/bin/sh
# Hardware POS API — container entrypoint.
#
# Prisma migrations are NOT applied on boot by default. Applying schema changes
# is a deliberate, separately-approved deployment step: several API replicas may
# start concurrently, and an unattended `migrate deploy` would race them and
# alter the production schema with no backup checkpoint and no operator present.
#
# Commands:
#   serve     (default) start the API. Migrates first only when
#             RUN_MIGRATIONS_ON_BOOT=true — intended for local/dev/CI, never prod.
#   migrate   apply pending migrations and exit. This is the one-off production
#             deployment step; run it BEFORE starting or updating replicas.
#   <other>   executed verbatim (e.g. `sh` for a debug shell).
#
# See docs/restaurant-pos/06-migration-and-rollout.md for the deployment runbook.
set -eu

run_migrations() {
  echo "[entrypoint] Applying pending Prisma migrations (prisma migrate deploy)..."
  pnpm --filter @hardware-pos/database run db:deploy
  echo "[entrypoint] Migrations applied."
}

case "${1:-serve}" in
  migrate)
    run_migrations
    ;;

  serve)
    if [ "${RUN_MIGRATIONS_ON_BOOT:-false}" = "true" ]; then
      echo "[entrypoint] RUN_MIGRATIONS_ON_BOOT=true - migrating before start."
      if [ "${NODE_ENV:-}" = "production" ]; then
        echo "[entrypoint] WARNING: migrating on boot in NODE_ENV=production."
        echo "[entrypoint] WARNING: production deployments should run 'migrate' as a separate step."
      fi
      run_migrations
    else
      echo "[entrypoint] RUN_MIGRATIONS_ON_BOOT is not 'true' - skipping migrations."
      echo "[entrypoint] Apply them as a separate, approved step:"
      echo "[entrypoint]   docker compose -f docker-compose.prod.yml run --rm api migrate"
    fi
    exec node apps/api/dist/main.js
    ;;

  *)
    exec "$@"
    ;;
esac
