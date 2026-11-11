# AgentOS

Platform for designing, running and observing AI agent systems. See the
[architecture specification](docs/architecture/technical-architecture-specification.md).

> **Status: Phase 1.1 (Monorepo Foundation).** The workspace contains an empty-but-real web shell, an API
> skeleton with its cross-cutting concerns, and a shared contracts package. There is no database, queue,
> authentication or product functionality yet.
>
> The earlier, larger Phase 1 build (PostgreSQL/Prisma, Redis/BullMQ worker, Docker Compose, job demo) is
> preserved on the git branch `phase-1-foundation` and will be re-introduced phase by phase.

## Prerequisites

- Node.js >= 22.12
- pnpm 11 (`corepack enable` selects the version pinned in `package.json`)

## Getting started

```bash
pnpm install
pnpm dev          # builds contracts, then starts the API and the web app
```

| What         | URL                                    |
| ------------ | -------------------------------------- |
| Web app      | http://localhost:5173                  |
| API health   | http://localhost:3000/api/v1/health    |
| Swagger UI   | http://localhost:3000/api/docs         |
| OpenAPI JSON | http://localhost:3000/api/openapi.json |

The web app proxies `/api` to the API in development, so no CORS setup is needed. If port 5173 is busy, Vite
prints the port it picked.

Start the applications individually:

```bash
pnpm --filter @agentos/contracts build   # once, and after changing contracts
pnpm --filter @agentos/api dev           # API on :3000
pnpm --filter @agentos/web dev           # web on :5173
```

Configuration is optional: every variable has a default. See [.env.example](.env.example) (API, copy to `.env`)
and [apps/web/.env.example](apps/web/.env.example) (web, copy to `apps/web/.env.local`).

## Commands

| Command          | What it does                                                                |
| ---------------- | --------------------------------------------------------------------------- |
| `pnpm dev`       | Start API (watch mode) and web (Vite) in parallel                           |
| `pnpm build`     | Build contracts, API and web (production bundles in each project's `dist/`) |
| `pnpm lint`      | ESLint on every project, including the architecture boundary rules          |
| `pnpm typecheck` | `tsc --noEmit` on every project                                             |
| `pnpm test`      | Vitest on every project                                                     |
| `pnpm verify`    | lint + typecheck + test + build                                             |
| `pnpm format`    | Prettier write (`format:check` verifies)                                    |
| `pnpm graph`     | Open the Nx project graph                                                   |

Run one project with Nx, e.g. `pnpm exec nx test @agentos/api` or `pnpm exec nx run-many -t build -p @agentos/web`.
Nx caches `build`, `lint`, `typecheck` and `test`; tasks depend on `^build`, so contracts are always built first.

## Layout

```text
apps/web            React + Vite + Ant Design               scope:web      type:app
apps/api            NestJS API                              scope:backend  type:app
packages/contracts  Zod schemas shared by web and api       scope:shared   type:lib
docs/               Architecture specification, notes, ADRs
```

Details, dependency rules and conventions: [docs/architecture/monorepo.md](docs/architecture/monorepo.md).
