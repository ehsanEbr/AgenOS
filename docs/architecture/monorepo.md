# Monorepo architecture (Phase 1.1, extended in 1.2 and 1.3)

Implements the foundation described in the specification, sections 4 and 17, reduced to the scope of Phase 1.1.

## Workspace

- **pnpm workspace** (`pnpm-workspace.yaml`): `apps/*`, `packages/*`, `tests/*`. Package manager pinned via `packageManager`.
- **Nx 21** orchestrates tasks. Projects are discovered from `package.json` files; targets are the package
  scripts (`dev`, `build`, `lint`, `typecheck`, `test`). `nx.json` defines caching and `dependsOn: ["^build"]`, so a
  project's dependencies (contracts) are built before it is built, typechecked or tested.
- **TypeScript**: `tsconfig.base.json` holds shared strict settings (`strict`, `noImplicitOverride`,
  `isolatedModules`, ...). Each project extends it and sets its own module system.

| Project              | Type | Scope   | Runtime / build                                                     |
| -------------------- | ---- | ------- | ------------------------------------------------------------------- |
| `apps/web`           | app  | web     | React 19, Vite 7; ESM                                               |
| `apps/api`           | app  | backend | NestJS 11 on Express 5; CommonJS via `nest build` (tsc)             |
| `apps/worker`        | app  | backend | Framework-free BullMQ worker host; CommonJS via `tsc`               |
| `tests/system`       | app  | backend | Docker system tests (vitest); drives the Compose stack from outside |
| `packages/contracts` | lib  | shared  | Zod 4 only; built with tsup to CJS + ESM + `.d.ts`                  |
| `packages/config`    | lib  | backend | Zod only; env parsing helpers (api, worker)                         |
| `packages/logger`    | lib  | backend | pino options and redaction (api, worker)                            |
| `packages/queue`     | lib  | backend | BullMQ + ioredis wrappers, retry policy, `QueueProducer`            |

`@agentos/contracts` ships both CJS (consumed by the Nest API) and ESM (consumed by Vite) from one build.
Applications consume the **built** output, which is why `dev` depends on `^build`.

## Dependency rules and how they are enforced

All rules run in `pnpm lint` (`eslint.config.mjs`). Each was verified with a planted violation.

| Rule                                                 | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` cannot import from `apps/api`             | Nx tags (`scope:web` may depend only on `scope:shared`) + `no-restricted-imports` for app package names; relative paths into other projects are rejected by `@nx/enforce-module-boundaries`                                                                                                                                                                                                                           |
| Shared packages cannot depend on application code    | `type:lib` may depend only on `type:lib`                                                                                                                                                                                                                                                                                                                                                                              |
| Contracts cannot depend on infrastructure/frameworks | `no-restricted-imports` in `packages/contracts` (NestJS, React, Ant Design, TanStack, Zustand, Prisma, Redis, BullMQ, Express, pino)                                                                                                                                                                                                                                                                                  |
| No circular project dependencies                     | Built into `@nx/enforce-module-boundaries`                                                                                                                                                                                                                                                                                                                                                                            |
| No wildcard/deep access into packages or domains     | `@agentos/*/*` deep imports banned; inside `apps/api`, another module may only be imported through its `index.ts`                                                                                                                                                                                                                                                                                                     |
| No unnecessary shared abstractions                   | A package exists only with two consumers ([ADR-0008](../adr/0008-shared-backend-packages.md)); the worker runtime stays in `apps/worker` until a second worker app needs it ([ADR-0006](../adr/0006-worker-runtime.md))                                                                                                                                                                                               |
| Database/cache drivers stay inside their layer       | `@prisma/client`/`prisma` only in `modules/database` and domain `infrastructure/` folders; `ioredis` only in `modules/redis` (API) and `packages/queue`; `bullmq` only in `packages/queue` and `apps/worker/src/runtime`; the worker has no NestJS or Prisma; domain/application/presentation layers, `apps/web` and `packages/contracts` import none of them (`no-restricted-imports`, see [workers.md](workers.md)) |

Workers (`apps/worker`; future `apps/scheduler`) are tagged `type:app` + `scope:backend` and may import `@agentos/contracts`,
`config`, `logger` and `queue`, nothing else from the workspace. `apps/web` (`scope:web`) can import only `scope:shared`, i.e. contracts.
The next paragraph describes how the allowlist was first verified, with a temporary project; the worker has since been checked
with planted violations (see workers.md). This was verified with a temporary worker project: contracts import allowed;
imports of web, api, a not-yet-existing app, deep paths and relative cross-project paths all rejected. Adding a new
importable package means adding it to `IMPORTABLE_WORKSPACE_PACKAGES` in `eslint.config.mjs`.

Caveats:

- `@nx/enforce-module-boundaries` is **skipped with a warning** when Nx has no cached project graph (e.g. a bare
  `eslint` run right after `nx reset` or a fresh clone). `pnpm lint` / `nx lint` always build the graph first, and CI
  uses them. Editors may not enforce the Nx rule until Nx has run once.
- The circular-dependency check relies on the Nx rule's documented behaviour and was not tested with a planted cycle.

## apps/api

NestJS modular monolith. The full structure, conventions and rules are in **[backend.md](backend.md)** (single source of truth); in short:

```text
src/main.ts, app.module.ts   composition root (global pipe + filters registered here only)
src/bootstrap/               HTTP setup shared by main.ts and tests
src/common/                  AppError, error filter, request context, logging, validation pipe, OpenAPI helpers
src/modules/                 config, database, redis, health today; one folder per future domain
prisma/schema/, prisma.config.ts   Prisma schema files (no models yet) and CLI configuration
test/                        e2e (stubbed infrastructure), integration (real PostgreSQL/Redis), shared test support
```

Infrastructure (PostgreSQL, Redis, Prisma workflow, readiness) is in [infrastructure.md](infrastructure.md).

**Backend module rules** (sibling modules only through `index.ts`, no module cycles, layer direction, infrastructure modules as leaves)
are specified in [backend.md](backend.md) section 2 and enforced by ESLint plus `tools/check-module-boundaries.mjs` (runs inside
the API's `lint` target and via `pnpm check:architecture`).

## apps/web

React 19 + Vite 7 + Ant Design 6 + React Router 7 + TanStack Query + Zustand + i18next. The full structure, layering rules, conventions and the
"add a feature" checklist are in **[frontend.md](frontend.md)** (single source of truth); in short:

```text
src/app/        composition: providers, the route table, the shell layout, preference state
src/features/   one folder per product area, public surface = index.ts (today: home, health)
src/shared/     bottom layer: API client, theme, i18n infrastructure, UI primitives (no knowledge of features/app)
src/test/       render helpers, media mock, contract-typed API fixtures
```

Dependency direction `app -> features -> shared` is enforced by ESLint; feature-to-feature internals and cycles by `tools/check-module-boundaries.mjs`
(run inside the web `lint` target and by `pnpm check:architecture`). `fetch` is allowed only in `shared/api/client.ts` and `import.meta.env` only in
`shared/config/env.ts`. Decisions: [ADR-0005](../adr/0005-frontend-architecture.md).

## packages/contracts

Exports `apiErrorSchema`, `CORRELATION_ID_HEADER`, `healthResponseSchema`, `readinessResponseSchema`, `idSchema`,
`isoDateTimeSchema`, the pagination/sorting contracts (`paginationQuerySchema`, `paginatedSchema`, `sortQuerySchema`) and the
inferred types. Depends on `zod` only. Add a schema here only when both sides use it.

## Out of scope (not yet implemented)

BullMQ and every worker/scheduler process, authentication, organizations/projects, LLM providers, agent execution, MCP,
repository indexing, product dashboards, and any database entity. The earlier Phase 1 implementation of queues and a
worker is on branch `phase-1-foundation`.
