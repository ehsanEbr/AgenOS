# AgentOS

Platform for designing, running and observing AI agent systems. See the
[architecture specification](docs/architecture/technical-architecture-specification.md).

> **Status: Phase 1.3 (Backend Foundation).** The workspace has a web shell, an API skeleton with documented module,
> error, transaction, logging and testing conventions, shared contracts, and local PostgreSQL + Redis infrastructure with Prisma and readiness checks. There are no database tables, queues,
> workers, authentication or product functionality yet.
>
> An earlier, larger Phase 1 build (including a BullMQ worker) is preserved on the git branch `phase-1-foundation`.

## Prerequisites

- Node.js >= 22.12
- pnpm 11 (`corepack enable` selects the version pinned in `package.json`)
- Docker with Compose v2 (for PostgreSQL and Redis)

## Getting started

```bash
pnpm install
pnpm setup:env      # creates .env with random local passwords (never overwrites an existing .env)
pnpm infra:up       # starts PostgreSQL + Redis and waits until both are healthy
pnpm db:deploy      # applies Prisma migrations (none exist yet; safe to run)
pnpm dev            # builds contracts, then starts the API and the web app
```

| What         | URL                                       |
| ------------ | ----------------------------------------- |
| Web app      | http://localhost:5173                     |
| Liveness     | http://localhost:3000/api/v1/health       |
| Readiness    | http://localhost:3000/api/v1/health/ready |
| Swagger UI   | http://localhost:3000/api/docs            |
| OpenAPI JSON | http://localhost:3000/api/openapi.json    |

The web app proxies `/api` to the API in development. If port 5173 is busy, Vite prints the port it picked.

Start the applications individually:

```bash
pnpm --filter @agentos/contracts build   # once, and after changing contracts
pnpm --filter @agentos/api dev           # API on :3000 (needs `pnpm infra:up` first)
pnpm --filter @agentos/web dev           # web on :5173
```

The API **requires** `DATABASE_URL` and `REDIS_URL` and exits at startup with a clear message if they are missing. It
does not need the databases to be _running_ to start: it reports `not_ready` on `/health/ready` until they are.

## Environment and secrets

`pnpm setup:env` copies [.env.example](.env.example) to `.env` and replaces the placeholder passwords with random ones.
`.env` is git-ignored: never commit it, and never put real credentials in `.env.example`. Variables, defaults and
details: [docs/architecture/infrastructure.md](docs/architecture/infrastructure.md). Optional web settings:
[apps/web/.env.example](apps/web/.env.example).

## Commands

| Command                   | What it does                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm dev`                | Start API (watch mode) and web (Vite) in parallel                                             |
| `pnpm build`              | Generate the Prisma client, then build contracts, API and web                                 |
| `pnpm lint`               | ESLint on every project, including the architecture boundary rules                            |
| `pnpm typecheck`          | `tsc --noEmit` on every project                                                               |
| `pnpm test`               | Unit and in-process e2e tests (no infrastructure needed)                                      |
| `pnpm test:integration`   | Tests against real PostgreSQL + Redis (needs `pnpm infra:up`)                                 |
| `pnpm verify`             | lint + typecheck + test + build                                                               |
| `pnpm format`             | Prettier write (`format:check` verifies)                                                      |
| `pnpm graph`              | Open the Nx project graph                                                                     |
| `pnpm setup:env`          | Create `.env` with generated local passwords                                                  |
| `pnpm infra:up`           | Start PostgreSQL + Redis (waits for health)                                                   |
| `pnpm infra:ps`           | Show infrastructure status                                                                    |
| `pnpm infra:logs`         | Follow infrastructure logs                                                                    |
| `pnpm infra:config`       | Validate the compose file and `.env`                                                          |
| `pnpm infra:down`         | Stop and remove containers. **Keeps your data** (named volumes)                               |
| `pnpm infra:destroy-data` | **Deletes all local PostgreSQL and Redis data.** Asks for confirmation. Not a routine cleanup |
| `pnpm db:validate`        | Validate the Prisma schema                                                                    |
| `pnpm db:generate`        | Generate the Prisma client                                                                    |
| `pnpm db:migrate`         | Create/apply a development migration (`pnpm db:migrate --name <name>`)                        |
| `pnpm db:deploy`          | Apply committed migrations (CI/production)                                                    |
| `pnpm db:status`          | Show migration status                                                                         |

Run one project with Nx, e.g. `pnpm exec nx test @agentos/api`. Nx caches `build`, `lint`, `typecheck` and `test`; tasks
depend on `^build`, and API tasks also depend on `generate` (Prisma client).

## Layout

```text
apps/web            React + Vite + Ant Design               scope:web      type:app
apps/api            NestJS API (+ Prisma schema)            scope:backend  type:app
packages/contracts  Zod schemas shared by web and api       scope:shared   type:lib
infrastructure/     Docker Compose (PostgreSQL, Redis)
tools/              Small Node scripts (setup:env, guarded data deletion)
docs/               Architecture specification, notes, ADRs
```

Details: [monorepo.md](docs/architecture/monorepo.md) (workspace and dependency rules),
[backend.md](docs/architecture/backend.md) (**backend conventions and how to add a domain module**) and
[infrastructure.md](docs/architecture/infrastructure.md) (PostgreSQL, Redis, Prisma, health).
