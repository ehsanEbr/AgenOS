# ADR-0007: Job contract and delivery semantics

**Status:** Accepted (pending architectural review)
**Context:** Producers (the API, schedulers) and workers deploy independently and may briefly run different versions. Queued work
must be inspectable and safe under crashes, retries and redeployments. Operational guide:
[workers.md](../architecture/workers.md).

## Decisions

### 1. A minimal, versionable envelope validated at the worker boundary

Every job carries `{ type, version, correlationId, createdAt, payload }`; the job id, attempt count and queue come from BullMQ.
The envelope and each job's payload schema live in `@agentos/contracts` (zod only), so both sides share one definition. The
worker validates the envelope, then looks up the processor by `(queue, type, version)`, then validates the payload with the
processor's schema, **before** any handler runs. Producers validate too, so a producer cannot send what its own contract
rejects. Unknown extra envelope keys are ignored (forward compatibility); an unknown `type` or `version` is a permanent failure,
not a crash.

### 2. At-least-once delivery, stated plainly

A job can be delivered more than once (crash, forced shutdown, lock loss, manual retry). **We do not claim exactly-once**, and we
do not build a generic database idempotency layer. The processor contract is: be idempotent, honor the abort signal, signal
permanent failures with `PermanentJobError`, never log payloads. The runtime acknowledges a job only after its handler returns,
and never acknowledges an interrupted one.

### 3. Failure classification decides retry

`permanent` (invalid envelope, unknown type/version, invalid payload, `PermanentJobError`) is never retried. `transient` and
`timeout` are retried within the attempt budget. `aborted` (forced shutdown) is not acknowledged and is redelivered. A permanent
failure is turned into BullMQ's `UnrecoverableError`. Retrying malformed input would only burn attempts and delay real work.

### 4. Retry is a code-level policy: exponential, jittered, bounded

Defaults: 3 attempts, 1 s base, jitter 0.5, each bounded and validated (attempts 1-10, one wait at most one hour). Defined in
`@agentos/queue`, not environment variables, because the policy is a property of the job as the producer enqueues it and an
environment variable on the worker could contradict the producer. Producers can override per job. Exhausted jobs stay in the failed set
for 7 days / 5000 jobs (completed: 1 hour / 1000), bounding Redis memory.

### 5. Timeouts cannot kill, so the attempt is held until the handler ends

_Amended after a reliability review; the first implementation released the job at the timeout._ JavaScript cannot kill a running
async function. A handler that exceeds `WORKER_JOB_TIMEOUT_MS` has its signal aborted and the attempt is classified `timeout`,
but the attempt is **not released to BullMQ until the handler has actually ended**. Releasing it earlier let the retry start while
the first handler was still running; this was reproduced (two concurrent executions of one job). While held, the lock keeps
being renewed, so no worker can take the job. The timer, not the handler's late result, decides the classification. A handler
still running `WORKER_ABORT_GRACE_MS` after the timeout is reported as stuck and the worker restarts (exit 1): process exit is the
only real kill, and process isolation per job (worker threads, child processes) was evaluated and not adopted. Idempotency is
still mandatory: retries and redeliveries still happen, one after another instead of side by side. Details and limits (a synchronous loop that blocks the
event loop is not protected): [workers.md](../architecture/workers.md#timeouts-and-handler-execution-safety).

### 6. Correlation and logging

The correlation id is set by the producer (the API's request id, or a generated one), stored in the envelope, and present on
every worker log line for the job. One structured line per execution; payloads and credentials are never logged. Field names are
flat and stable for a later OpenTelemetry bridge.

## Consequences

- Rolling deploys are safe in one direction: a worker that does not know a new type/version fails those jobs visibly (retryable
  by an operator after the deploy) instead of mis-processing them. Keep old versions registered until jobs drain.
- Idempotency is every processor author's job; review must check it.
- Because the queue is Redis, a job enqueued after a database commit can be lost between the two writes. The transactional outbox
  is the planned remedy and is out of scope here.

## Alternatives considered

- **Exactly-once via a dedupe table:** rejected; it cannot be generic and would couple the worker to the database.
- **Retry policy in worker environment variables:** rejected (decision 4).
- **Retry every failure including malformed jobs:** rejected (decision 3).
