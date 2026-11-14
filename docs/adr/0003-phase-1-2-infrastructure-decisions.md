# ADR-0003: Phase 1.2 infrastructure decisions

**Status:** Accepted (Phase 1.2)
**Context:** Phase 1.2 introduces PostgreSQL, Redis and Prisma into the modular monolith without any domain model,
queue or worker. These choices constrain later phases, so they are recorded here.

## Decisions

1. **Prisma lives in `apps/api/prisma/`, not in a root `database/` directory.**
   The specification (section 4.1) sketches `database/prisma/`; the Phase 1.2 task asks for Prisma inside `apps/api`.
   With a single backend process there is no second consumer to justify a shared package. If workers later need the
   client, extract it then (a `database` library), under the existing "extract only with multiple consumers" rule.
   _Deviation from the specification's directory sketch._

2. **Prisma 6.19.3, exact pins, `prisma.config.ts`, no Prisma 7.**
   Prisma 6 is the last major with the classic `prisma-client-js` generator; `package.json#prisma` is deprecated, so the
   config file is used. Prisma 7 requires driver adapters and a new generator, and 8.x is a release candidate; moving
   there is a separate task. `prisma` and `@prisma/client` must always have the same version, hence exact pins.

3. **Multi-file schema (`prisma/schema/*.prisma`).** `base.prisma` holds the generator and datasource only; each domain
   adds its own file. This keeps domain schemas independently reviewable and mirrors the module boundaries.

4. **No placeholder models, no empty migration.** Domain entities belong to their phases. The migration workflow is
   documented and was verified against the empty schema (it creates no tables).

5. **Infrastructure modules are explicit imports, not `@Global()`.** `DatabaseModule` and `RedisModule` must be imported by
   the modules that use them, so dependencies stay visible and boundary rules can reason about them. Services are still
   singletons (Nest modules are singletons).

6. **Drivers are confined by lint.** _(Amended by [ADR-0004](0004-backend-architecture.md) decision 4: Prisma is also allowed in a domain module's `infrastructure/` layer.)_ `@prisma/client`/`prisma` may be imported only in `modules/database`, `ioredis` only in
   `modules/redis`. `apps/web` and `packages/contracts` may import neither. Domain modules will receive data through their own
   repositories, never Prisma types, and `packages/contracts` stays Zod-only.

7. **The API starts without its dependencies and reports readiness.** A temporarily unavailable database must not crash-loop
   the process or hide the cause. Startup connection failures are logged (error class only), `/health/ready` returns 503, and
   both drivers reconnect on their own. Liveness (`/health`) never checks dependencies.

8. **Readiness responses have a fixed vocabulary.** `reason` is `timeout | unavailable`, enforced by the contract schema, so
   connection details cannot leak through health endpoints.

9. **Redis requires a password and persists to disk in development, but is not a data store.** AOF + snapshot only prevent
   losing cache warmth on restart. ADR-004 still holds: nothing authoritative lives in Redis.

10. **ioredis 5.10.1 (exact), not 6.x.** BullMQ 5.x (planned for the worker phase) depends on ioredis 5.10.1. Pinning the same
    version avoids shipping two ioredis copies when BullMQ arrives. Revisit when moving to a BullMQ release built on ioredis 6.

11. **No credentials in the repository, and none in the compose file's defaults.** `POSTGRES_PASSWORD` and `REDIS_PASSWORD`
    are required variables. `pnpm setup:env` generates random local passwords and never overwrites `.env`. Published ports are
    bound to `127.0.0.1`. Data deletion is a separate, confirmed command (`pnpm infra:destroy-data`), never the default cleanup.

12. **Volumes are named `postgres-data` / `redis-data` (project `agentos`).** This deliberately differs from the Phase 1
    volumes (`agentos_agentos-*`) so old data and an old migration history cannot collide with the new setup.

13. **Prisma generation is an Nx target (`generate`) that `build`, `typecheck`, `test` and `test:integration` depend on, and it is
    never cached** (its output lives in `node_modules`, which Nx does not restore).

## Consequences for later phases

- The first domain phase adds `prisma/schema/<domain>.prisma` and the first migration; CI already runs `db:validate` and
  `db:deploy` against real PostgreSQL.
- **BullMQ (worker phase):** reuse the Redis server and `REDIS_URL`, but create BullMQ-owned connections
  (`maxRetriesPerRequest: null` is required for workers). Do not reuse `RedisService.client`, which is configured to fail
  fast. A worker process will need Prisma too; that is the trigger to extract a shared database package (decision 1).
- **Multi-tenancy / Row Level Security** (spec 6.4) is not started. Pooled connections and tenant context must be designed
  when identity is implemented.
- Moving to Prisma 7 changes `prisma.config.ts`, the generator and `PrismaService` construction.
