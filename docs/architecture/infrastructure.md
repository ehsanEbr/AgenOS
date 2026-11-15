# Infrastructure architecture (Phase 1.2)

Scope: PostgreSQL, Redis, Prisma and readiness for local development, per specification sections 6, 12 and 17.
Queues, workers, schedulers and every domain entity are **out of scope** and arrive in their own phases.

## Overview

```text
 developer machine (127.0.0.1 only)                       Docker network "agentos-net"
┌───────────────────────────────────────┐              ┌──────────────────────────────────┐
│ apps/api (NestJS)                     │              │ postgres  pgvector/pgvector:pg17 │
│  ├─ modules/database  PrismaService ──┼── :5432 ─────┼─► volume: postgres-data          │
│  ├─ modules/redis     RedisService  ──┼── :6379 ─────┼─► redis 7.4-alpine               │
│  └─ modules/health    /health[/ready] │              │    volume: redis-data (AOF)      │
└───────────────────────────────────────┘              └──────────────────────────────────┘
```

- **PostgreSQL 17.11** (image `pgvector/pgvector:pg17`) is the source of truth for all persistent data (ADR-004).
  pgvector is available in the image for the later semantic-search phase but is not enabled yet.
- **Redis 7.4** (image `redis:7.4-alpine`) holds cache and ephemeral state only. Persistence (AOF + snapshot) exists
  so a dev restart keeps data, **not** because Redis may hold business data. Never store anything in Redis that cannot
  be rebuilt from PostgreSQL.
- Both run as Docker Compose services on the dedicated bridge network `agentos-net`. Compose project name: `agentos`.
- Prisma and ioredis are used **only** inside `apps/api`: ioredis inside `modules/redis`, Prisma inside `modules/database` and the
  `infrastructure/` layer of domain modules (enforced by ESLint, see [backend.md](backend.md)). Nothing in `packages/contracts` or
  `apps/web` knows about them.

> **Phase 1.6:** the applications (web, api, worker) and a one-shot `migrate` service were added to the same Compose file behind the
> `app` profile; `pnpm infra:up` still starts only PostgreSQL and Redis. See [docker-compose.md](docker-compose.md) and
> [system-overview.md](system-overview.md). `AGENTOS_NETWORK` (default `agentos-net`) lets throwaway test stacks use their own network.

## Environment setup

```bash
pnpm install
pnpm setup:env      # creates .env with random local passwords; never overwrites an existing .env
pnpm infra:up       # starts PostgreSQL + Redis and waits until both are healthy
pnpm db:deploy      # applies migrations (none exist yet, see "Prisma workflow")
pnpm dev
```

`.env` is git-ignored (`.env`, `.env.*`, keys); only `.env.example` is tracked and it contains placeholders, not
credentials. `pnpm setup:env` replaces the placeholders with 192-bit random hex passwords, so every developer has
different local credentials and URL-embedded passwords are always safe. Treat `.env` as a secret: do not paste it into
issues, chat or logs.

| Variable            | Used by         | Default / notes                                                             |
| ------------------- | --------------- | --------------------------------------------------------------------------- |
| `NODE_ENV`          | API             | `development`                                                               |
| `LOG_LEVEL`         | API             | `info`                                                                      |
| `API_HOST`          | API             | `127.0.0.1`                                                                 |
| `API_PORT`          | API             | `3000`                                                                      |
| `CORS_ORIGINS`      | API             | empty (no cross-origin access)                                              |
| `POSTGRES_USER`     | Compose         | `agentos`                                                                   |
| `POSTGRES_PASSWORD` | Compose         | **required, no default** (compose refuses to start without it)              |
| `POSTGRES_DB`       | Compose         | `agentos`                                                                   |
| `POSTGRES_PORT`     | Compose         | `5432` (host side, bound to 127.0.0.1)                                      |
| `DATABASE_URL`      | API, Prisma CLI | **required**; `postgresql://` or `postgres://`; must match the values above |
| `REDIS_PASSWORD`    | Compose         | **required, no default**                                                    |
| `REDIS_PORT`        | Compose         | `6379` (host side, bound to 127.0.0.1)                                      |
| `REDIS_URL`         | API             | **required**; `redis://` or `rediss://`; must match `REDIS_PASSWORD`        |

The API validates its configuration at startup (`modules/config`) and refuses to start if `DATABASE_URL` or `REDIS_URL`
is missing or has the wrong scheme. Error messages name the variable and never print its value.

If you change a password in `.env` **after** the volume was first created, PostgreSQL keeps the old password (it is only
applied when the data directory is initialized). Either change it inside PostgreSQL, or erase the volume (below).

## Docker Compose

File: `infrastructure/compose/docker-compose.yml`. All commands read the repository `.env`.

| Command                   | What it does                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm infra:config`       | Validates the compose file and your `.env` (prints nothing on success)                                          |
| `pnpm infra:up`           | Starts both services detached and waits until their health checks pass                                          |
| `pnpm infra:ps`           | Shows status and health                                                                                         |
| `pnpm infra:logs`         | Follows logs (Ctrl+C to stop following)                                                                         |
| `pnpm infra:down`         | Stops and removes the containers. **Data is kept** in the named volumes                                         |
| `pnpm infra:destroy-data` | **DESTRUCTIVE.** Also deletes the volumes, i.e. all local PostgreSQL and Redis data. Asks you to type `destroy` |

Design points:

- **Named volumes** `postgres-data` and `redis-data` (stored as `agentos_postgres-data` / `agentos_redis-data`).
  Removing containers does not remove data; only `infra:destroy-data` does.
- **Health checks**: PostgreSQL via `pg_isready`; Redis via authenticated `PING` (the password is passed through
  `REDISCLI_AUTH`, not on the command line). `up --wait` blocks until both are healthy.
- **Localhost-only ports**: `127.0.0.1:5432` and `127.0.0.1:6379`. They are not reachable from other machines or
  the LAN. Change the host side with `POSTGRES_PORT` / `REDIS_PORT` if the defaults are taken.
- **Redis requires a password** (`--requirepass`). An unauthenticated client gets `NOAUTH`.
- **Restart policy** `unless-stopped`, and a dedicated network `agentos-net` (a regular bridge network; containers can
  still publish the two host ports above, which an `internal: true` network would prevent).
- Credentials have **no defaults** in the compose file; a missing password aborts with a message pointing to
  `pnpm setup:env`.

Leftover volumes: the earlier Phase 1 build (branch `phase-1-foundation`) used volumes named
`agentos_agentos-postgres` and `agentos_agentos-redis`. They are not used by this setup. Inspect them with
`docker volume ls`, and remove them yourself with `docker volume rm <name>` once you are sure you do not need that data.

### Connecting to the development database

With the stack running, from the host:

```bash
# psql as the API's own role (what the application sees; the URL is DATABASE_URL in your .env)
psql "postgresql://agentos_api:<POSTGRES_APP_PASSWORD>@127.0.0.1:5432/agentos"

# psql as the migration role, which owns the tables (DATABASE_MIGRATE_URL), or as the superuser (DATABASE_ADMIN_URL)

# or inside the container, no password needed:
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# Redis
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli'
```

GUI clients (DBeaver, TablePlus, Prisma Studio, ...): host `127.0.0.1`, port `5432`, database from `.env`. Use the role that matches
what you want to see: `agentos_api` shows what the application can reach (it cannot read the audit table), `agentos_migrate` owns everything.
Three roles exist since Phase 2.1: see [docker-compose.md](docker-compose.md#database-roles).

## Prisma workflow

Prisma 6.19.3 (client and CLI, exact pins) lives in `apps/api`:

```text
apps/api/
├── prisma.config.ts           Prisma 6 config: schema folder, migrations path, loads the repo .env
└── prisma/
    ├── schema/                multi-file schema: every *.prisma file in this folder is part of the schema
    │   ├── base.prisma        generator + datasource ONLY (datasource: `DATABASE_MIGRATE_URL`, `schemas = [...]`)
    │   ├── identity.prisma    users, credentials, sessions        (PostgreSQL schema `identity`)
    │   └── audit.prisma       the audit trail                     (PostgreSQL schema `security`)
    └── migrations/            committed to git; applied as the migration role
```

**Phase 1.2 defined no models; domains add theirs in their own phase.** Phase 2.1 added the first two (`identity.prisma`, `audit.prisma`)
and the first migrations. Each domain gets one PostgreSQL schema (`@@schema("identity")`, declared in `base.prisma`), one `.prisma` file
per module, and one migration history for the whole repository. Facts verified on Prisma 6.19.3: multi-schema needs no preview flag;
the first migration emits `CREATE SCHEMA IF NOT EXISTS`; `_prisma_migrations` lives in `public`; a foreign key may cross schemas; one
generated client and one transaction span all schemas; a hand-written trigger or `GRANT` in a migration causes no drift; model names must
be unique across schemas. Two migrations exist: the generated tables, and a hand-written one with the `GRANT`s and the audit guard
(see [backend.md](backend.md#database-roles-and-the-audit-trail)).

**The Prisma CLI connects with the migration role**: the datasource URL is `env("DATABASE_MIGRATE_URL")`. The running API never reads
that variable: `PrismaService` passes the API role's `DATABASE_URL` to the client explicitly, so the application cannot connect with
the owner's privileges.

Commands (from the repository root):

| Command            | Underlying Prisma command | When to use                                                                                    |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm db:validate` | `prisma validate`         | Check the schema. Needs `DATABASE_MIGRATE_URL` set (it resolves `env()`)                       |
| `pnpm db:generate` | `prisma generate`         | Regenerate the client. Needs no database. Nx runs it automatically before build/typecheck/test |
| `pnpm db:migrate`  | `prisma migrate dev`      | **Development**: creates a migration from schema changes and applies it. Needs a database      |
| `pnpm db:deploy`   | `prisma migrate deploy`   | **CI / production**: applies committed migrations, never creates new ones                      |
| `pnpm db:status`   | `prisma migrate status`   | Shows applied/pending migrations                                                               |

Adding a domain later (for the phase that owns it):

1. Create `apps/api/prisma/schema/<domain>.prisma` with that domain's models (one file per domain keeps reviews focused).
2. `pnpm db:migrate --name <what_changed>` and commit the generated folder under `prisma/migrations/`.
3. Expose data through a repository inside the domain's module. Do not import `@prisma/client` outside
   `modules/database` (lint will fail). Do not put Prisma types in `packages/contracts`.
4. Never edit an applied migration. Production uses `db:deploy` only.

Notes:

- Prisma CLI does not load `.env` by itself when a `prisma.config.ts` exists; the config file loads the repository
  `.env` if present. In CI and production, variables come from the environment.
- `prisma migrate dev` needs permission to create a shadow database. In the development stack the **migration role** has `CREATEDB` for
  that; a production migration role needs no such privilege and should only run `migrate deploy`.
- The Prisma Client is generated into `node_modules` (not committed) and Nx runs `generate` before `build`,
  `typecheck`, `test` and `test:integration`; `generate` is deliberately never cached because its output lives in
  `node_modules`.

## API infrastructure modules

Transactions, database error handling, lifecycle ownership and how a future worker reuses this: see [backend.md](backend.md) sections 4 and 7.

```text
apps/api/src/modules/
├── config/     validated environment (DATABASE_URL, REDIS_URL, ...)
├── database/   PrismaService + DatabaseModule         (the only place that imports @prisma/client)
├── redis/      RedisService + RedisModule             (the only place that imports ioredis)
└── health/     HealthController, HealthService         (depends on database and redis through their index.ts)
```

**Lifecycle (both services)**

- _Startup_: the service tries to connect (PostgreSQL: 5 s limit, Redis: 3 s limit). If the dependency is unreachable the
  API **still starts**, logs one warning (error class only, never connection strings) and reports `not_ready`. Both
  drivers reconnect lazily/in the background, so the API recovers on its own when the dependency returns (verified by
  stopping and restarting each container while the API ran).
- _Shutdown_: `main.ts` calls `app.close()` on SIGTERM/SIGINT, which runs `onModuleDestroy`, and then exits 0. Prisma calls `$disconnect()`
  (a failure is logged and ignored so shutdown always completes); Redis calls `QUIT` when connected and a hard
  `disconnect()` otherwise, so shutdown never hangs on a dead connection.
- Redis connection errors are logged once per outage, not once per retry.
- Redis commands fail fast (`maxRetriesPerRequest: 1`) instead of queueing forever.

## Health and readiness

| Endpoint                   | Question answered                     | Depends on PostgreSQL/Redis | Success | Failure |
| -------------------------- | ------------------------------------- | --------------------------- | ------- | ------- |
| `GET /api/v1/health`       | **Liveness**: is the process running? | No                          | `200`   | n/a     |
| `GET /api/v1/health/ready` | **Readiness**: can it serve requests? | Yes, both are required      | `200`   | `503`   |

`/api/v1/health` is unchanged from Phase 1.1. Liveness must not depend on infrastructure: restarting a healthy process
does not fix a database outage, it only makes one worse. Use it for "restart me if this fails" probes; use `/ready` for
"send me traffic" probes.

Readiness response (identical shape for 200 and 503, validated by `readinessResponseSchema` in `@agentos/contracts`):

```json
{
  "status": "not_ready",
  "checks": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "down", "reason": "unavailable" }
  }
}
```

- Each dependency is probed in parallel with a 2 s timeout (`READINESS_TIMEOUT_MS`), so the endpoint answers within
  about 2 s even if a dependency hangs. `reason` is `timeout` or `unavailable`.
- The response never contains hostnames, ports, credentials, connection strings or driver error text. `reason` is a
  fixed vocabulary enforced by the contract schema; details go to the server log as an error class only.
- The 503 body is a readiness body, not the generic `ApiError` (probes need the per-dependency detail). Every other
  failure still uses the `ApiError` contract, and correlation IDs are present on all responses including 503s.
- Request logging ignores `/health*` paths to keep probe traffic out of the logs.

## Tests

| Layer          | Command                 | Needs infrastructure | What it covers                                                                                                                                            |
| -------------- | ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit           | `pnpm test`             | No                   | Config validation; Prisma/Redis service lifecycle (driver mocked); readiness logic incl. timeout and secret-leak checks                                   |
| In-process e2e | `pnpm test` (same run)  | No                   | Full HTTP pipeline with stub infrastructure: liveness independence, 200/503 readiness, error contract, correlation id, OpenAPI                            |
| Integration    | `pnpm test:integration` | **Yes** (`infra:up`) | Real PostgreSQL `SELECT 1`, authenticated Redis round trip, readiness 200, readiness 503 with each dependency unreachable, connections closed on shutdown |

Unit tests use placeholder URLs pointing at a closed local port, so a missing or broken database can never make them
pass or fail. Integration tests read the same `.env` as the app but are safe to run against your development stack:
they run only `SELECT 1`, and Redis keys live under an `it:` prefix inside logical database 15 and are deleted
afterwards. CI generates throwaway passwords, starts the real compose file, and runs the integration suite against it.

## Decisions that affect later phases

See [ADR-0003](../adr/0003-phase-1-2-infrastructure-decisions.md). In short: Prisma lives in `apps/api` with a
multi-file schema; infrastructure modules are explicit (non-global) imports; the API starts without its dependencies and
reports readiness; BullMQ reuses the same Redis (workers and producers use their own connections from `@agentos/queue`, never `RedisService`'s client, because workers need blocking commands; see [workers.md](workers.md) and [ADR-0006](../adr/0006-worker-runtime.md)). Queue keys live under the `QUEUE_PREFIX` namespace (default `agentos`); Redis must keep `maxmemory-policy noeviction` (the default).

## Known limitations

- **Single-node development setup only.** No replication, backups, TLS, or secret manager. `rediss://` URLs are accepted
  by configuration validation, but TLS is not configured in compose.
- **Passwords are generated once.** Rotating them requires changing them inside PostgreSQL/Redis, not just in `.env`.
- **No migrations or tables yet**, by design; the migration workflow is documented and exercised against the empty schema
  only. The first real migration (next domain phase) will be the first full test of `migrate dev` / `migrate deploy`.
- **`prisma migrate dev` is not usable non-interactively when it needs to prompt** (for example, destructive changes); that
  is Prisma's behavior.
- **Prisma 6 is used, not Prisma 7+.** Prisma 7 changes the client generator and requires driver adapters; upgrading is a
  separate, planned task (see ADR-0003).
- **Liveness uses `process.uptime()` only**; it does not detect an event loop that is alive but stuck.
- **Real SIGTERM handling was not exercised on Windows** (Node cannot deliver it); shutdown hooks are covered by tests
  that call `app.close()` and by unit tests of the lifecycle methods.
- **The CI workflow for this phase has not been run on GitHub.**
