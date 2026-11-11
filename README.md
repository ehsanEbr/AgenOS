# AgentOS

Platform for designing, running and observing AI agent systems. Modular monolith (NestJS) with independent
BullMQ workers, a React frontend, PostgreSQL and Redis.

> **Status: Phase 1 (Project Foundation).** No LLM, agent or MCP functionality exists yet. This repository
> contains the production-minded skeleton the later phases build on. See [docs/architecture](docs/architecture).

## Prerequisites

- Node.js >= 22.12
- pnpm 11 (`corepack enable` picks the version from `package.json`)
- Docker (for PostgreSQL and Redis)

## Quick start

```bash
pnpm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
pnpm infra:up               # PostgreSQL (pgvector) + Redis, waits until healthy
pnpm db:migrate             # apply Prisma migrations + generate client
pnpm build                  # builds shared packages (needed once before `dev`)
pnpm dev                    # API :3000, worker, web :5173
```

| URL                                       | What                                |
| ----------------------------------------- | ----------------------------------- |
| http://localhost:5173                     | Web app (proxies `/api` to the API) |
| http://localhost:3000/api/docs            | Swagger UI                          |
| http://localhost:3000/api/openapi.json    | OpenAPI document                    |
| http://localhost:3000/api/v1/health/live  | Liveness probe                      |
| http://localhost:3000/api/v1/health/ready | Readiness (PostgreSQL, Redis)       |

The Overview page has a **Background job test** that sends a job API -> BullMQ -> worker -> PostgreSQL and shows
the result. Equivalent with curl:

```bash
curl -X POST localhost:3000/api/v1/system/jobs -H 'content-type: application/json' -d '{"message":"hello"}'
curl localhost:3000/api/v1/system/jobs/<id>
```

## Commands

| Command                                        | Purpose                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm verify`                                  | lint + typecheck + unit tests + build (run before finishing any task) |
| `pnpm lint` / `typecheck` / `test` / `build`   | Individual steps, run through Nx (cached)                             |
| `pnpm test:integration`                        | Integration tests; needs `pnpm infra:up` + `pnpm db:deploy`           |
| `pnpm format`                                  | Prettier                                                              |
| `pnpm infra:up` / `infra:down` / `infra:reset` | Manage Docker services (`reset` deletes data volumes)                 |
| `pnpm db:migrate`                              | Create/apply a dev migration (`-- --name <name>`)                     |
| `pnpm db:deploy`                               | Apply existing migrations (CI/production)                             |

## Layout

```text
apps/api            NestJS API (modular monolith)          scope:backend  type:app
apps/agent-worker   BullMQ worker process                  scope:backend  type:app
apps/web            React + Vite + Ant Design              scope:web      type:app
packages/contracts  Zod schemas shared by web and backend  scope:shared   type:lib
packages/config     Validated environment config           scope:backend  type:lib
packages/logger     pino logger with redaction             scope:backend  type:lib
database/           Prisma schema, migrations, client      scope:backend  type:lib
infrastructure/     Docker Compose for local services
docs/               Architecture notes and ADRs
```

Dependency direction is enforced by ESLint (`@nx/enforce-module-boundaries`): the web app may only import
`scope:shared` packages, never backend code.

## Configuration

All configuration is environment-based and validated at startup (`packages/config`); see
[.env.example](.env.example). Invalid configuration fails fast with a message naming the variable, never its value.
