# ADR-0009: System integration, supervision, health and CI

**Status:** Accepted (pending architectural review)
**Context:** Phases 1.1-1.5 produced a web app, an API, a worker and shared packages, each verified on its own. Nothing ran them
together in containers, nothing supervised the worker whose Phase 1.5 timeout design requires a restart on exit code 1, the worker
had no observable health, CI was one sequential job, and no test exercised the system as a whole. Operational guides:
[docker-compose.md](../architecture/docker-compose.md), [ci.md](../architecture/ci.md),
[development.md](../architecture/development.md), [environment.md](../architecture/environment.md),
[system-overview.md](../architecture/system-overview.md).

## Decisions

### 1. The full stack is a Compose profile; images are development images

Web, API, worker and a one-shot `migrate` service are added to the existing Compose file behind the profile `app`, so
`pnpm infra:up` is unchanged and `pnpm stack:up` starts everything, in dependency order, until healthy. One multi-stage
Dockerfile builds once and has three targets (`api`, `worker`, `web`). Services use `restart: on-failure:5` and `init: true`. Only
`api` and `migrate` receive PostgreSQL credentials. The images are **not** production images: they contain the built workspace
with dev dependencies (about 1.4 GB) and nginx for the web target. Production images, scanning and publishing are a later phase.
The network name is parameterized (`AGENTOS_NETWORK`, default unchanged) so a throwaway test stack cannot share DNS names with a
developer's stack.

### 2. Supervision is Docker's restart policy, with its limits documented and tested

`on-failure:5` restarts a process that exits non-zero and leaves a clean exit alone. Verified against real containers: crash ->
restart and job recovery; exit 0 -> no restart; invalid configuration (exit 2) -> exactly five restarts, then `Exited (2)` with the
variable named in the logs; a stuck handler -> restarts bounded by BullMQ failing the poison job after two stalls. Known limits
(documented, not hidden): the policy cannot exclude exit code 2; the count resets after 10 s of uptime, so a systematic crash loop
is not bounded; Docker never restarts after a command through its API (`docker stop/kill`), so crash tests must signal the process
inside the container; and a restart policy is **not** a health check. Host `pnpm dev` has no supervisor (`tsx watch` leaves a
dead worker down), deliberately.

### 3. Worker health is a heartbeat file, not an HTTP server

The worker rewrites one small JSON file every 5 s (and immediately on state changes, notably the start of shutdown);
`healthcheck.js` judges it. The file is never trusted alone: the writer's pid must be alive, the heartbeat fresh (3 intervals)
and the worker ready (running **and** Redis connected). A killed worker's leftover "ready" file, a hung event loop and a draining
worker are all unhealthy. No port, no server, no new dependency; `WORKER_HEALTH_FILE` unset disables it. Limit: it is observable
only inside the container, and Compose marks the container `unhealthy` without restarting it. If a network-reachable probe is
needed later (an orchestrator that cannot exec), a small endpoint can be added then; the decision is deferred, not foreclosed.

### 4. `runWorker({ registry })`

`main.ts` was split: process behavior (config, signals, health, exit codes) lives in `run.ts` and takes the processor registry;
`main.ts` is three lines that pass the production registry. This lets tests run the **real** entry point with a test-only
processor that never ends (`test/support/stuck-main.ts`), instead of putting such a processor in the shipped registry.

### 5. The API exits 0 after a clean shutdown (touches Phase 1.3 code)

NestJS's `enableShutdownHooks()` runs the shutdown and then re-raises the signal, so the API ends as "killed by SIGTERM" (exit
143), indistinguishable by exit code from a process that never handled the signal and a "failure" for restart policies. The
system tests found this. `main.ts` now calls `app.close()` itself on SIGTERM/SIGINT and exits 0 (1 if closing fails). The same
destroy hooks run; only the exit code and the absence of the re-raise change. ADR-0004's mention of `enableShutdownHooks` is
historical; backend.md and infrastructure.md describe the current mechanism.

### 6. System tests: a separate workspace project, isolated throwaway stacks

`tests/system` (`@agentos/system-tests`, `tests/*` added to the workspace) drives Docker from outside: no application source is
imported. Each test file creates a Compose project `agentos-systest-<id>` with its own volumes, network, random ports and
generated credentials, and removes it afterwards; the harness refuses to delete volumes of any project without that prefix.
`pnpm test:system` is a separate command because it needs Docker and takes minutes.

### 7. CI: split jobs, one gate, a separate Windows workflow

`verify` (static + unit + build), `integration` (real PostgreSQL/Redis), `system` (images + Docker tests) and `ci-result`, a single
required status that fails unless every job succeeded. The install is one composite action. `setup:env` masks the generated
credentials. A separate `windows` workflow runs what needs no Docker. See [ci.md](../architecture/ci.md) for the reasoning.
**Not executed by GitHub Actions yet** (branch not pushed): validated with `actionlint` and by running every command locally.

### 8. Environment consistency is a checked property

`tools/check-env.mjs` (in `pnpm check:architecture`) compares the app config schemas, `.env.example`, Compose and the Dockerfile.
On its first run it found a real defect: Compose passed `DATABASE_URL` to the worker. It uses the `yaml` package, already in the
lockfile as a transitive dependency and now pinned (2.9.1) as a root devDependency so that `tools/` can import it (rule 4: no new
package is downloaded).

## Consequences

- A developer can run the whole system with documented commands and see its lifecycle behavior, not just read about it.
- The Phase 1.5 timeout guarantee now has the supervisor it assumed, and its operational claims are tested end to end.
- CI has more jobs and a longer wall-clock time (the system job builds images); each job is independently diagnosable.
- Two more things to maintain: the Dockerfile/Compose pair and the system-test harness.

## Alternatives considered

- **Apps only on the host, Compose for infrastructure only:** rejected for supervision: nothing would restart the worker.
- **An HTTP health server in the worker:** rejected as premature (decision 3).
- **A wrapper process that does not restart on exit code 2:** not justified for one case; bounded retries with persistent logs suffice.
- **An autoheal sidecar to restart unhealthy containers:** additional infrastructure, out of scope; the limitation is documented.
- **A wrapper in the API instead of changing `main.ts`:** the explicit handler is smaller and clearer than suppressing Nest's re-raise.
- **A Linux-only CI with no Windows job:** rejected; the Windows job is cheap and catches a class of problems nothing else does.

## Decisions requiring approval

1. Development-grade fat images now, production images later (decision 1).
2. `on-failure:5` as the restart policy, with the documented limits, and no autoheal (decision 2).
3. Heartbeat file instead of a worker endpoint (decision 3).
4. The small change to the API's shutdown code (decision 5).
5. `tests/*` as a workspace glob and `pnpm test:system` outside `pnpm verify` (decision 6).
6. Whether the `windows` job becomes a required status (decision 7).
7. CI triggers: `main` pushes and pull requests only; phase branches get CI through their pull requests.
