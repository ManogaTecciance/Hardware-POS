# Hardware POS web - production image (Next.js standalone output).
#
# Built from the REPO ROOT as build context so the pnpm workspace
# (packages/shared) is available:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.axlopos.com/v1 \
#     -t hardware-pos-web .
#
# NEXT_PUBLIC_API_URL is compiled INTO the browser bundle, so it must be passed
# at build time (docker-compose.prod.yml does this via build.args). Changing it
# later means rebuilding the image, not restarting the container.

# ---- Build stage ----
FROM node:20-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy every workspace manifest so pnpm can resolve the full workspace graph
# (layer-cached on manifests).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json          apps/api/package.json
COPY apps/web/package.json          apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json   packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .

ARG NEXT_PUBLIC_API_URL
# CI=true makes apps/web/scripts/check-web-dev-running.mjs (the prebuild dev-server
# guard) exit immediately; there is never a dev server inside an image build.
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
# turbo builds deps first (^build): shared -> web
RUN pnpm turbo run build --filter=@hardware-pos/web

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# Standalone output preserves the monorepo layout (outputFileTracingRoot is the
# repo root in next.config.mjs), so server.js lives under apps/web/.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
