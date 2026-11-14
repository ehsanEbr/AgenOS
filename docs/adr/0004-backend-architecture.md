# ADR-0004: Backend application architecture (Phase 1.3)

**Status:** Accepted (Phase 1.3)
**Context:** Phases 1.1-1.2 delivered an API skeleton with configuration, logging, health, Prisma and Redis. Before any
domain exists, the conventions that every domain will follow need to be fixed and, where possible, enforced mechanically
so they do not erode. The operational rulebook is [backend.md](../architecture/backend.md); this ADR records the decisions
and the reasons.

## Decisions

1. **Two module shapes, chosen by complexity.** Flat (controller, service, repository) is the default; layered
   (`domain` / `application` / `infrastructure` / `presentation`) is for domains with real invariants. Layers are created
   only when they have content. _Why:_ the spec's layered structure is right for the Agent Runtime but would be ceremony for
   simple CRUD; forcing empty layers is the abstraction the project rules forbid.

2. **A module's public interface is its `index.ts`; everything else is private.** Enforced by ESLint patterns plus a
   depth-agnostic script (`tools/check-module-boundaries.mjs`, run inside `lint`) that also detects circular module
   dependencies. _Why:_ ESLint patterns on relative paths cannot reliably detect "reaching into a sibling" from layered
   folders (the `../` count varies with depth) and cannot see cycles; a script that resolves each import to its target module
   can. It has its own tests.

3. **Dependency direction inside a domain is enforced by ESLint:** presentation -> application -> domain <- infrastructure.
   The domain is framework-free; the application layer cannot touch Prisma/Redis drivers or inject `PrismaService`/`RedisService`;
   controllers cannot import infrastructure or the database/redis modules.

4. **Prisma may be imported in `modules/database` and in a domain module's `infrastructure/` layer.** _Amends ADR-0003 decision 6_,
   which allowed it only in `modules/database`. That rule would have made it impossible for a domain's repository (the
   persistence adapter) to use Prisma without routing every query through the database module. Prisma stays out of
   domain, application, presentation, `common/`, the web app and `packages/contracts`. ioredis stays confined to `modules/redis`.

5. **Infrastructure modules (`config`, `database`, `redis`) are leaves.** They may depend on `common/` and (database, redis) on
   `config`; never on a domain or on each other. Enforced.

6. **`AppError` is the only error that domain/application code throws on purpose.** It has no framework imports; its `kind` maps
   to an HTTP status in one place. Everything that is not an `AppError` or `HttpException` is an unexpected error: logged at
   `error` with the stack, answered with a generic 500. Expected 5xx are logged at `warn`. _Why:_ a layered design needs an error type the domain can
   throw without importing NestJS, and operations needs to separate "a dependency is down" from "we have a bug".

7. **The application service owns the transaction boundary, via `TransactionRunner`.** Repositories take an optional `DatabaseClient`
   handle. Defaults are explicit (2 s wait, 5 s run). A statement on the root client inside `run()` is not transactional, and
   this is documented and tested. No unit-of-work framework, no decorator-based transactions.

8. **Prisma failures are classified once.** Repositories translate outcomes they understand (`isUniqueConstraintViolation`, ...);
   `DatabaseExceptionFilter` turns connectivity failures into `503 database_unavailable` and everything else into a generic 500,
   never logging or returning Prisma messages (which can embed query arguments). It is registered in `AppModule` after the
   catch-all filter because Nest gives later filters priority (tested).

9. **Request context uses `AsyncLocalStorage` through Nest module middleware.** It holds only `correlationId` for now.
   Registered as module middleware (after body parsing) rather than `app.use()`, because stream events during body parsing can
   drop the store (tested with a body-bearing request). A pino `mixin` adds the correlation id to every log line in a request.
   No external context library.

10. **Logging is an allowlist.** The request log contains `req {id, method, path}` and `res {statusCode}` only: no headers, no query
    string (tokens), no bodies. Redaction remains as a safety net. Health probes are not logged.

11. **Pagination, sorting and OpenAPI helpers are added now** because every list endpoint in the specification will need them:
    `paginationQuerySchema`, `paginatedSchema(item)` and `sortQuerySchema(allowlist)` in contracts (offset/limit, `{ items, page }`,
    `?sort=-field`), and `ApiZodBody/ApiZodQuery/ApiZodResponse/ApiStandardErrors` decorators so documentation derives from
    the contracts. There is deliberately no generic success envelope: single resources are returned as themselves.
    Offset pagination is a known fit for UI tables but not for large append-only streams; cursor pagination will be introduced by ADR
    when the first such collection (execution events, audit logs) is built.

12. **Idempotent shutdown for every infrastructure service.** The second `onModuleDestroy` returns the first call's promise, so
    `enableShutdownHooks` plus a manual `close()` cannot double-close or throw.

13. **Required vs optional dependencies are explicit in code.** `DEPENDENCIES` in `health.service.ts` carries a `required` flag; only
    required dependencies affect readiness. Both PostgreSQL and Redis are required today.

14. **No CQRS, event sourcing, mediator, generic repositories or generic CRUD services.** Each needs a demonstrated requirement and an ADR.

15. **Prisma stays in `apps/api`.** The transaction and error helpers are framework-free so they can move to a `packages/database`
    library unchanged. That extraction is triggered by the first worker that needs the database (see backend.md section 4); it is not
    done now because it would have no second consumer.

## Dependency changes

- `express` 5.2.1 added as an exact-pinned **devDependency** of `apps/api`, used only by `logging.spec.ts` to exercise `pino-http`
  in a real Express app. It is the same version Nest's Express adapter already installs, so no second copy is added.
- No runtime dependencies were added.

## Consequences

- New domains get a checklist (backend.md section 9) and most violations fail `pnpm lint`.
- The conventions are unproven against a real domain; the first domain phase may require amendments (record them in an ADR).
- The module-boundary script is custom code the project must maintain. It is ~100 lines with tests and replaces what would otherwise be an extra
  lint plugin plus a cycle-detection dependency.
