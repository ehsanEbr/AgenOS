# Monorepo architecture (Phase 1.1)

Implements the foundation described in the specification, sections 4 and 17, reduced to the scope of Phase 1.1.

## Workspace

- **pnpm workspace** (`pnpm-workspace.yaml`): `apps/*`, `packages/*`. Package manager pinned via `packageManager`.
- **Nx 21** orchestrates tasks. Projects are discovered from `package.json` files; targets are the package
  scripts (`dev`, `build`, `lint`, `typecheck`, `test`). `nx.json` defines caching and `dependsOn: ["^build"]`, so a
  project's dependencies (contracts) are built before it is built, typechecked or tested.
- **TypeScript**: `tsconfig.base.json` holds shared strict settings (`strict`, `noImplicitOverride`,
  `isolatedModules`, ...). Each project extends it and sets its own module system.

| Project              | Type | Scope   | Runtime / build                                         |
| -------------------- | ---- | ------- | ------------------------------------------------------- |
| `apps/web`           | app  | web     | React 19, Vite 7; ESM                                   |
| `apps/api`           | app  | backend | NestJS 11 on Express 5; CommonJS via `nest build` (tsc) |
| `packages/contracts` | lib  | shared  | Zod 4 only; built with tsup to CJS + ESM + `.d.ts`      |

`@agentos/contracts` ships both CJS (consumed by the Nest API) and ESM (consumed by Vite) from one build.
Applications consume the **built** output, which is why `dev` depends on `^build`.

## Dependency rules and how they are enforced

All rules run in `pnpm lint` (`eslint.config.mjs`). Each was verified with a planted violation.

| Rule                                                 | Mechanism                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` cannot import from `apps/api`             | Nx tags (`scope:web` may depend only on `scope:shared`) + `no-restricted-imports` for app package names; relative paths into other projects are rejected by `@nx/enforce-module-boundaries` |
| Shared packages cannot depend on application code    | `type:lib` may depend only on `type:lib`                                                                                                                                                    |
| Contracts cannot depend on infrastructure/frameworks | `no-restricted-imports` in `packages/contracts` (NestJS, React, Ant Design, TanStack, Zustand, Prisma, Redis, BullMQ, Express, pino)                                                        |
| No circular project dependencies                     | Built into `@nx/enforce-module-boundaries`                                                                                                                                                  |
| No wildcard/deep access into packages or domains     | `@agentos/*/*` deep imports banned; inside `apps/api`, another module may only be imported through its `index.ts`                                                                           |
| No unnecessary shared abstractions                   | Only `contracts` exists as a shared package; config and logging live in `apps/api` until a second consumer needs them                                                                       |

Not independently tested: the circular-dependency check (relies on the Nx rule's documented behaviour).

## apps/api

```text
src/
├── main.ts                 bootstrap, graceful shutdown (enableShutdownHooks)
├── app.module.ts           wires modules; registers the global pipe and exception filter
├── bootstrap/              configureApp: correlation id, /api/v1 prefix, CORS, Swagger
├── common/                 cross-cutting code (not a domain module)
│   ├── correlation-id.middleware.ts
│   ├── zod-validation.pipe.ts   global pipe + createZodDto()
│   ├── api-error.ts / all-exceptions.filter.ts   standard ApiError responses
│   ├── logging.ts               pino-http options, redaction, correlation id as request id
│   └── zod-openapi.ts           contract schema -> OpenAPI JSON Schema
└── modules/
    ├── config/             env validation (Zod), global APP_CONFIG provider
    └── health/             GET /api/v1/health
test/app.e2e.spec.ts        in-process pipeline test (no external services)
```

- **Validation**: parameters typed with a `createZodDto(schema)` class are validated by the global pipe; others pass
  through. Failures return `400 validation_error` with per-field details.
- **Errors**: every error is an `ApiError` (`code`, `message`, `details?`, `correlationId`). Unexpected errors return a
  generic message; details go to the log only.
- **Correlation id**: `x-correlation-id` is reused if well-formed, otherwise generated; it is returned on every
  response and used as the log request id.
- **OpenAPI**: Swagger UI at `/api/docs`, JSON at `/api/openapi.json` (OpenAPI 3.1), generated from contract schemas.
- **Config**: `API_HOST`, `API_PORT`, `LOG_LEVEL`, `NODE_ENV`, `CORS_ORIGINS`. Defaults bind to `127.0.0.1`; set
  `API_HOST=0.0.0.0` for containers.

## apps/web

```text
src/
├── main.tsx
├── app/        App (providers), router, AppLayout (shell)
├── features/   one folder per feature: home/, health/ (API status indicator)
├── shared/     api/ (client), config/ (env), stores/ (Zustand), ui/ (ErrorBoundary, page states)
└── test/       Vitest setup
```

- The **API client** (`shared/api/client.ts`) is the only place that calls `fetch`. It validates responses with
  contract schemas and converts failures into `ApiClientError`.
- **Environment** (`shared/config/env.ts`) validates `import.meta.env` with Zod at startup.
- **State**: server state via TanStack Query; client-only UI state via Zustand (sidebar collapse).
- The **API status** tag in the header is the only data-driven UI; it exists to prove the web -> contracts -> API
  path, not as a feature.

## packages/contracts

Exports `apiErrorSchema`, `CORRELATION_ID_HEADER`, `healthResponseSchema`, `idSchema`, `isoDateTimeSchema` and the
inferred types. Depends on `zod` only. Add a schema here only when both sides use it.

## Out of scope in this phase

PostgreSQL/Prisma, Redis/BullMQ, workers, authentication, organizations/projects, LLM providers, agent execution,
MCP, repository indexing, product dashboards. The previous Phase 1 implementation of the first four is on branch
`phase-1-foundation`.
