# ADR-0002: Phase 1.1 reduces the workspace to web, api and contracts

**Status:** Accepted
**Context:** A first Phase 1 implementation included PostgreSQL/Prisma, Redis/BullMQ, an `agent-worker` app, Docker
Compose, `@agentos/config` and `@agentos/logger` packages, and a job-submission demo. Phase 1.1 defines a narrower
"Monorepo Foundation" and explicitly puts those items out of scope.

## Decision

- Preserve the earlier work on git branch `phase-1-foundation`.
- On `main`, remove everything out of scope: `database/`, `apps/agent-worker`, `infrastructure/`, queue/DB/Redis
  code in the API, the job demo in the web app, and the `system-jobs`/queue/readiness contracts.
- Fold `@agentos/config` and `@agentos/logger` into `apps/api` (`modules/config`, `common/logging.ts`). With one
  consumer they were an unnecessary shared abstraction. Re-extract them when a second backend process (worker)
  exists.
- Replace the dependency-aware readiness probe (`/health/ready`) with a plain liveness endpoint (`GET /api/v1/health`), since
  there are no dependencies to check.
- Remove the web auth stub (`AuthBoundary`): authentication is out of scope.

## Consequences

- Phase 1 criteria that need infrastructure (migrations, background job, Compose) are not met on `main` and are
  re-introduced in later phases, starting from the preserved branch.
- Reintroducing these items requires an explicit phase decision; do not cherry-pick them into unrelated work.
