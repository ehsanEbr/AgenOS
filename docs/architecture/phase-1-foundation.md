# Phase 1 - Project Foundation

Scope: spec section 17. Goal: a production-minded skeleton with no domain functionality.

## What exists

| Area     | Implementation                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo | pnpm workspace + Nx 21 (tasks inferred from package.json scripts, cached; `dependsOn: ^build`)                                                                                                                 |
| API      | NestJS 11: config validation, pino logging, correlation IDs, global error filter (`ApiError`), Zod validation pipe, health (`live`/`ready`), OpenAPI 3.1 generated from Zod contracts, graceful shutdown hooks |
| Worker   | `apps/agent-worker`: BullMQ worker, idempotent handler, retry/backoff, unrecoverable-payload handling, graceful drain on SIGTERM/SIGINT                                                                        |
| Queue    | Queue names in `@agentos/contracts`; producer in API, consumer in worker; payload = ids only                                                                                                                   |
| Database | Prisma 6 + PostgreSQL (pgvector image); one migration (`system_jobs`)                                                                                                                                          |
| Frontend | React 19, Vite 7, Ant Design 5, React Router 7, TanStack Query, Zustand; typed API client validating responses with contracts; auth boundary (fail-closed switch); error boundary; loading/error states        |
| Tests    | Vitest unit tests everywhere, integration tests (real PostgreSQL + Redis) for API and worker                                                                                                                   |
| CI       | `.github/workflows/ci.yml`: format, lint, typecheck, unit, build, integration                                                                                                                                  |

## Request flow proven by the foundation

```text
Web -> POST /api/v1/system/jobs
      API: validate (Zod) -> INSERT system_jobs(QUEUED) -> BullMQ add {jobId, correlationId}
Worker: claim row (QUEUED|RUNNING -> RUNNING) -> compute -> COMPLETED   (idempotent)
Web -> GET /api/v1/system/jobs/:id (polling) -> result
```

## Deviations and known gaps

- **`system-jobs` queue and `SystemJob` table** are not in the spec; they exist only to satisfy "at least one
  background job can be submitted and processed" (Phase 1 DoD) and can be removed or repurposed as a diagnostics
  feature later.
- **Enqueue after insert is not atomic.** If Redis fails after the row is inserted, the job is marked `FAILED` and
  the API returns 503. The transactional outbox (spec 11.4) replaces this when domain events are introduced.
- **Not created yet** (no consumer in Phase 1): `packages/sdk`, `packages/observability`, `packages/test-utils`,
  `apps/repository-worker`, `apps/scheduler`, OpenTelemetry instrumentation. Logs carry the correlation ID so
  tracing can be layered on.
- **Docker images for the apps** are not built yet; Compose only runs PostgreSQL and Redis.
- **Prisma config** still uses `package.json#prisma` (deprecated, removed in Prisma 7); move to `prisma.config.ts`
  when upgrading.
- **Graceful shutdown** is unit-tested (`shutdown.spec.ts`) and the API closes cleanly in integration tests, but the
  OS signal path was not exercised on Windows (Node cannot deliver SIGTERM there). CI on Linux does not run a
  signal test either; add one when worker images exist.
- **Authentication** is a stub boundary only (`VITE_AUTH_MODE`); identity arrives in Phase 2.

## Phase 1 definition of done - status

| #   | Criterion                       | Status                                      |
| --- | ------------------------------- | ------------------------------------------- |
| 1   | Starts with documented commands | README quick start                          |
| 2   | PostgreSQL and Redis healthy    | Compose healthchecks + `/health/ready`      |
| 3   | Prisma migrations run           | `pnpm db:migrate` / `db:deploy`             |
| 4   | Frontend talks to backend       | Dashboard via Vite proxy                    |
| 5   | OpenAPI available               | `/api/docs`, `/api/openapi.json`            |
| 6   | Background job processed        | integration test + manual run               |
| 7   | Health checks                   | `/health/live`, `/health/ready`             |
| 8   | CI passes                       | workflow written; **not yet run on GitHub** |
| 9   | Tests pass                      | `pnpm verify`, `pnpm test:integration`      |
| 10  | Graceful shutdown               | see gap above                               |
