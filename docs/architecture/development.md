# Local development and testing guide

Everything a developer needs to run, change and verify AgentOS locally. Architecture background:
[system-overview.md](system-overview.md). Compose details: [docker-compose.md](docker-compose.md). Variables:
[environment.md](environment.md).

## Prerequisites

Node.js >= 22.12, pnpm 11 (`corepack enable` picks the pinned version), Docker with Compose v2 (Docker Desktop on Windows/macOS).

## First run

```bash
pnpm install
pnpm setup:env      # creates .env with random local passwords; never overwrites an existing .env
pnpm infra:up       # PostgreSQL + Redis, waits until healthy
pnpm db:deploy      # applies Prisma migrations (none exist yet; safe to run)
pnpm dev            # builds the shared packages, then runs api, worker and web in watch mode
```

`pnpm dev` starts three processes: the API (`nest start --watch`, http://localhost:3000), the **worker** (`tsx watch`, no port; look
for `worker ready` in the output) and the web app (Vite, http://localhost:5173, proxying `/api` to the API).

Run one application: `pnpm --filter @agentos/api dev`, `pnpm --filter @agentos/worker dev`, `pnpm --filter @agentos/web dev`
(build the shared packages once with `pnpm --filter @agentos/contracts build`, or let Nx do it via `pnpm dev`).

### The full stack in containers

```bash
pnpm stack:up       # builds images, starts postgres, redis, migrate, api, worker, web; returns when all are healthy
pnpm stack:ps       # status and health
pnpm stack:logs     # follow logs
pnpm stack:down     # stop and remove containers; volumes (your data) are kept. Run `pnpm infra:up` to get the infrastructure back
```

Use it to see the system as it is deployed, to try restart behavior, and before pushing changes that touch Docker, Compose or
process lifecycle. Do not run `pnpm dev` and `pnpm stack:up` at the same time (both use ports 3000 and 5173; change `API_PORT`
and `WEB_PORT` in `.env` if you want both).

### Try the whole path (producer -> Redis -> worker)

With `pnpm dev` or `pnpm stack:up` running, enqueue the diagnostic job from a script (the API does not enqueue anything yet):

```ts
import { systemPingJob } from '@agentos/contracts';
import { QueueProducer, createRedisConnection } from '@agentos/queue';

const connection = createRedisConnection(process.env.REDIS_URL!, { role: 'producer', name: 'my-script' });
const producer = new QueueProducer({ connection });
await producer.enqueue(systemPingJob, { message: 'hello', delayMs: 5_000 }); // delayMs gives you a job to interrupt
await producer.close();
connection.disconnect();
```

The worker logs `job completed` with the job id, type and correlation id.

## Platform notes

- **Windows:** use `localhost` (not `127.0.0.1`) for the Vite dev server; it may listen on IPv6 only. Node on Windows cannot deliver
  SIGTERM/SIGINT to a child process, so the tests that need real signals are skipped there and run in CI/Linux; to try graceful
  shutdown by hand use Ctrl+C or a container. In Git Bash, `docker run -w /path` is rewritten to a Windows path: prefix the
  command with `MSYS_NO_PATHCONV=1`.
- **Host `pnpm dev` does not restart a crashed worker** (`tsx watch` waits for a file change and prints nothing). Restart supervision
  exists only in the container stack ([docker-compose.md](docker-compose.md#supervision-what-restarts-the-worker-and-what-does-not)).
- **Ports busy:** another project on 3000/5173/5432/6379? Change `API_PORT`, `WEB_PORT`, `POSTGRES_PORT`, `REDIS_PORT` in `.env`
  (keep `DATABASE_URL`/`REDIS_URL` in step; `pnpm check:env` tells you if they disagree).

## Troubleshooting

| Symptom                                                    | Likely cause and fix                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API exits with a message naming `DATABASE_URL`/`REDIS_URL` | `.env` missing: run `pnpm setup:env`                                                                                                                                                                                                                                 |
| `password authentication failed` after editing `.env`      | PostgreSQL only applies the password when its volume is created; see [infrastructure.md](infrastructure.md)                                                                                                                                                          |
| Worker container `Exited (2)`                              | Invalid worker configuration: `pnpm stack:logs` names the variable (never its value)                                                                                                                                                                                 |
| Worker container `unhealthy`                               | `docker inspect --format '{{json .State.Health}}' <container>`: the last probe line says why (not ready / Redis down / stale heartbeat)                                                                                                                              |
| `stack:up` build fails on `apt-get` with 503               | A transient Debian mirror error; the Dockerfile retries 5 times, run it again                                                                                                                                                                                        |
| Image build fails with `DeadlineExceeded`                  | Docker Hub unreachable or slow from your network (BuildKit resolves base-image tags online). Check `docker buildx imagetools inspect node:22.14.0-bookworm-slim` and retry when it answers. `SYSTEST_SKIP_BUILD=1` runs the system tests on images you already built |
| `ERR_PNPM_IGNORED_BUILDS` after adding a dependency        | Allow or deny its install script in `pnpm-workspace.yaml` (`allowBuilds`)                                                                                                                                                                                            |

## Testing

| Suite                 | Command                                                                       | Needs                      | Scope                                                                                         |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Static                | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm check:architecture` | nothing                    | Prettier, ESLint + architecture rules, TypeScript, module cycles, **environment consistency** |
| Unit                  | `pnpm test`                                                                   | nothing                    | All packages and apps, no infrastructure                                                      |
| Integration           | `pnpm test:integration`                                                       | `pnpm infra:up`            | API against real PostgreSQL/Redis; worker host and **worker process** against real Redis      |
| System                | `pnpm test:system`                                                            | Docker (builds the images) | The whole Compose stack as a black box: see below                                             |
| Everything but system | `pnpm verify` + `pnpm test:integration`                                       | `infra:up`                 | The set CI's `verify` and `integration` jobs run                                              |

- **Run one file:** `pnpm --filter @agentos/worker exec vitest run src/health.spec.ts`; integration:
  `pnpm --filter @agentos/worker exec vitest run --config vitest.integration.config.ts test/timeout.int.spec.ts`.
- **Integration tests are isolated by construction:** Redis logical database 15 with a unique key prefix per test, throwaway
  PostgreSQL databases, nothing in your development data. They synchronize on conditions (job state, logs, events), not sleeps;
  the few bounded "this must not happen" waits are named `staysTrue` and say so.
- **Worker process tests** run the built `apps/worker/dist` (Nx builds it first) and a test-only entry
  (`apps/worker/test/support/stuck-main.ts`) that adds a handler which never ends. The POSIX-only signal tests are listed as
  _skipped_ on Windows and run on Linux.
- **System tests** (`tests/system`) build the images once (`SYSTEST_SKIP_BUILD=1` reuses them), then each test file starts its own
  throwaway Compose project (`agentos-systest-<id>`: own volumes, network, random ports, generated credentials) and removes it
  at the end. They never touch your `agentos` project. They take several minutes. Files:

  | File                           | What it verifies                                                                                                                                                                                                                             |
  | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `dependencies.system.spec.ts`  | API starts with no dependencies (alive, not ready, leaks nothing), becomes ready when they appear; losing and regaining PostgreSQL / Redis flips readiness and recovers with **no API restart**                                              |
  | `stack.system.spec.ts`         | Migrate before API; all healthy; loopback-only ports; web -> API proxy; a job processed by the worker container; worker has no DB credentials; **graceful shutdown, every exit code 0**; volumes and data survive `down`                     |
  | `worker.system.spec.ts`        | Healthy worker; Redis outage: not ready then recovered in the **same process, one connection**; crash -> Docker restart + job recovered; SIGTERM -> exit 0, **not restarted**; forced stop leaves the job unacknowledged and it is recovered |
  | `worker-config.system.spec.ts` | Invalid configuration: exit 2, **exactly 5 restarts**, then stays down, names the variable, no credential                                                                                                                                    |
  | `worker-stuck.system.spec.ts`  | A handler that ignores its abort signal, under the real supervisor: restarts are bounded and BullMQ fails the poison job                                                                                                                     |

- **Do not use `docker kill`/`docker stop` to simulate a crash** in your own tests: Docker treats them as a manual stop and never
  applies the restart policy. Signal the process inside the container (`Stack.signalWorkerProcess`).
- A failing system test leaves nothing behind (cleanup runs in `afterAll`); if a run is aborted, list leftovers with
  `docker ps -a --filter name=agentos-systest-` and remove only those.
