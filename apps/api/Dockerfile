# Hardware POS API — production image (NestJS + Prisma + Puppeteer)
#
# Built from the REPO ROOT as build context so the pnpm workspace
# (packages/shared, packages/database) is available:
#   docker build -f apps/api/Dockerfile -t hardware-pos-api .
#
# Debian bookworm (glibc + OpenSSL 3) is chosen deliberately: `prisma generate`
# runs INSIDE this image, so the "native" query engine it produces is
# debian-openssl-3.0.x — the exact target the runtime needs. (If you ever build
# the client on the host and copy it in, add binaryTargets to schema.prisma.)
FROM node:20-bookworm-slim

# System deps:
#   openssl                     -> required by the Prisma query engine
#   chromium + fonts/libs       -> Puppeteer server-side A4 PDF generation
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
      chromium fonts-liberation \
      libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
      libgtk-3-0 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chromium instead of Puppeteer's bundled download.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# pnpm via corepack, pinned to the repo's packageManager version.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# ---- Install (layer-cached on manifests) ----
# Copy every workspace manifest so pnpm can resolve the full workspace graph.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json   packages/shared/package.json
RUN pnpm install --frozen-lockfile

# ---- Build ----
COPY . .
# turbo builds deps first (^build): shared -> database (prisma generate + tsc) -> api
RUN pnpm turbo run build --filter=@hardware-pos/api

# TZ=UTC makes "every datetime is stored in UTC" an invariant of the image rather
# than an accident of the host. Nothing user-facing depends on the process zone:
# screens render in the viewer's browser zone and documents in the shop timezone
# from settings.
ENV NODE_ENV=production \
    TZ=UTC \
    API_PORT=4000 \
    UPLOAD_DIR=/data/uploads

# Migrations are NOT applied on boot. Schema changes are a separate, approved
# deployment step (`docker compose run --rm api migrate`) — see the entrypoint
# and docs/restaurant-pos/06-migration-and-rollout.md. Set to "true" only for
# local/dev/CI containers where an unattended migration is acceptable.
ENV RUN_MIGRATIONS_ON_BOOT=false

EXPOSE 4000

# cwd stays /app; the API reads UPLOAD_DIR for local uploads (mount a volume
# there - see docker-compose.prod.yml). Pre-create it owned by `node` so the
# named volume inherits that ownership on first creation.
RUN chmod +x apps/api/docker-entrypoint.sh \
    && mkdir -p /data/uploads \
    && chown -R node:node /data

# Run unprivileged. Chromium is launched with --no-sandbox (pdf.service.ts), so
# it works the same as a non-root user; Prisma's engine is generated at build
# time and needs no runtime writes.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/apps/api/docker-entrypoint.sh"]
CMD ["serve"]
