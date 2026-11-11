# AgentOS - working agreement

AgentOS owns orchestration, intelligence, governance and the execution lifecycle. External LLM providers and agent
frameworks are replaceable infrastructure behind adapters. Architecture: modular monolith + independent workers,
TypeScript, Nx + pnpm, NestJS, React/Vite, PostgreSQL, Redis/BullMQ, Prisma.

## Rules (from the architecture spec, section 20)

1. Read the relevant docs in `docs/` before changing code.
2. Never redesign core architecture without an ADR in `docs/adr/`.
3. Never bypass module boundaries (see below).
4. Never add a dependency without stating why (PR/commit description).
5. No unnecessary abstractions.
6. Never silently remove existing functionality.
7. Write tests alongside implementation.
8. Before finishing a task run `pnpm verify` (lint, typecheck, test, build); if you touched DB/queue code also
   `pnpm test:integration`.
9. Keep changes within the assigned phase.
10. Update docs when architecture or contracts change.

## Boundaries

- `apps/web` imports only `@agentos/contracts` (scope:shared). Never backend code. Enforced by ESLint.
- Backend domain modules (`apps/api/src/modules/*`) expose application interfaces; other modules must not reach
  into their repositories/Prisma models.
- Workers do not share mutable in-memory state with the API. Queue payloads carry ids only, never credentials.
- Shared request/response shapes live in `packages/contracts` as Zod schemas; the API validates with them and the
  OpenAPI document is generated from them.

## Conventions

- Env access only through `@agentos/config` (validated); never read `process.env` ad hoc.
- API errors use the `ApiError` shape (`code`, `message`, `details?`, `correlationId`); non-HTTP errors never leak
  messages. Routes live under `/api/v1`.
- Job handlers must be idempotent (BullMQ is at-least-once).
- Never log secrets; the logger redacts common credential paths, but do not rely on it.
- Prisma: UUID keys, `timestamptz`, snake_case via `@map`. Migrations are committed.

## Gotchas

- Run `pnpm build` once before `pnpm dev`: apps consume the built output of `packages/*` and `database`.
- API tests need SWC (`unplugin-swc`) so NestJS decorator metadata is emitted under Vitest.
- pnpm 11 blocks install scripts; allowed packages are listed in `pnpm-workspace.yaml` (`allowBuilds`).
- Port 5173 may be taken by other local projects; Vite will pick the next port, and the proxy still works.
