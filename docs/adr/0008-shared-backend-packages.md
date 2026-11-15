# ADR-0008: Shared backend packages (config, logger, queue)

**Status:** Accepted (pending architectural review)
**Context:** [ADR-0002](0002-phase-1-1-scope-reduction.md) kept config and logging inside `apps/api` "until a second consumer
needs them". The worker is that second consumer, and the API will produce jobs with the same queue definitions the worker
consumes. The rule (monorepo.md): extract shared code only with multiple consumers.

## Decisions

Three packages, tagged `type:lib` + `scope:backend` (so `apps/web` cannot import them), each importable only through its entry:

| Package           | Contents                                                                                                | Depends on                      | Consumers          |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------ |
| `@agentos/config` | `parseConfig`, `ConfigError`, shared env schemas (node env, log level, Redis/Postgres URL), `redactUrl` | zod                             | api, worker        |
| `@agentos/logger` | pino options, redaction paths, `createLogger`                                                           | pino                            | api, worker        |
| `@agentos/queue`  | Redis connection roles, retry policy, queue definitions, `QueueProducer`                                | contracts, bullmq, ioredis, zod | worker (api later) |

- **Config:** both apps validate their own environment with their own schema; only the building blocks and the error type are
  shared, so the API and worker cannot disagree on what a valid `REDIS_URL` is. Error messages name variables, never values.
- **Logger:** the worker reuses the API's pino conventions and redaction list rather than introducing a second logging approach.
  The API's behavior is unchanged (its tests are unchanged and pass).
- **Queue:** the one place (with the worker runtime) that talks to BullMQ. The API will use `QueueProducer` rather than BullMQ.
- **Job contracts stay in `@agentos/contracts`** (zod only), so the web app could in principle share job-related types without
  pulling in infrastructure.
- **Not extracted:** the worker runtime (single consumer; see ADR-0006), Prisma (the worker has no database access).
- **Dependency rule:** the allowlist in `eslint.config.mjs` (`IMPORTABLE_WORKSPACE_PACKAGES`) was widened from `contracts` to
  these four; per-package `no-restricted-imports` rules keep `config`/`logger` leaf-like and `queue` framework-free.

## Consequences

- The API's `modules/config` and `common/logging` are now thin wrappers over shared code (a refactor of existing files, with
  no change of behavior or public API; existing API tests are untouched).
- Adding a fifth shared package still requires editing the allowlist: deliberate friction.

## Alternatives considered

- **Duplicate config/logging in the worker:** rejected; two copies of redaction rules or URL validation drift.
- **Put everything in `@agentos/contracts`:** rejected; contracts must stay zod-only so the browser can use it.
- **One `@agentos/backend-common` package:** rejected; an unfocused dumping ground that every backend piece would depend on.
