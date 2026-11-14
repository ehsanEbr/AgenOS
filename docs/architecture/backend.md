# Backend architecture and conventions (Phase 1.3)

This is the rulebook for `apps/api`. Every future domain (Identity, Projects, Agent Runtime, Model Intelligence, MCP
Gateway, Software Intelligence, Observability, Security) is built the way this document describes. Rules marked
**[enforced]** fail `pnpm lint` or `pnpm check:architecture`; the rest are conventions reviewers check.

Decisions and their reasons: [ADR-0004](../adr/0004-backend-architecture.md). Infrastructure details (Docker, Prisma
workflow, readiness): [infrastructure.md](infrastructure.md). Workspace-level rules: [monorepo.md](monorepo.md).

## 1. Module structure

```text
apps/api/src/
├── main.ts, app.module.ts          composition root: imports modules, registers GLOBAL pipe/filters (modules never do)
├── bootstrap/                      HTTP setup shared by main.ts and tests (prefix, CORS, OpenAPI, correlation middleware)
├── common/                         framework-level building blocks used by every module (no business concepts)
│   ├── app-error.ts                AppError: the only error domain/application code throws on purpose
│   ├── api-error.ts, all-exceptions.filter.ts     error -> HTTP response
│   ├── request-context.ts (+module) AsyncLocalStorage request context
│   ├── logging.ts, correlation-id.middleware.ts
│   ├── zod-validation.pipe.ts      global validation (createZodDto)
│   ├── openapi.ts, zod-openapi.ts  OpenAPI decorators generated from contracts
│   └── with-timeout.ts
└── modules/
    ├── config/  database/  redis/  health/        today's modules
    └── <domain>/                   future domains, one folder each
```

### Two shapes of module, chosen by complexity

| Shape                  | Use when                                                                                                          | Layout                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Flat**               | Infrastructure modules and simple CRUD-like domains: little or no business rule beyond validation and persistence | `index.ts`, `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`, `<name>.repository.ts`  |
| **Layered** (DDD-lite) | A domain with real invariants, state machines or policies (agent execution lifecycle, routing policy, approvals)  | `domain/`, `application/`, `infrastructure/`, `presentation/` plus `index.ts` and `<name>.module.ts` |

Start flat. Move to layered when the service layer starts to mix business rules with orchestration, or when rules need
to be unit-tested without Nest or a database. **Create only the folders that have content**: no empty layers, no
pass-through classes. Today `config`, `database`, `redis` and `health` are flat.

### Layered module layout (illustrative, no such module exists yet)

```text
modules/agents/
├── index.ts                      PUBLIC API: the module class + the application services / types other modules may use
├── agents.module.ts              Nest wiring; binds ports to adapters
├── domain/                       plain TypeScript: entities, value objects, domain services, policies, PORTS (interfaces)
│   ├── agent.ts                  entity with its invariants
│   ├── agent-status.ts           value object / state machine
│   └── agent.repository.ts       port: `interface AgentRepository { findById(id, tx?): Promise<Agent | null> ... }`
├── application/                  use cases: orchestration, transactions, authorization checks, throws AppError
│   ├── create-agent.service.ts
│   └── dto/                      application-level input/output types (not HTTP DTOs)
├── infrastructure/               adapters: the ONLY place in a domain module that may use Prisma
│   ├── prisma-agent.repository.ts   implements the port; maps Prisma rows <-> domain entities
│   └── mappers.ts
├── presentation/                 HTTP: controllers, HTTP DTOs (createZodDto), response mappers
│   ├── agents.controller.ts
│   └── agent-response.mapper.ts  domain entity -> contract type from @agentos/contracts
└── agents.service.spec.ts ...    specs live next to the code they test
```

The corresponding Prisma file is `apps/api/prisma/schema/agents.prisma`; the contracts live in `packages/contracts/src/agents.ts`.

## 2. Ownership, visibility and dependency direction

**Ownership.** A module owns its data (tables/models in its own `.prisma` file), its Redis key prefix, and its
HTTP routes. Nobody else reads or writes them directly.

**Public interface.** `index.ts` is the module's contract with the rest of the API. Export the Nest module and the few
application services/types others are meant to call. Everything else is private.

**Dependency direction** (arrows mean "may import"):

```text
presentation ──► application ──► domain ◄── infrastructure
      │               │                          │
      └──────► common/ (errors, helpers) ◄───────┘          modules ──► other modules' index.ts only
                 infrastructure modules (config, database, redis) are leaves: they depend on nothing but common/ and config
```

| Rule                                                                                                                                                           | Enforced by                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Another module is imported only through its `index.ts` (`../config`, never `../config/config.module`), from any folder depth                                   | **[enforced]** ESLint (flat modules and from outside `modules/`) + `tools/check-module-boundaries.mjs` (every depth) |
| No circular dependencies between modules (a -> b -> a or longer)                                                                                               | **[enforced]** `tools/check-module-boundaries.mjs` (runs inside `pnpm lint` and `pnpm check:architecture`)           |
| `domain/` is plain TypeScript: no NestJS, Express, Prisma, ioredis, no `application/` `infrastructure/` `presentation/`, no database/redis modules             | **[enforced]** ESLint                                                                                                |
| `application/` does not import `infrastructure/` or `presentation/`, Prisma, ioredis or Express; it may not inject `PrismaService` / `RedisService`            | **[enforced]** ESLint                                                                                                |
| `presentation/` (controllers) does not import `infrastructure/`, the database/redis modules, Prisma or ioredis: **no direct database access from controllers** | **[enforced]** ESLint                                                                                                |
| `infrastructure/` may use Prisma, but not ioredis and not `presentation/`                                                                                      | **[enforced]** ESLint                                                                                                |
| `@prisma/client` only in `modules/database` and in a domain module's `infrastructure/`; `ioredis` only in `modules/redis`                                      | **[enforced]** ESLint                                                                                                |
| `config`, `database`, `redis` never import business or sibling modules (only `config`)                                                                         | **[enforced]** ESLint                                                                                                |
| `apps/web` and `packages/contracts` never import Prisma, ioredis or backend code                                                                               | **[enforced]** ESLint + Nx tags                                                                                      |
| Global providers (pipes, filters, interceptors) are registered only in `AppModule`                                                                             | convention (review)                                                                                                  |
| A domain only touches its own tables                                                                                                                           | convention (review)                                                                                                  |

Never weaken a rule to make an import compile. Move the code, introduce a port, or write an ADR.

### Cross-module communication

1. **Synchronous call through the public API.** Module B imports `AgentsModule` from `../agents` and injects an
   exported application service. That is the default.
2. **Direction matters.** If A needs B, B must not need A. When both seem to need each other, the dependency is
   hiding a missing concept: extract the shared part into a third module that both depend on, or invert one direction
   with a port that the other side implements.
3. **Never** share tables, repositories, Prisma models or entities across modules. Pass identifiers and plain data
   (types from the callee's `index.ts` or `@agentos/contracts`).
4. **Asynchronous / eventual communication** (domain events, the transactional outbox of spec 11.4, queues) arrives with
   the worker phase. Until then do not simulate it in-process.

## 3. Application layer conventions

| Piece                       | Responsibility                                                                                                                                                                                                              | Must not                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Controller**              | Thin. Declares route + OpenAPI, receives a validated DTO, calls ONE application method, maps the result to a contract type, chooses the HTTP status.                                                                        | contain `if`/loops over business data, call repositories or Prisma, open transactions, catch-and-translate domain errors |
| **Application service**     | One use case per method: authorization check, load, apply rules, persist, return. Owns the **transaction boundary**. Throws `AppError`.                                                                                     | know about HTTP, `Request`/`Response`, DTO classes, or Prisma types                                                      |
| **Domain service / entity** | Business rules that do not fit one entity, or invariants that must hold regardless of how the data arrived. Pure and synchronous where possible.                                                                            | do I/O, import Nest, throw anything but `AppError`                                                                       |
| **Repository**              | Persistence for one aggregate/table group. Port in `domain/` (or beside the service in flat modules), implementation in `infrastructure/`. Accepts an optional `tx`. Translates DB outcomes it understands into `AppError`. | open transactions, leak Prisma row types out of the module, contain business rules                                       |
| **DTO**                     | HTTP input: `class XDto extends createZodDto(schema) {}` where `schema` comes from `@agentos/contracts`.                                                                                                                    | duplicate a contract schema by hand                                                                                      |
| **Response mapper**         | Explicit function from domain entity to a contract type. Dates become ISO strings; internal fields are dropped.                                                                                                             | return Prisma rows or entities directly                                                                                  |

### When a simple application service is enough, and when it is not

- **Plain service + repository (flat module)** is the default. Use it while the rules are "validate, check
  uniqueness/permission, save".
- **Add a domain layer** when at least one holds: there is a state machine or invariant that several use cases must
  respect (execution states, approval flow); rules need to be unit-tested without a database; or the same rule is used by
  more than one use case. Put the rule in an entity/domain service, not in a controller or a repository.
- **Add a repository interface (port)** when the domain/application layer must stay independent of Prisma, which is
  always true for layered modules. For flat modules a concrete repository class is fine; do not add an interface "just in case".
- **Do not introduce** CQRS, event sourcing, mediator/command-bus libraries, generic base repositories or generic
  CRUD services. Each needs a demonstrated requirement and an ADR. Reasonable triggers: very different read and write
  models for the same data (CQRS), a regulatory need to replay history (event sourcing).

### Exception handling

Two kinds of failure, handled differently:

| Kind                                                                                         | Thrown as                                                                                | Becomes                                                         | Logged as                                                              |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Expected** (not found, conflict, rule violated, invalid input, forbidden, dependency down) | `AppError(kind, code, message, { details })` from domain/application/infrastructure code | The HTTP status of its `kind` with the standard `ApiError` body | nothing for 4xx (the request log has the status); `warn` for 5xx kinds |
| **Unexpected** (bug, unclassified failure)                                                   | any other exception                                                                      | `500 internal_error`, generic message                           | `error` with stack, for alerting                                       |

`AppError` kinds and statuses: `validation` 400, `unauthenticated` 401, `forbidden` 403, `not_found` 404, `conflict` 409,
`unprocessable` 422, `rate_limited` 429, `unavailable` 503. Codes are stable `snake_case` identifiers (`agent_not_found`)
that clients may switch on; the message is safe to show a user (no SQL, hostnames, stack traces or internal ids).
`AppError` has no framework imports, so the domain layer can throw it.

Framework `HttpException`s (unknown route, etc.) still work and use the same body. Prefer `AppError` in your code.

## 4. Database access

PostgreSQL is the source of truth. Redis is cache/ephemeral state only.

**Ownership and lifecycle.** `DatabaseModule` owns the single `PrismaService` (connects at startup without failing the
process, disconnects once on shutdown) and `TransactionRunner`. Only repositories (a domain's `infrastructure/`) inject
`PrismaService`. Application services inject repositories and `TransactionRunner`.

**Repositories** accept an optional handle so the same method works inside and outside a transaction:

```ts
// infrastructure/prisma-agent.repository.ts
@Injectable()
export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, db: DatabaseClient = this.prisma): Promise<Agent | null> {
    const row = await db.agent.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async create(agent: Agent, db: DatabaseClient = this.prisma): Promise<Agent> {
    try {
      return toDomain(await db.agent.create({ data: toRow(agent) }));
    } catch (error) {
      // Translate the outcomes this repository understands; everything else bubbles up to the global handler.
      if (isUniqueConstraintViolation(error))
        throw new AppError('conflict', 'agent_name_taken', 'An agent with this name exists');
      throw error;
    }
  }
}
```

**Transactions are explicit and owned by the application service:**

```ts
// application/create-agent.service.ts
async create(input: CreateAgentInput): Promise<Agent> {
  return this.transactions.run(async (tx) => {
    const agent = await this.agents.create(Agent.create(input), tx);   // every write that must be atomic gets `tx`
    await this.audit.record('agent.created', agent.id, tx);
    return agent;
  });
}
```

- `TransactionRunner.run(fn, { timeoutMs, maxWaitMs, isolationLevel })`: commits when `fn` resolves, rolls back and
  re-throws the same error when it throws. Defaults: wait 2 s to start, 5 s to run. Raise the isolation level
  deliberately, per use case.
- Pass `tx` to every statement that must be atomic. A statement on the root client inside `run()` is **not** part of
  the transaction (an integration test demonstrates this).
- Do not nest `run()` calls (that opens an unrelated second transaction), do not call HTTP services or wait on Redis
  inside a transaction, keep it short. A write-conflict (`isTransactionConflict`) may be retried by the application
  service when the use case is idempotent.
- Single statements do not need a transaction. Do not wrap reads "for consistency" without a reason.

**Error handling.** Repositories translate outcomes they understand via `isUniqueConstraintViolation`,
`isForeignKeyViolation`, `isRecordNotFound`, `isTransactionConflict`. Untranslated Prisma errors are caught by
`DatabaseExceptionFilter`: unreachable/timeout/pool-exhausted becomes `503 database_unavailable` (retryable), anything
else `500 internal_error`. Prisma messages can embed query arguments, so they are never logged or returned; only the error
class and Prisma code are.

**Boundaries.** No Prisma types in `packages/contracts`, in controllers, in application services or in the domain.
Prisma row types stay inside `infrastructure/`; mappers convert them to domain entities and contract types.

### Reusing database infrastructure from a worker (future)

Workers are separate processes and must not import `apps/api` code. The database infrastructure is prepared for that:

- `modules/database/transaction.ts` and `prisma-errors.ts` have **no NestJS imports** and depend only on
  `@prisma/client`, so they can move unchanged.
- The Prisma schema folder (`apps/api/prisma/schema`) and `prisma.config.ts` are self-contained.
- **When the first worker needs the database**, extract a library `packages/database` (tag `scope:backend`, `type:lib`)
  containing the schema folder, `prisma.config.ts`, a `createPrismaClient(url)` factory, `runInTransaction` and the error
  helpers. `apps/api`'s `PrismaService`/`TransactionRunner` become thin Nest wrappers around it, and the worker
  uses the factory directly. Add the package to `IMPORTABLE_WORKSPACE_PACKAGES` in `eslint.config.mjs`.
  This is deliberately **not** done now: with one consumer it would be an abstraction without a user (ADR-0003 decision 1).
- Workers must not depend on API application code. Domain logic both need belongs in a package (or the worker re-implements
  its small slice); the API's repositories stay in the API.

## 5. API standards

| Topic             | Convention                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Versioning**    | All routes under `/api/v1`. A breaking change means a new prefix (`/api/v2`) served alongside; additive changes (new optional fields, endpoints) stay in v1. Health: `GET /api/v1/health` (liveness), `GET /api/v1/health/ready` (readiness).                                                                                                            |
| **Validation**    | Every body/query/param goes through a contract schema: `class XDto extends createZodDto(schema) {}`. Failures: `400 validation_error` with `details: [{ path, message }]`. Query parameters use `z.coerce`.                                                                                                                                              |
| **Serialization** | JSON. Dates as ISO-8601 strings, ids as UUID strings, absent optional fields omitted or `null` per the contract. Controllers return contract types built by response mappers; never raw rows/entities.                                                                                                                                                   |
| **Errors**        | Always `{ code, message, details?, correlationId }` (`ApiError`). Exception: readiness returns its own body, with 503, because probes need per-dependency detail.                                                                                                                                                                                        |
| **Correlation**   | `x-correlation-id` is accepted when well-formed (`[A-Za-z0-9._-]{1,128}`), otherwise generated; always returned in the response header and in every error body.                                                                                                                                                                                          |
| **Pagination**    | `GET` collections take `?limit` (1-100, default 20) and `?offset` (default 0) and return `{ items: [...], page: { limit, offset, total } }`. Contracts: `paginationQuerySchema`, `paginatedSchema(item)`. High-volume append-only collections (execution events, audit logs) will need cursor pagination; add it with an ADR when the first one appears. |
| **Sorting**       | `?sort=-createdAt,name` (`-` = descending, comma-separated, first is most significant). Only allowlisted fields: `sortQuerySchema(['createdAt', 'name'] as const, defaultSort)`; other fields are `400`.                                                                                                                                                 |
| **Filtering**     | Flat query parameters named after the contract field: `?status=running&agentId=<uuid>`. Repeat a parameter for "any of" (`?status=a&status=b`). Ranges use `<field>From` / `<field>To` (ISO dates). Define each filter in the endpoint's query schema; unknown parameters are ignored, never passed to the database.                                     |
| **Idempotency**   | Creating endpoints that may be retried by clients accept an `Idempotency-Key` header (introduced with the first such endpoint).                                                                                                                                                                                                                          |

### HTTP status conventions

| Status | When                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------- |
| `200`  | Successful read or update that returns a body                                                  |
| `201`  | A resource was created (body = the resource)                                                   |
| `202`  | Accepted for asynchronous processing (body = a handle to poll or stream)                       |
| `204`  | Success with no body (delete)                                                                  |
| `400`  | Malformed or invalid input (`validation_error`)                                                |
| `401`  | Caller not authenticated                                                                       |
| `403`  | Authenticated but not allowed. Prefer `404` when revealing existence would leak information    |
| `404`  | Resource does not exist (or must not be revealed)                                              |
| `409`  | Conflict with current state (duplicate unique value, concurrent modification)                  |
| `422`  | Well-formed input rejected by a business rule                                                  |
| `429`  | Rate limited                                                                                   |
| `500`  | Unexpected failure (bug)                                                                       |
| `503`  | A required dependency is unavailable; retrying may succeed (`database_unavailable`, readiness) |

### OpenAPI conventions

The document at `/api/openapi.json` (Swagger UI at `/api/docs`) is generated from the contract schemas, never written by hand:

```ts
@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  @Get()
  @ApiOperation({ summary: 'List agents' })
  @ApiZodQuery(listAgentsQuerySchema)                       // limit, offset, sort, filters
  @ApiZodResponse(200, paginatedSchema(agentSchema))
  @ApiStandardErrors(400)
  list(@Query() query: ListAgentsQueryDto) { ... }

  @Post()
  @ApiZodBody(createAgentRequestSchema)
  @ApiZodResponse(201, agentSchema)
  @ApiStandardErrors(400, 409, 422)
  create(@Body() body: CreateAgentDto) { ... }
}
```

One `@ApiTags` per controller (the domain name), a one-line `@ApiOperation` summary, every success schema documented with
`ApiZodResponse`, and every documented error status listed with `ApiStandardErrors`. Unexpected `500`s are implied. A
runnable reference is `apps/api/test/conventions.e2e.spec.ts`.

## 6. Request context and logging

**Request context.** `common/request-context.ts` keeps a small `AsyncLocalStorage` store (`{ correlationId }`) opened by
`RequestContextModule` for every request. Anywhere in the call chain (services, repositories, log statements):

```ts
import { currentCorrelationId } from '../../common/request-context';
```

It follows `await`, timers and `Promise.all`, never leaks between concurrent requests, and survives body parsing; all
three are tested. It is registered as Nest module middleware (after the body parser) on purpose: registering it with
`app.use()` before the parser can lose the store. **Keep it tiny**: it carries ids for correlation, not business state. When a
future phase adds identity, add `userId`/`organizationId` here (and to the log mixin) rather than creating another store.
Outside a request (startup, shutdown, background work) `currentCorrelationId()` is `undefined`.

**Logging.** JSON via pino/nestjs-pino. Use Nest's `Logger` (`private readonly logger = new Logger(MyService.name)`).

| Field                                       | Present on                                                                 | Notes                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `level`, `time`, `service` (`"api"`), `msg` | every line                                                                 |                                                                          |
| `context`                                   | lines from Nest `Logger`                                                   | class name passed to `new Logger(...)`                                   |
| `correlationId`                             | every line written while handling a request, including the completion line | added by an AsyncLocalStorage mixin                                      |
| `req` `{ id, method, path }`                | request-completion line                                                    | `id` equals the correlation id; **no headers, no query string, no body** |
| `res` `{ statusCode }`, `responseTime`      | request-completion line                                                    |                                                                          |

Rules: never log request/response bodies, headers, tokens, passwords, connection strings or full Prisma error messages.
Log identifiers and error classes. Redaction (`authorization`, `cookie`, `set-cookie`, `*.password`, `*.apiKey`, `*.secret`,
`*.token`) is a safety net, not permission. Health probes are not logged. Levels: `error` unexpected failures only;
`warn` expected-but-notable (dependency down, 5xx `AppError`s); `info` lifecycle and request completion; `debug` for
development detail.

## 7. Infrastructure modules: responsibilities and lifecycle

| Module / piece                                               | Owns                                                                         | Startup                                              | Shutdown                                          | Required for readiness |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ---------------------- |
| `config`                                                     | Validated environment (`APP_CONFIG`); fails the process on invalid config    | first                                                | n/a                                               | n/a                    |
| Logging (`common/logging.ts`, `LoggerModule` in `AppModule`) | pino configuration, redaction, correlation mixin                             | with the app                                         | flushed by Nest                                   | n/a                    |
| `database`                                                   | `PrismaService` connection, `TransactionRunner`, Prisma error classification | connects; unreachable DB is logged, **not fatal**    | disconnects once; failures logged, never thrown   | **yes**                |
| `redis`                                                      | `RedisService` connection                                                    | connects; unreachable Redis is logged, **not fatal** | `QUIT` when connected, hard close otherwise; once | **yes**                |
| `health`                                                     | liveness and readiness endpoints                                             | n/a                                                  | n/a                                               | n/a                    |

- Infrastructure modules are **leaves**: they depend on `config` and `common/` only, never on a domain or on each other **[enforced]**.
- Business modules reach infrastructure only through the exported providers (`TransactionRunner`, repositories built on `PrismaService`, `RedisService`).
- **Shutdown** is driven by `app.enableShutdownHooks()`; cleanup is idempotent (the second call returns the first call's promise), so a
  signal followed by a manual `close()` cannot double-close or throw. Tested.
- **Required vs optional.** `health.service.ts` declares every dependency in `DEPENDENCIES` with an explicit `required`
  flag; only required ones can make the API `not_ready`. A new dependency is added there deliberately. Both current
  ones are required (ADR-0003). A dependency the API can work without must be added as `required: false`, so an
  outage is reported but never silently takes the API out of rotation. Liveness never depends on infrastructure.

## 8. Testing strategy

| Level                   | Tooling / file pattern                        | Tests                                                                                                                                                                                  | Real infrastructure? |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Unit**                | `src/**/*.spec.ts` next to the code           | pure functions, domain entities/services, application services with **fake repositories**, mappers, config, lifecycle of infrastructure services with the **driver mocked**            | never                |
| **Application service** | same as unit                                  | one test per use case: rule violated -> the `AppError` code; happy path -> repository called with the right data; transaction boundary (`TransactionRunner` faked to run the callback) | never                |
| **Controller / API**    | `test/*.e2e.spec.ts` using `createTestApp()`  | the real HTTP pipeline (validation, errors, correlation id, OpenAPI) with **stubbed infrastructure** and the service layer faked or real-with-fake-repositories                        | never                |
| **Integration**         | `test/*.int.spec.ts`, `pnpm test:integration` | repositories and transactions against real PostgreSQL; real Redis; readiness against real/unreachable services                                                                         | yes: `pnpm infra:up` |

Conventions:

- **Mock boundaries, not internals.** Fake the _port_ (repository interface, `TransactionRunner`, `RedisService`), not
  Prisma or ioredis calls inside a service under test. Mock a driver only when testing the infrastructure service that wraps it.
- **Test database isolation.** Integration tests that need tables create a throwaway database with
  `createIsolatedDatabase()` (`test/support/isolated-database.ts`), use it, and drop it. They never write to the development
  database. Redis tests use logical DB 15 and an `it:` key prefix and clean up. Unit and e2e tests use URLs pointing at a
  closed port, so they cannot reach any real service by accident. No test depends on production or seed data.
- **Fixtures.** Build data with small factory functions next to the test (`makeAgent({ ... })` returning valid defaults
  with overrides), not shared JSON blobs. Generate unique ids/names per test (`crypto.randomUUID()`).
- **Controller tests** use `createTestApp({ controllers, providers })` (real `AppModule` + stubbed infrastructure + test-only
  controllers). **Assert behavior at the HTTP boundary**: status, body shape parsed with the contract schema, correlation id.
- **Every use case** gets: success, each `AppError` branch, and (if it uses a transaction) a rollback case in an integration test.
- Reference implementations: `test/conventions.e2e.spec.ts` (controller + application service + errors + pagination + request
  context + OpenAPI, using a non-business number range), `src/modules/health/health.service.spec.ts` (application service
  with faked ports), `src/modules/redis/redis.service.spec.ts` (driver mocked), `test/database.int.spec.ts` (real transactions in
  an isolated database).

## 9. How to add a new backend domain module

1. **Decide the shape** (flat or layered, section 1) and write down the module's data ownership. If it changes a decision in this
   document or the specification, write an ADR first.
2. **Contracts first.** Add Zod schemas for requests/responses to `packages/contracts/src/<domain>.ts` and export them from the
   package index. No Prisma types, no NestJS.
3. **Schema.** Add `apps/api/prisma/schema/<domain>.prisma`; run `pnpm db:migrate --name <domain>_initial`; commit the migration.
4. **Create `modules/<domain>/`** with only the folders you need and an `index.ts` that exports the module and its public application
   services. Domain layer first (pure, with unit tests), then application services (fake repositories), then the Prisma repository
   (integration test in an isolated database), then the controller (e2e test with `createTestApp`).
5. **Wire it**: import `<Domain>Module` in `AppModule.imports`. Import `DatabaseModule` in your module if repositories need Prisma.
   Do not register global providers.
6. **Import other modules only through their `index.ts`.** Run `pnpm lint` (includes the module-boundary and cycle check).
7. **Document the API** with `ApiTags`, `ApiZodQuery/Body/Response` and `ApiStandardErrors`.
8. **Run `pnpm verify` and `pnpm test:integration`**, update `docs/` if you added a convention.

Checklist for reviewers: thin controllers; transactions owned by application services; no Prisma outside `infrastructure/`; `AppError`
for expected failures; contract types at the HTTP boundary; tests at the right level; docs updated.

## 10. Known limitations

- The layer rules and the module-boundary script have been verified with planted violations and fixtures, but **no domain module exists yet**; the
  first one will be the first real test of these conventions, and rules may need refinement. Expect an ADR amendment then.
- Whether a repository only touches its own domain's tables, and whether a domain imports only `common/errors` from `common/`, is **review-enforced**, not lint-enforced.
- Offset pagination only (see section 5). Idempotency keys are specified but not implemented.
- `DatabaseClient` is an alias of Prisma's transaction client: application services can _see_ the model delegates on it. They are forbidden
  to import Prisma or `PrismaService`, and conventions say they only pass the handle to repositories, but the type system alone does not prevent misuse.
- The request context contains only the correlation id until identity exists.
- Transaction retry on write conflicts is a documented option (`isTransactionConflict`), not a built-in behavior.
- A Prisma interactive-transaction timeout surfaces as a generic `500` (it indicates a defect or overload, not an outage).
