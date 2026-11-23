# AgentOS

Platform for designing, running and observing AI agent systems. See the
[architecture specification](docs/architecture/technical-architecture-specification.md).

> **Status: foundation phases complete through 1.6 (System Integration & CI).** The workspace has a themed, bilingual (English/Persian, LTR/RTL) web shell with
> routing, an API client and documented conventions; an API skeleton with module, error, transaction, logging and testing conventions; shared contracts; and local
> PostgreSQL + Redis infrastructure with Prisma and readiness checks; and an independent, framework-free worker runtime (BullMQ) with a
> typed job contract, retries, graceful shutdown and Redis recovery. The whole system runs in containers (Docker Compose) with a
> supervised worker, health checks and system-level tests, and CI is split into verification, integration and system jobs.
>
> **Phase 2 (identity, organizations and projects) is in progress; steps 2.1 through 2.4 are implemented:** local email/password
> authentication with server-side sessions (cookie or bearer token), rate limiting that fails closed, an append-only audit trail,
> separate database roles for the API and for migrations, organizations with memberships, four code-owned roles, tenant isolation
> and a last-owner guarantee ([ADR-0010](docs/adr/0010-identity-organizations-projects.md)), and projects with project members, project roles
> and visibility-first listing ([ADR-0011](docs/adr/0011-projects-and-project-members.md), accepted). Step 2.4 is the web UI for
> sign-in, organizations, projects and project members, plus Playwright browser tests
> ([ADR-0012](docs/adr/0012-phase-2-4-web-ui-foundations.md), accepted). How to walk through it:
> [development.md](docs/architecture/development.md#open-the-web-app). There are no domain jobs yet.
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
pnpm db:deploy      # applies the committed Prisma migrations (identity, organizations, projects, audit)
pnpm dev            # builds shared packages, then starts the API, the worker and the web app
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
pnpm --filter @agentos/worker dev        # worker (needs `pnpm infra:up`); no port, see docs/architecture/workers.md
pnpm --filter @agentos/web dev           # web on :5173
```

### The full stack in containers

```bash
pnpm stack:up       # postgres, redis, migrate, api, worker, web: built and started in dependency order, returns when healthy
pnpm stack:ps       # status and health
pnpm stack:down     # stop and remove containers; data volumes are kept (run `pnpm infra:up` to bring the infrastructure back)
```

Web http://localhost:5173 (nginx, same-origin `/api` proxy), API http://localhost:3000. Details, restart/supervision behavior and
limits: [docker-compose.md](docs/architecture/docker-compose.md).

The API **requires** `DATABASE_URL` and `REDIS_URL` and exits at startup with a clear message if they are missing. It
does not need the databases to be _running_ to start: it reports `not_ready` on `/health/ready` until they are.

## Environment and secrets

`pnpm setup:env` copies [.env.example](.env.example) to `.env` and replaces the placeholder passwords with random ones.
`.env` is git-ignored: never commit it, and never put real credentials in `.env.example`. Variables, defaults and
details: [docs/architecture/infrastructure.md](docs/architecture/infrastructure.md). Optional web settings:
[apps/web/.env.example](apps/web/.env.example).

## Commands

| Command                                                                    | What it does                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                                 | Start API (watch mode), worker (watch mode) and web (Vite) in parallel on the host            |
| `pnpm build`                                                               | Generate the Prisma client, then build the shared packages, API, worker and web               |
| `pnpm lint`                                                                | ESLint on every project, including the architecture boundary rules                            |
| `pnpm typecheck`                                                           | `tsc --noEmit` on every project                                                               |
| `pnpm test`                                                                | Unit and in-process e2e tests (no infrastructure needed)                                      |
| `pnpm test:integration`                                                    | Tests against real PostgreSQL + Redis, incl. the worker process (needs `pnpm infra:up`)       |
| `pnpm test:system`                                                         | Docker system tests: the full stack as a black box (builds images; needs Docker; minutes)     |
| `pnpm browser:install` / `pnpm test:browser`                               | Install Chromium once; real-browser tests of the web UI against a throwaway stack (Docker)    |
| `pnpm verify`                                                              | lint + typecheck + test + build + architecture and environment checks                         |
| `pnpm check:env`                                                           | Environment consistency: schemas, `.env.example`, Compose, Dockerfile                         |
| `pnpm stack:up` / `stack:down` / `stack:ps` / `stack:logs` / `stack:build` | The full stack in containers (see above)                                                      |
| `pnpm format`                                                              | Prettier write (`format:check` verifies)                                                      |
| `pnpm graph`                                                               | Open the Nx project graph                                                                     |
| `pnpm setup:env`                                                           | Create `.env` with generated local passwords                                                  |
| `pnpm infra:up`                                                            | Start PostgreSQL + Redis (waits for health)                                                   |
| `pnpm infra:ps`                                                            | Show infrastructure status                                                                    |
| `pnpm infra:logs`                                                          | Follow infrastructure logs                                                                    |
| `pnpm infra:config`                                                        | Validate the compose file and `.env`                                                          |
| `pnpm infra:down`                                                          | Stop and remove containers. **Keeps your data** (named volumes)                               |
| `pnpm infra:destroy-data`                                                  | **Deletes all local PostgreSQL and Redis data.** Asks for confirmation. Not a routine cleanup |
| `pnpm db:validate`                                                         | Validate the Prisma schema                                                                    |
| `pnpm db:generate`                                                         | Generate the Prisma client                                                                    |
| `pnpm db:migrate`                                                          | Create/apply a development migration (`pnpm db:migrate --name <name>`)                        |
| `pnpm db:deploy`                                                           | Apply committed migrations (CI/production)                                                    |
| `pnpm db:status`                                                           | Show migration status                                                                         |

Run one project with Nx, e.g. `pnpm exec nx test @agentos/api`. Nx caches `build`, `lint`, `typecheck` and `test`; tasks
depend on `^build`, and API tasks also depend on `generate` (Prisma client).

## Layout

```text
apps/web            React + Vite + Ant Design               scope:web      type:app
apps/api            NestJS API (+ Prisma schema)            scope:backend  type:app
apps/worker         Framework-free BullMQ worker host       scope:backend  type:app
packages/contracts  Zod schemas shared by web and api       scope:shared   type:lib
packages/config     Env parsing helpers (api, worker)       scope:backend  type:lib
packages/logger     pino options + redaction (api, worker)  scope:backend  type:lib
packages/queue      BullMQ/ioredis wrappers, retry policy   scope:backend  type:lib
tests/system        Docker system tests (black box)         scope:backend  type:app
infrastructure/     Docker Compose (full stack) and the Dockerfile
tools/              Small Node scripts (setup:env, guarded data deletion)
docs/               Architecture specification, notes, ADRs
```

Details: [monorepo.md](docs/architecture/monorepo.md) (workspace and dependency rules),
[backend.md](docs/architecture/backend.md) (**backend conventions and how to add a domain module**),
[frontend.md](docs/architecture/frontend.md) (**frontend conventions and how to add a feature**),
[workers.md](docs/architecture/workers.md) (**worker runtime, job contract, delivery and shutdown semantics**),
[system-overview.md](docs/architecture/system-overview.md) (**the whole system and its boundaries**),
[development.md](docs/architecture/development.md) (**local development and the test guide**),
[docker-compose.md](docs/architecture/docker-compose.md) (**containers, supervision, health**),
[environment.md](docs/architecture/environment.md), [ci.md](docs/architecture/ci.md) and
[infrastructure.md](docs/architecture/infrastructure.md) (PostgreSQL, Redis, Prisma, health).
