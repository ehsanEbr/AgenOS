# Docker Compose, supervision and health

Scope: the full local stack in containers (`pnpm stack:*`), how it starts and stops, how the worker is supervised and observed,
and what is and is not guaranteed. Decisions: [ADR-0009](../adr/0009-integration-and-ci.md). System overview:
[system-overview.md](system-overview.md). Environment variables: [environment.md](environment.md).

## Two ways to run the system

| Mode                 | Command                         | What runs where                                                                                | Use it for                                                  |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Host development** | `pnpm infra:up` then `pnpm dev` | PostgreSQL + Redis in Docker; web (Vite), api (Nest watch), worker (tsx watch) on your machine | Writing code: hot reload, debuggers                         |
| **Full stack**       | `pnpm stack:up`                 | Everything in containers: postgres, redis, migrate, api, worker, web                           | Verifying the system as deployed, supervision, system tests |

The application services live behind the Compose **profile `app`**, so `pnpm infra:up` still starts only PostgreSQL and Redis,
exactly as before. Both modes use the same `infrastructure/compose/docker-compose.yml` and the same repository `.env`.

## Commands

| Command             | What it does                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm stack:build`  | Builds the three images (`agentos-api`, `agentos-worker`, `agentos-web`)                                               |
| `pnpm stack:up`     | Builds if needed, starts every service in dependency order and **waits until all are healthy**                         |
| `pnpm stack:ps`     | Status and health of every container, including exited one-shots                                                       |
| `pnpm stack:logs`   | Follows the logs of all services (JSON lines from the applications)                                                    |
| `pnpm stack:down`   | Stops and removes **all** containers of the project, infrastructure included (like `infra:down`). **Volumes are kept** |
| `pnpm stack:config` | Validates the Compose file with the `app` profile (CI runs it)                                                         |

`pnpm stack:down` followed by `pnpm infra:up` leaves you where you were before `stack:up`. Neither command ever removes a
volume. The only data-deleting command is `pnpm infra:destroy-data`, which asks for confirmation and is never run automatically.

After `pnpm stack:up`: web http://localhost:5173, API http://localhost:3000/api/v1/health, Swagger http://localhost:3000/api/docs.
(On Windows use `localhost`, not `127.0.0.1`, for the Vite dev server: Vite listens on `localhost`, which may resolve to IPv6.)

## Topology

```text
web (nginx :8080)  --/api-->  api (:3000)  -->  postgres (:5432)    source of truth
                                  |
                                  +-->  redis (:6379)  <--  worker   BullMQ transport (never a source of truth)
migrate (one-shot) --> postgres
```

| Service    | Image / target           | Depends on (condition)                  | Restart          | Health check                                              |
| ---------- | ------------------------ | --------------------------------------- | ---------------- | --------------------------------------------------------- |
| `postgres` | `pgvector/pgvector:pg17` | -                                       | `unless-stopped` | `pg_isready`                                              |
| `redis`    | `redis:7.4-alpine`       | -                                       | `unless-stopped` | authenticated `PING`                                      |
| `migrate`  | `agentos-api` (one-shot) | postgres (healthy)                      | `no`             | exits 0 when migrations are applied                       |
| `api`      | `agentos-api`            | migrate (completed OK), redis (healthy) | `on-failure:5`   | `GET /api/v1/health/ready` (readiness, not just liveness) |
| `worker`   | `agentos-worker`         | redis (healthy)                         | `on-failure:5`   | heartbeat file via `healthcheck.js` (see below)           |
| `web`      | `agentos-web` (nginx)    | api (healthy)                           | `on-failure:5`   | `GET /` on the container's own port                       |

- **Startup respects readiness.** Compose waits for health (`depends_on: condition`), `migrate` must succeed before the API
  starts (a failed migration stops the stack and stays visible: it never restarts), and `pnpm stack:up` returns only when all
  long-running services are healthy. The API additionally starts fine _without_ its dependencies (it reports `not_ready` and
  recovers by itself; verified by the system tests), so ordering is a convenience, not a requirement for correctness.
- **Least privilege.** Only `api` and `migrate` receive PostgreSQL credentials. The worker gets `REDIS_URL` only: it has no database
  access by design (ADR-0006), and `tools/check-env.mjs` fails the build if Compose ever gives it `DATABASE_URL`.
- **Environment.** Containers get their configuration from Compose `environment:` (interpolated from `.env`), never from a file
  inside an image. Inside the network services are addressed by name (`postgres`, `redis`, `api`), so `DATABASE_URL`/`REDIS_URL`
  are rebuilt there from the same `POSTGRES_*`/`REDIS_PASSWORD` values. `NODE_ENV=production` in containers means JSON logs.
- **Ports.** Everything published is bound to `127.0.0.1` only. The worker publishes nothing. Within the Docker network services
  talk to each other freely; that network is not exposed.

## Database roles

The superuser is not what the application runs as (ADR-0010, decision 6). Three roles exist:

| Role              | Provisioned by       | Connects from                      | Privileges                                                          |
| ----------------- | -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| superuser         | the `postgres` image | `db-roles`, test tooling           | everything                                                          |
| `agentos_migrate` | `db-roles`           | the `migrate` service, `pnpm db:*` | owner of the schemas and tables; not a superuser                    |
| `agentos_api`     | `db-roles`           | the `api` service, `pnpm dev`      | member of `agentos_app`: only what migrations granted; owns nothing |

**`db-roles`** runs `infrastructure/postgres/roles.sql` as the superuser on every start. It is idempotent, works on a new volume and
on an existing one, re-applies the passwords from `.env`, and touches no data. It provisions, then stays idle and reports healthy
(`docker compose up --wait` treats an exited container as a failure, and `depends_on: service_healthy` orders it). It starts with
`pnpm infra:up` (host development) as well as `pnpm stack:up`; `migrate` waits for it, and the API waits for `migrate`.

**Each migration grants on its own tables** to the group role `agentos_app` (a `NOLOGIN` role that a migration also creates if it
does not exist). There is no runtime GRANT and no role-handling code in the application. The audit table is `INSERT`-only; see
[backend.md](backend.md#database-roles-and-the-audit-trail).

**Upgrading an existing checkout:** `pnpm setup:env` (adds the new variables to your `.env`, keeps your values), then `pnpm infra:up`
(provisions the roles on your existing volume), then `pnpm db:deploy`. No volume is recreated and no data is deleted.

**The superuser is still used for two things:** the PostgreSQL healthcheck and test tooling (`DATABASE_ADMIN_URL`, which creates
throwaway databases). Neither is application code. A production deployment provisions the same roles with its own tooling and must
never connect the application as a superuser or as the schema owner: that is the boundary the audit protection relies on.

## Shutdown

`docker compose stop` sends SIGTERM and waits `stop_grace_period`, then SIGKILL. Every service handles SIGTERM and **exits 0**:

- `api`: stops accepting connections, closes PostgreSQL and Redis, exits 0. (NestJS's `enableShutdownHooks()` re-raises the
  signal after cleanup, which ends the process as "killed by SIGTERM", exit code 143. `main.ts` therefore calls `app.close()` itself
  and exits 0; see ADR-0009.)
- `worker`: stops taking jobs, waits for active ones up to `WORKER_SHUTDOWN_GRACE_MS` (default 30 s), then exits 0, or exits 1
  after abandoning unfinished jobs (they are redelivered; nothing is acknowledged falsely). **`stop_grace_period` (40 s) must exceed
  `WORKER_SHUTDOWN_GRACE_MS`**, otherwise Docker kills the worker mid-drain. `tools/check-env.mjs` enforces this relation.
- `web` (nginx, SIGQUIT), `postgres` (fast shutdown) and `redis` (saves then exits) stop cleanly.

`init: true` runs a real PID 1 (tini) in the application containers so signals are forwarded and zombies reaped.
Verified: a full `stop` of all six services finishes in seconds, every exit code is 0, and none is `137`.

## Supervision: what restarts the worker, and what does not

The Phase 1.5 timeout design ends a worker whose handler will not stop (exit code 1) and relies on something to start it again.
That something is the container **restart policy `on-failure:5`**. Read this section before relying on it.

| Situation                                           | Exit code | What happens                                                                                                                                                                                                            |
| --------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process crashes or is killed (OOM, SIGKILL, bug)    | 1 / 137   | Docker restarts it. Verified: restart count +1, the interrupted job is redelivered and finished                                                                                                                         |
| A handler ignores its abort signal (stuck handler)  | 1         | Worker shuts down and exits; Docker restarts it; BullMQ fails the poison job after it stalled twice, so restarts are **bounded** (verified end to end: 2 restarts, job `failed`, worker healthy again)                  |
| Clean shutdown by SIGTERM delivered to the process  | 0         | **Not restarted** (`on-failure` ignores exit 0). Verified                                                                                                                                                               |
| `docker stop`, `docker kill`, `docker compose stop` | 137 / 0   | **Never restarted**: Docker treats any command through its API as a _manual stop_ and suspends the policy until the container is started again. This is why "kill it to test restart" with `docker kill` proves nothing |
| Invalid configuration                               | 2         | Restarted up to **5 times** (each logs the variable names, never values), then the container stays `Exited (2)`. Visible in `docker compose ps -a`; not hidden by an endless loop. Verified                             |
| Redis unreachable at startup                        | 1         | `worker failed to start` after `WORKER_STARTUP_TIMEOUT_MS`; restarted up to 5 times like any failure                                                                                                                    |
| Redis lost while running                            | -         | **No restart, by design.** The worker stays up, reports not ready, reconnects by itself and resumes. Verified: same process, one Redis connection, no duplicate worker                                                  |
| Hung event loop (blocking synchronous code)         | -         | **Not detected by Docker.** The heartbeat stops, so the health check turns `unhealthy`, but Docker does not restart unhealthy containers                                                                                |

Limits of this design, stated plainly:

- **Docker restart policies are not health checks.** `on-failure` reacts to a process _exit_. It does not notice a worker that
  is alive but useless (hung, or cut off from Redis). The health status below makes that visible; acting on it needs an external
  mechanism (an orchestrator that restarts unhealthy containers, an alerting rule). None is added in this phase.
- **`on-failure:5` is a count, not a rate.** Docker resets the count once a container has run for 10 seconds, so a worker that
  crashes every 30 s restarts indefinitely. The poison-job case is bounded by BullMQ (above), a systematic crash loop is not;
  it will be visible as a rising `RestartCount` and in the logs.
- **Docker cannot exclude one exit code** (2 = invalid configuration). Bounded retries with persistent logs are the available
  compromise; a supervisor that does not retry on 2 would need a wrapper process, which is not justified here.
- **Host development has no supervisor.** `pnpm dev` runs the worker under `tsx watch`. If the worker exits, `tsx watch` leaves it
  stopped until you save a file, without any message (observed). That is deliberate for development: a crash should be seen, not
  looped. Exercise supervision with `pnpm stack:up` or `pnpm test:system`.

## Worker health and readiness

The worker has no HTTP server and none was added for symmetry with the API. Instead:

1. While `WORKER_HEALTH_FILE` is set (Compose sets it), the process rewrites **one small JSON file** (`/tmp/worker-health.json`)
   every 5 seconds with `{pid, state, ready, redis, activeJobs, updatedAt, intervalMs}`, atomically (temp file + rename), and
   immediately at every state change that matters. The heartbeat timer is `unref`'d: it never keeps the process alive.
2. Compose runs `node /app/apps/worker/dist/healthcheck.js` every 5 s. It reads the file, prints one reason line (visible in
   `docker inspect`) and exits 0 only if **all** of these hold:
   - the process that wrote the file **is still running** (a crashed worker leaves a file saying "ready"; the dead pid exposes it);
   - the heartbeat is **fresh**: younger than 3 intervals (a hung event loop stops writing);
   - the worker says it is **ready**: lifecycle state `running` **and** Redis connection `ready`.
3. **Shutdown is immediate.** When shutdown begins the entry point rewrites the file with `state: draining, ready: false` _before_
   waiting for jobs, and removes it at exit, so a draining worker is never reported ready.

The readiness definition is the one the runtime already had (`WorkerHost.isReady`). The probe never connects to Redis itself, so
it adds no load and cannot mask an outage. Verified in unit tests (every rule), in process tests (kill -9 leaves a "ready" file
that is **not** trusted; SIGTERM flips it to draining while a job is still running) and in system tests (Redis stopped: the probe
turns unhealthy within seconds and healthy again after Redis returns).

**Limitation.** The probe is only meaningful where it runs: inside the container. It is not a network endpoint, and a hung event
loop is detected only through the missing heartbeat (so detection takes up to 15 s plus the health-check retries).

## Images

`infrastructure/docker/Dockerfile` builds once and has three targets: `api`, `worker`, `web` (nginx serving the static build and
proxying `/api` to the API container, resolving the API by name per request so the API can restart without breaking the proxy).

- Base `node:22.14.0-bookworm-slim` (+ `openssl`, which Prisma needs), pnpm pinned to the repository's `packageManager` version.
  Runs as the unprivileged `node` user. The web image runs as an unprivileged nginx. No secret is copied or passed as a build
  argument (`.dockerignore` excludes `.env*`).
- The apps are built with `pnpm install --frozen-lockfile` and the normal Nx build, so containers run exactly what CI builds.
- **Tags and provenance.** Developer images are `agentos-api|worker|web:local` (the default of `AGENTOS_IMAGE_TAG`). The system
  tests use `:systest` and never touch the `:local` images. Every image carries the label
  `org.opencontainers.image.revision` with the commit it was built from (`GIT_REVISION`; `unknown` for an ordinary
  `pnpm stack:up`). The system-test harness rejects any image whose label is not the current commit (`<sha>-dirty` if the tree has
  uncommitted changes), so a stale image or a developer build cannot be reused by accident, and its first test checks that every
  running container was created from the verified image ID.

**Limitations (intentional for this phase):** these are development/verification images, not production images. The `api` and
`worker` targets contain the whole built workspace including dev dependencies (about 1.4 GB each, sharing layers). There is no image
scanning, no registry publish and no production hardening; that belongs to a later deployment phase. The images rebuild on
`pnpm stack:up` when sources change, with Docker layer caching for dependencies.

## Development-only security compromises

- Database and Redis ports are published (to `127.0.0.1` only) so host tools and `pnpm dev` can reach them. A production
  deployment would not publish them.
- Passwords are random but live in a plain `.env` file on your machine (git-ignored). Containers receive them as environment
  variables (visible in `docker inspect` to anyone who can run Docker on the machine).
- Redis and PostgreSQL run without TLS inside the Docker network.
- The PostgreSQL **superuser** password sits in the same `.env` as the others and in the `postgres` and `db-roles` containers. The API and the migration process do not receive it (`check-env` enforces this).
- With `AUTH_ALLOW_REGISTRATION=true` anyone who can reach the API can register (see environment.md).
- The images contain dev dependencies and build tooling.
- `CORS_ORIGINS` defaults to the Vite dev origin; the container stack uses same-origin proxying and needs no CORS.
