# Environment configuration

One place that explains every environment variable of the system: who reads it, what it defaults to, and how development, test
and container configuration differ. The values and comments in [`.env.example`](../../.env.example) are the template;
`pnpm setup:env` turns it into your git-ignored `.env` with random local passwords.

## Rules

1. **Applications read the environment only through their validated config**: `apps/api/src/modules/config`,
   `apps/worker/src/config.ts`, `apps/web/src/shared/config/env.ts`. A missing or invalid value stops the process at startup
   with a message that **names the variable and never prints its value**.
2. **Secrets are never committed.** `.env` is git-ignored; `.env.example` holds `change-me-*` placeholders only; images contain no
   `.env`; logs never contain credentials (connection URLs are redacted to `scheme://host:port`).
3. **No silent drift.** `pnpm check:architecture` runs `tools/check-env.mjs`, which fails when: an app reads a variable that
   `.env.example` does not document; Compose references an undocumented variable or defaults to a value that contradicts
   `.env.example`; a container receives a variable its app does not read (a typo would be silently ignored) or lacks a required
   one; the worker is given database credentials; `DATABASE_URL`/`REDIS_URL` disagree with `POSTGRES_*`/`REDIS_*`; a real-looking
   password sits in `.env.example`; the worker's Docker stop timeout does not exceed its shutdown grace period; the Dockerfile's
   pnpm/Node versions differ from the repository's.

## Variables

| Variable                                                                           | Read by                               | Default                                     | Notes                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                         | api, worker                           | `development`                               | Containers set `production` (JSON logs). Only log formatting differs                                       |
| `LOG_LEVEL`                                                                        | api, worker                           | `info`                                      |                                                                                                            |
| `API_HOST`, `API_PORT`, `CORS_ORIGINS`                                             | api, Compose (`API_PORT` = host port) | `127.0.0.1`, `3000`, Vite origin            | In containers `API_HOST=0.0.0.0` and the port is fixed at 3000; `API_PORT` is only the published host port |
| `POSTGRES_USER/PASSWORD/DB/PORT`                                                   | Compose (postgres, migrate, api URL)  | `agentos`, **required**, `agentos`, `5432`  | Password has no default                                                                                    |
| `DATABASE_URL`                                                                     | api, Prisma CLI                       | **required**                                | Host form (`127.0.0.1`); Compose rebuilds the in-network form (`@postgres:5432`)                           |
| `REDIS_PASSWORD`, `REDIS_PORT`                                                     | Compose (redis)                       | **required**, `6379`                        |                                                                                                            |
| `REDIS_URL`                                                                        | api, worker                           | **required**                                | Same host-form/in-network-form relation as above                                                           |
| `WEB_PORT`                                                                         | Compose (web)                         | `5173`                                      | Published port of the web container                                                                        |
| `QUEUE_PREFIX`                                                                     | worker (+ producers)                  | `agentos`                                   | Producers and workers must agree                                                                           |
| `WORKER_NAME`, `WORKER_QUEUES`, `WORKER_CONCURRENCY`                               | worker                                | `worker`, `system`, `5`                     |                                                                                                            |
| `WORKER_JOB_TIMEOUT_MS`, `WORKER_ABORT_GRACE_MS`                                   | worker                                | `60000`, `10000`                            | See workers.md ("Timeouts and handler execution safety")                                                   |
| `WORKER_SHUTDOWN_GRACE_MS`, `WORKER_STARTUP_TIMEOUT_MS`, `WORKER_LOCK_DURATION_MS` | worker                                | `30000` each                                |                                                                                                            |
| `WORKER_HEALTH_FILE`                                                               | worker, Compose sets it               | unset (disabled)                            | Heartbeat file read by the container health check                                                          |
| `VITE_API_BASE_URL`, `VITE_API_TIMEOUT_MS`, `VITE_DEV_API_TARGET`                  | web (`apps/web/.env.example`)         | `/api/v1`, `15000`, `http://127.0.0.1:3000` | Build/dev-time only; not secrets                                                                           |

`API_PORT` and `WEB_PORT` mean "where you reach it on the host" in both modes, so changing them works the same with `pnpm dev`
and `pnpm stack:up`.

## Development, test and container configuration are separate

| Context           | Configuration source                                                                                                | Data it touches                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`        | `.env` (loaded by the app scripts)                                                                                  | Your dev PostgreSQL/Redis                                                                                                                                                                    |
| `pnpm stack:up`   | `.env` via Compose interpolation                                                                                    | Your dev volumes (kept across `down`)                                                                                                                                                        |
| Unit tests        | Set in each vitest config; no infrastructure                                                                        | None                                                                                                                                                                                         |
| Integration tests | `.env` / CI environment; `NODE_ENV=test`, `LOG_LEVEL=silent`                                                        | Redis **logical database 15** with a unique key prefix per test, deleted afterwards; PostgreSQL tests create and drop a **throwaway database** (`createIsolatedDatabase`), never the dev one |
| System tests      | **Generated per run**: random passwords and ports in a temp env file; unique Compose project `agentos-systest-<id>` | Their own volumes and network, deleted when the file ends. The harness refuses to delete volumes of any project that does not carry that prefix                                              |
| CI                | `pnpm setup:env` generates throwaway credentials, **masked in the job log**                                         | A fresh PostgreSQL/Redis created for the run                                                                                                                                                 |

## Changing configuration safely

- Add a variable: add it to the app's schema, to `.env.example` (documented), and to Compose if containers need it; `check-env`
  tells you what you forgot. Give it a default only if a wrong default is harmless.
- Rotating a database password after the volume exists requires changing it inside PostgreSQL as well (see
  [infrastructure.md](infrastructure.md)); the `.env` value alone only applies to a new data directory.
