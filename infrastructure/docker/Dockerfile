# No "# syntax=docker/dockerfile:..." directive on purpose: it makes every build download a separate frontend image from the
# registry first, and a slow registry then fails the build ("DeadlineExceeded") before a single step runs. The built-in frontend
# of any current BuildKit supports everything used here (`RUN --mount=type=cache`).
#
# AgentOS application images for the LOCAL STACK and for system tests (`pnpm stack:up`, `pnpm test:system`).
# One build, three runtime targets: `api`, `worker`, `web`.
#
#   docker build -f infrastructure/docker/Dockerfile --target worker .
#
# These are development/verification images, NOT production images: the api and worker targets keep the whole built workspace
# including dev dependencies (simple, and the pnpm workspace layout stays exactly what `pnpm dev` uses). A production image
# pipeline is out of scope for this phase (docs/architecture/docker-compose.md, "Limitations").
#
# Secrets never enter an image: no .env is copied (.dockerignore) and nothing here takes a credential as a build argument.

ARG NODE_VERSION=22.14.0

# ---------------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
# Must equal "packageManager" in package.json (checked by tools/check-env.mjs).
ARG PNPM_VERSION=11.5.2
# openssl: Prisma's query engine links against it. ca-certificates: Prisma downloads engines during install.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-fund --no-audit pnpm@${PNPM_VERSION}
ENV NX_DAEMON=false \
    NX_NO_CLOUD=true \
    CI=true
WORKDIR /app
RUN chown node:node /app
USER node

# ---------------------------------------------------------------------------------------------------------------------
FROM base AS build
# Manifests first, so the (slow) install layer is reused until a dependency actually changes.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node apps/worker/package.json apps/worker/
COPY --chown=node:node packages/config/package.json packages/config/
COPY --chown=node:node packages/contracts/package.json packages/contracts/
COPY --chown=node:node packages/logger/package.json packages/logger/
COPY --chown=node:node packages/queue/package.json packages/queue/
COPY --chown=node:node tests/system/package.json tests/system/
RUN --mount=type=cache,target=/home/node/.pnpm-store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile --store-dir /home/node/.pnpm-store

COPY --chown=node:node . .
# Builds contracts, config, logger, queue, then api (Prisma client + nest build), worker and web, in dependency order.
RUN pnpm nx run-many -t build

# ---------------------------------------------------------------------------------------------------------------------
FROM build AS api
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

# ---------------------------------------------------------------------------------------------------------------------
FROM build AS worker
ENV NODE_ENV=production
# No port: the worker has no HTTP server. Compose observes it through `node apps/worker/dist/healthcheck.js`.
CMD ["node", "apps/worker/dist/main.js"]

# ---------------------------------------------------------------------------------------------------------------------
# Static web app + same-origin reverse proxy to the API (the browser code calls "/api/v1" exactly as under `vite dev`).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
