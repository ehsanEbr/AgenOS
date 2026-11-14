# AgentOS - working agreement

AgentOS owns orchestration, intelligence, governance and the execution lifecycle. External LLM providers and agent
frameworks are replaceable infrastructure behind adapters. Architecture: modular monolith + independent workers,
TypeScript, Nx + pnpm, NestJS, React/Vite. Current phase: **1.1 Monorepo Foundation** (see README).

## Rules (from the architecture spec, section 20)

1. Read the relevant docs in `docs/` before changing code.
2. Never redesign core architecture without an ADR in `docs/adr/`.
3. Never bypass module boundaries (enforced by ESLint; see `docs/architecture/monorepo.md`).
4. Never add a dependency without stating why (commit/PR description; record important ones in an ADR).
5. No unnecessary abstractions.
6. Never silently remove existing functionality.
7. Write tests alongside implementation.
8. Before finishing a task run `pnpm verify` (lint, typecheck, test, build).
9. Keep changes within the assigned phase; do not start the next phase without approval.
10. Update docs when architecture or contracts change.

## Boundaries

- `apps/web` imports only `@agentos/contracts`. Never backend code. Applications are never imported by anything.
- `packages/contracts` depends on `zod` only (no NestJS, React, Prisma, Redis, ...).
- In `apps/api/src/modules`, other modules are imported through their `index.ts` only.
- Public package entry points only: no `@agentos/x/src/...` imports.

## Conventions

- API errors use the `ApiError` shape (`code`, `message`, `details?`, `correlationId`); non-HTTP errors never leak
  messages. Routes live under `/api/v1`.
- Request validation: `class Dto extends createZodDto(schema) {}` on `@Body()/@Query()`; the global pipe validates.
- Environment access only through the validated config (`modules/config` in the API, `shared/config/env.ts` in web).
- Never log secrets; the logger redacts common credential paths, but do not rely on it.

## Gotchas

- Apps consume the **built** `packages/contracts`; Nx handles this via `dependsOn: ^build`. When running a tool
  directly (not through Nx) build contracts first: `pnpm --filter @agentos/contracts build`.
- API tests need SWC (`unplugin-swc`) so NestJS decorator metadata is emitted under Vitest.
- pnpm 11 blocks install scripts; allowed packages are listed in `pnpm-workspace.yaml` (`allowBuilds`).
- Run lint through Nx (`pnpm lint` / `nx lint <project>`). A bare `eslint` run without a cached Nx project graph skips
  `@nx/enforce-module-boundaries` (warning only).
- TypeScript is pinned to one version (`overrides` in `pnpm-workspace.yaml`); keep root, api and web in sync.
- Port 5173 may be taken by other local projects; Vite picks another port and prints it.
- The earlier Phase 1 build (Prisma, BullMQ, worker, Compose) lives on branch `phase-1-foundation`.
