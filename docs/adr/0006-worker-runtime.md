# ADR-0006: Worker runtime

**Status:** Accepted (pending architectural review)
**Context:** Later phases need background execution (agent runs, repository scanning, MCP, scheduled work). The specification
calls for a modular monolith plus independent workers, with AgentOS owning orchestration and queue libraries being replaceable
infrastructure. The earlier Phase 1 build (branch `phase-1-foundation`) had a BullMQ worker tightly coupled to the rest of the
code; this phase rebuilds it as a foundation without any domain logic. Operational guide:
[workers.md](../architecture/workers.md).

## Decisions

### 1. One reusable worker host, not one app per future worker

A `WorkerHost` owns the Redis connection, one BullMQ worker per queue, the lifecycle and the shutdown, and knows nothing about
any job. Processors are registered by `(queue, type, version)`. A specialized worker (agent, repository, MCP) is the same host
with a different `WORKER_QUEUES` and registry. This avoids copy-pasted lifecycle code, which is where worker bugs hide.

### 2. The host lives in `apps/worker/src/runtime`, not in a package (yet)

Only one worker app exists. A package with a single consumer is an abstraction without a reason (rule 5), so `runtime/` is a
folder with an enforced boundary: it imports nothing from `processors/`, `config`, `app` or `main`, and processors use it only
through `runtime/index.ts`. **Extraction trigger:** when a second worker app needs the host, move `runtime/` to
`packages/worker-runtime` unchanged.

### 3. Framework-free, no database

The worker has no NestJS, no HTTP server and no Prisma. NestJS would bring a DI container and request lifecycle that a queue
consumer does not need, and make the worker's shutdown semantics depend on a framework. There is no database access in this
phase; the lint rules forbid Prisma, NestJS and pg in `apps/worker` so adding them is a deliberate, reviewed act.
**Open question for review:** when the first processor needs PostgreSQL, options are (a) a shared Prisma package extracted from
the API, (b) the worker calling the API, (c) both with an outbox. Not decided here.

### 4. BullMQ behind our types

BullMQ is used for queues, retries, backoff and stalled-job recovery (we do not build our own). Its types do not leak: producers
use `QueueProducer` and contract job definitions; processors see a `JobContext` and a typed payload. `bullmq` is importable only in
`packages/queue` and `apps/worker/src/runtime`; `ioredis` only in `packages/queue` (and the API's `modules/redis`). Replacing
BullMQ means rewriting those two places.

BullMQ **5.76.3** and ioredis **5.10.1** are pinned exactly. BullMQ 5.x depends on the same ioredis we already pin, so there is one
Redis client version in the workspace. BullMQ 6.x was not adopted: it no longer lists ioredis as its dependency, which would split
the client versions. **New dependency (rule 4):** `bullmq` (queue engine, the reason for this ADR); `msgpackr-extract` (a
native optional accelerator pulled in by BullMQ) is disabled in `pnpm-workspace.yaml` `allowBuilds`: BullMQ falls back to pure JS.

### 5. Shutdown never acknowledges unfinished work

Graceful shutdown pauses fetching, waits for active jobs up to a grace period, then closes cleanly. If the grace period expires,
the worker force-closes BullMQ and the socket **before** aborting handlers, leaving jobs active with an expiring lock so they are
redelivered, and exits 1. (Verified from BullMQ's source: `close()` cannot be upgraded to a forced close once called, and
completion/failure handlers are skipped on a closing connection, hence this order.) Acknowledging an interrupted job as failed
or completed would silently lose or duplicate work.

### 6. Connection roles

Workers wait for Redis (`maxRetriesPerRequest: null`, required by BullMQ) and reconnect forever with a capped delay; producers
fail fast so an API request cannot hang. A worker that cannot reach Redis is not ready but does not exit; failing to _start_
within `WORKER_STARTUP_TIMEOUT_MS` does exit (1) so a supervisor surfaces a misconfiguration.

### 7. No HTTP server for health

The worker exposes no port. Readiness is available in-process and through logs. How orchestrators probe a worker is a
deployment-phase decision (probe file, socket, or an HTTP endpoint if justified).

## Consequences

- A future worker is a registry and a config value, not a new runtime.
- The worker is a second deployable and a third `dev` process (`pnpm dev` runs three in parallel).
- Workers cannot yet touch the database (see decision 3).

## Alternatives considered

- **NestJS standalone application for the worker:** rejected (decision 3).
- **A worker app per future worker type now:** rejected (decision 1); premature.
- **A `packages/worker-runtime` package now:** rejected (decision 2).
- **Homegrown queue on PostgreSQL / Redis streams:** rejected; BullMQ solves retries, backoff and stalled recovery, and the
  adapter boundary keeps it replaceable.
