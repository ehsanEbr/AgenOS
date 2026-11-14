# AgentOS - working agreement

AgentOS owns orchestration, intelligence, governance and the execution lifecycle. External LLM providers and agent
frameworks are replaceable infrastructure behind adapters. Architecture: modular monolith + independent workers,
TypeScript, Nx + pnpm, NestJS, React/Vite, PostgreSQL, Redis, Prisma. Foundation phases are complete through **1.6 System Integration & CI** (see README). Domain entities, domain jobs and the API enqueuing work are later phases. Rulebooks:
`docs/architecture/backend.md` (read before touching `apps/api`), `docs/architecture/frontend.md` (read before touching `apps/web`) `docs/architecture/workers.md` (read before touching `apps/worker`, `packages/queue` or job contracts) and `docs/architecture/docker-compose.md` (read before touching Docker, Compose or process lifecycle/health).

## Rules (from the architecture spec, section 20)

1. Read the relevant docs in `docs/` before changing code.
2. Never redesign core architecture without an ADR in `docs/adr/`.
3. Never bypass module boundaries (enforced by ESLint; see `docs/architecture/monorepo.md`).
4. Never add a dependency without stating why (commit/PR description; record important ones in an ADR).
5. No unnecessary abstractions.
6. Never silently remove existing functionality.
7. Write tests alongside implementation.
8. Before finishing a task run `pnpm verify` (lint, typecheck, test, build); for database/Redis changes also
   `pnpm test:integration` (needs `pnpm infra:up`).
9. Keep changes within the assigned phase; do not start the next phase without approval.
10. Update docs when architecture or contracts change.

## Boundaries

- `apps/web` imports only `@agentos/contracts`. Never backend code, never Prisma/ioredis. Applications are never imported
  by anything.
- Web layers: `app -> features -> shared`. `shared/` never imports features/app; features never import app; app reaches a feature only via its
  `index.ts`; features do not import each other's internals or form cycles (ESLint + `tools/check-module-boundaries.mjs`).
- `packages/contracts` depends on `zod` only (no NestJS, React, Prisma, Redis, ...). No Prisma types in contracts.
- In `apps/api/src/modules`, other modules are imported through their `index.ts` only.
- `@prisma/client` only inside `modules/database` and a domain module's `infrastructure/` layer; `ioredis` only inside `modules/redis` (API) and `packages/queue`; `bullmq` only in `packages/queue` and `apps/worker/src/runtime` (the API never imports it).
  Domain/application/presentation layers never import drivers. Controllers never touch the database.
- Backend modules: public API is `index.ts`; no cycles (`tools/check-module-boundaries.mjs`, part of `pnpm lint`); layers point
  presentation -> application -> domain <- infrastructure; infrastructure modules are leaves.
- Public package entry points only: no `@agentos/x/src/...` imports.
- `apps/worker`: no NestJS, no Prisma/database (if a job needs the database, stop and write an ADR); `runtime/` never imports `processors/`, `config`, `app` or `main`; processors use the runtime only via `runtime/index.ts` and never import `bullmq`/`ioredis`. Shared backend packages (`config`, `logger`, `queue`) are `scope:backend`: the web app cannot import them.

## Conventions

- API errors use the `ApiError` shape (`code`, `message`, `details?`, `correlationId`); non-HTTP errors never leak
  messages. Routes live under `/api/v1`. Liveness is `GET /api/v1/health`, readiness is `GET /api/v1/health/ready`.
- Expected failures: throw `AppError(kind, code, message)` (framework-free). Anything else is an unexpected 500. Transactions are opened by
  application services with `TransactionRunner`; repositories take an optional `tx`.
- Request-scoped data (correlation id): `currentCorrelationId()` from `common/request-context`; never thread `req` through services.
- Request validation: `class Dto extends createZodDto(schema) {}` on `@Body()/@Query()`; the global pipe validates.
- Environment access only through the validated config (`modules/config` in the API, `shared/config/env.ts` in web).
- **Secrets**: never commit `.env`, never put real credentials in `.env.example`, never log connection strings or
  passwords (log error classes only), never return infrastructure details in API responses.
- Lists: `paginationQuerySchema` / `paginatedSchema` / `sortQuerySchema` from contracts. Document endpoints with `ApiZodResponse` etc.
- Prisma: one `.prisma` file per domain under `apps/api/prisma/schema/`; migrations are committed; applied migrations are
  never edited; production uses `db:deploy` only.
- Redis is cache / ephemeral state only. PostgreSQL is the source of truth.

Web conventions (details in frontend.md):

- HTTP only via `apiRequest` (no `fetch` elsewhere); endpoints live in the feature (`api.ts`); responses validated by `@agentos/contracts` schemas.
- Server data -> TanStack Query (key factory per feature, hooks in `queries.ts`); browser preferences -> the Zustand store in `app/state`; local UI state -> `useState`.
- Every user-visible string is translated (English + Persian, `Messages<typeof en>`); styling uses Ant Design tokens and **logical CSS properties only**.
- Use `Page`, `LoadingState`, `EmptyState`, `ErrorState`, `useNotify`; never static `message.xxx()`. Read config via `env`, never `import.meta.env`.
- Tests query by role/accessible name, use `renderWithProviders`/`renderApp` and contract-typed fixtures; never assert on Ant Design class names.

Worker / job conventions (details in workers.md):

- Delivery is **at-least-once**: every processor must be idempotent and honor `ctx.signal`; throw `PermanentJobError` when retrying cannot help. Never claim exactly-once.
- Jobs are defined once in `@agentos/contracts` (`defineJob`) and enqueued only through `QueueProducer` (`@agentos/queue`); the worker validates envelope and payload before any handler runs. Never log job payloads.
- Retry policy lives in code (`packages/queue/src/retry.ts`), not in environment variables.

System / infrastructure conventions (details in docker-compose.md, ci.md, environment.md):

- Every environment variable is declared in the app's config schema, documented in `.env.example` and, if containers need it, passed by Compose; `pnpm check:env` (part of `check:architecture`) fails on drift. Only `api` and `migrate` get database credentials; the worker never does.
- Services exit 0 on a clean shutdown. A worker that must be restarted exits non-zero and relies on the Compose restart policy (`on-failure:5`); **`docker stop`/`docker kill` are manual stops and never trigger it**, so signal the process inside the container when testing restarts.
- System tests (`tests/system`) use throwaway Compose projects named `agentos-systest-<id>` and never touch the developer's `agentos` project; never add a code path that deletes volumes of any other project.
- CI: one required status (`CI result`); every job calls a root script, so what CI runs is what you run. Do not add `continue-on-error`.

## Gotchas

- Apps consume the **built** `packages/contracts`; Nx handles this via `dependsOn: ^build`. When running a tool
  directly (not through Nx) build contracts first: `pnpm --filter @agentos/contracts build`.
- The Prisma Client is generated into `node_modules`. Nx runs the uncached `generate` target before API
  build/typecheck/test; if you run tools directly after a fresh install, run `pnpm db:generate` first.
- `pnpm infra:down` keeps data; `pnpm infra:destroy-data` deletes it (asks for confirmation). Do not run the latter without
  the user's explicit approval.
- Controller tests use `createTestApp()` (test/support); table-creating integration tests use `createIsolatedDatabase()`, never the dev database.
- API tests need SWC (`unplugin-swc`) so NestJS decorator metadata is emitted under Vitest.
- pnpm 11 blocks install scripts; allowed packages are listed in `pnpm-workspace.yaml` (`allowBuilds`).
- Run lint through Nx (`pnpm lint` / `nx lint <project>`). A bare `eslint` run without a cached Nx project graph skips
  `@nx/enforce-module-boundaries` (warning only).
- TypeScript is pinned to one version (`overrides` in `pnpm-workspace.yaml`); keep root, api and web in sync.
- Worker integration tests (`pnpm test:integration`) need `pnpm infra:up`; the process-level ones run the **built** `apps/worker/dist` (Nx builds it first). Real SIGTERM/SIGINT tests run on Linux/CI only (Windows Node cannot deliver SIGTERM): use a Linux container locally.
- `pnpm stack:down` also stops the infrastructure containers (data volumes are kept); run `pnpm infra:up` afterwards. Never run `pnpm infra:destroy-data` without the user's explicit approval.
- Git Bash rewrites `docker run -w /path`: prefix with `MSYS_NO_PATHCONV=1`. On Windows use `localhost` (not `127.0.0.1`) for the Vite dev server.
- Port 5173 may be taken by other local projects; Vite picks another port and prints it.
- `antd` and `@ant-design/icons` are pinned to exact versions (v6 changed defaults in minor releases): upgrade them together, run the suite, and look at the app in a browser.
- The earlier Phase 1 build (BullMQ, worker, old compose) lives on branch `phase-1-foundation`.
