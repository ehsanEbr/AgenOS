# AgentOS - working agreement

AgentOS owns orchestration, intelligence, governance and the execution lifecycle. External LLM providers and agent
frameworks are replaceable infrastructure behind adapters. Architecture: modular monolith + independent workers,
TypeScript, Nx + pnpm, NestJS, React/Vite, PostgreSQL, Redis, Prisma. Current phase: **1.2 Infrastructure Foundation**
(see README). Queues, workers and all domain entities are later phases.

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
- `packages/contracts` depends on `zod` only (no NestJS, React, Prisma, Redis, ...). No Prisma types in contracts.
- In `apps/api/src/modules`, other modules are imported through their `index.ts` only.
- `@prisma/client` only inside `modules/database`; `ioredis` only inside `modules/redis`. Domain modules get data through
  their own repositories.
- Public package entry points only: no `@agentos/x/src/...` imports.

## Conventions

- API errors use the `ApiError` shape (`code`, `message`, `details?`, `correlationId`); non-HTTP errors never leak
  messages. Routes live under `/api/v1`. Liveness is `GET /api/v1/health`, readiness is `GET /api/v1/health/ready`.
- Request validation: `class Dto extends createZodDto(schema) {}` on `@Body()/@Query()`; the global pipe validates.
- Environment access only through the validated config (`modules/config` in the API, `shared/config/env.ts` in web).
- **Secrets**: never commit `.env`, never put real credentials in `.env.example`, never log connection strings or
  passwords (log error classes only), never return infrastructure details in API responses.
- Prisma: one `.prisma` file per domain under `apps/api/prisma/schema/`; migrations are committed; applied migrations are
  never edited; production uses `db:deploy` only.
- Redis is cache / ephemeral state only. PostgreSQL is the source of truth.

## Gotchas

- Apps consume the **built** `packages/contracts`; Nx handles this via `dependsOn: ^build`. When running a tool
  directly (not through Nx) build contracts first: `pnpm --filter @agentos/contracts build`.
- The Prisma Client is generated into `node_modules`. Nx runs the uncached `generate` target before API
  build/typecheck/test; if you run tools directly after a fresh install, run `pnpm db:generate` first.
- `pnpm infra:down` keeps data; `pnpm infra:destroy-data` deletes it (asks for confirmation). Do not run the latter without
  the user's explicit approval.
- API tests need SWC (`unplugin-swc`) so NestJS decorator metadata is emitted under Vitest.
- pnpm 11 blocks install scripts; allowed packages are listed in `pnpm-workspace.yaml` (`allowBuilds`).
- Run lint through Nx (`pnpm lint` / `nx lint <project>`). A bare `eslint` run without a cached Nx project graph skips
  `@nx/enforce-module-boundaries` (warning only).
- TypeScript is pinned to one version (`overrides` in `pnpm-workspace.yaml`); keep root, api and web in sync.
- Port 5173 may be taken by other local projects; Vite picks another port and prints it.
- The earlier Phase 1 build (BullMQ, worker, old compose) lives on branch `phase-1-foundation`.
