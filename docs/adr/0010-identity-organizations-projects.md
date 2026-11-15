# ADR-0010: Identity, organizations and projects (first domain slice)

**Status:** Proposed, revision 2 (refined after the first architectural review; awaiting the final review; no implementation has started)
**Context:** The foundation (Phases 1.1-1.6) is merged: API, web app, worker, contracts, queue, Compose stack, system tests and CI.
No domain entity exists yet. The specification ([§5.1, §5.2, §6.1, §6.2, §6.4, §7.3, §12.1, §12.2, §12.6, §18](../architecture/technical-architecture-specification.md))
makes Identity, Organizations and Projects the first domain phase, and steps 1-2 of the MVP scenario (§19: "user creates an
organization", "user creates a project") depend on it. Every later domain is scoped by organization and project, so the tenancy and
authorization decisions made here are the hardest to change afterwards. This is also the first real test of the conventions in
[backend.md](../architecture/backend.md), whose ADR-0004 expects amendments ("the conventions are unproven against a real domain").

## Decisions already approved (review of revision 1)

1. Local email/password authentication with PostgreSQL-backed opaque server-side sessions.
2. Node.js `crypto.scrypt` for password hashing.
3. Registration closed by default after the initial instance bootstrap.
4. OIDC deferred behind a provider-independent `Principal` abstraction.
5. Four initial organization roles: owner, admin, member, viewer.
6. Deny-by-default authorization.
7. 404 for cross-organization resource access.
8. Application-enforced tenancy first; PostgreSQL RLS deferred.
9. A minimal transactional, append-only audit capability in Phase 2.

This revision refines how they are realized. It does not reopen them.

## Scope

**In scope:** users, local authentication, sessions, organizations, memberships, the four roles and their permissions, projects,
project members, an authorization boundary other modules will use, the audit capability, the API of §7.3 plus authentication
endpoints, and a web slice (sign in, organization and project selection, create and list projects).

**Out of scope (later phases):** OIDC and external identity providers, invitations, password reset, email verification and any email
delivery, MFA, SSO/SAML, API keys and service accounts, custom roles, per-agent and per-tool permissions, policy-based authorization,
PostgreSQL Row Level Security, billing, any agent/model/MCP entity, and any new worker job.

## Decisions

### 1. Domain boundaries and modules

Four responsibilities, four physical modules. They are small, but each has one owner for its data and one public contract, which is
what the boundary rules need.

| Module          | Owns (tables, in the schema shown)                                          | Public contract (`index.ts`)                                                                                                                      |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit`         | `security.audit_log`                                                        | `AuditRecorder.record(event, tx)`                                                                                                                 |
| `identity`      | `identity.user`, `identity.credential`, `identity.session` (authentication) | `Principal`, `@CurrentPrincipal()`, `@Public()`, `UserDirectory` (find a user by id/email, as a `UserSummary`)                                    |
| `organizations` | `identity.organization`, `identity.membership` (tenancy and authorization)  | `TenantAccess.resolve(principal, organizationId)` → `TenantContext`, `AuthorizationService.authorize(context, permission)`, `MembershipDirectory` |
| `projects`      | `projects.project`, `projects.project_member`                               | none yet. `ProjectAccess` (resolve a project for a principal) is added when the first consumer (Agent Runtime) exists                             |

Dependency direction (an arrow is "imports through the other module's `index.ts`"):

```text
projects      ──►  organizations, identity (Principal only), audit
organizations ──►  identity, audit
identity      ──►  audit
audit         ──►  (infrastructure modules and contracts only)
```

All of them also use the infrastructure leaves they need (`database`, and `redis`/`config` for `identity`). No module depends on
`projects`; `identity` depends on neither `organizations` nor `projects`; `audit` imports no domain module. `tools/check-module-boundaries.mjs` already rejects cycles. Consequences worth stating: `GET /me` returns the user only
(the organizations a user belongs to come from `GET /organizations`), and registration creates a user only (the first organization
is created through the normal `POST /organizations`), precisely so that `identity` never needs `organizations`.

**Where the lines are drawn**

- **Identity & Access** is split into _who you are_ (`identity`: credentials, sessions, `Principal`) and _what you may do inside an
  organization_ (`organizations`: membership, roles, authorization). `identity` knows nothing about organizations.
- **Organizations** own the tenant: the organization, its members and their roles, and the single authorization boundary.
- **Projects** own projects and project membership. A project member must already be a member of the project's organization; that
  rule lives in `projects` (it asks `MembershipDirectory`).
- **Audit** is a leaf: it records and never decides. It does not import any domain; events are typed in
  `packages/contracts` so no domain type leaks into it.
- Prisma models never cross a module boundary. Each repository touches only the models its module owns; modules exchange ids,
  `UserSummary`-style plain types and contract types. A repository does not `include` a relation owned by another module.

**Layout and layers.** `identity`, `organizations` and `projects` are layered (they have real invariants); `audit` is flat. Two
facts about the existing lint rules shape where code goes: the domain layer may not import `modules/database` at all, while the
application layer may (it must not use `PrismaService`). So **repository ports that carry a transaction handle
(`db: DatabaseClient`) live in `application/`**, not `domain/`; the domain keeps entities, value objects and pure policies
(for example the last-owner rule). Infrastructure implements the ports. This clarifies a point backend.md leaves open; it is recorded
as an amendment to apply when step 2.1 proves it.

### 2. Authentication and sessions

- **One session model for every client.** A session is a row in `identity.session`. Its token is 32 bytes from
  `crypto.randomBytes`, URL-safe encoded (256 bits). Only the **SHA-256 of the token** is stored (a fast hash is correct here: the
  token is high-entropy, unlike a password). The raw token exists in the response that creates it and in the client; never in the
  database, logs or audit records.
- **Two carriers, not two models.** `POST /auth/login` takes `delivery: "cookie" | "token"` (default `"cookie"`). With `cookie`
  the token is set as a cookie; with `token` it is returned once in the body and no cookie is set. The same session row, expiry,
  revocation and rotation rules apply to both. A request that presents **both** a cookie and a bearer token is rejected (401), so
  one request is authenticated by exactly one carrier.
- **Cookie.** Name `agentos_session`; when the configured public origin is `https`, the name is `__Host-agentos_session` with
  `Secure`, `Path=/` and no `Domain`. Always `HttpOnly` and `SameSite=Lax`. `Secure` follows the **configured** `WEB_ORIGIN`
  scheme, never what the request looks like, so a TLS-terminating proxy cannot silently turn it off. Startup validation refuses an
  `http` origin unless its host is loopback (or `AUTH_ALLOW_INSECURE_ORIGIN=true`, for the Compose test stack and nothing else). The
  cookie `Max-Age` is the remaining absolute lifetime; the server enforces expiry itself and never trusts the cookie's.
- **CSRF.** `SameSite=Lax` is the first layer. Second: any unsafe method (POST, PUT, PATCH, DELETE) authenticated by a **cookie**
  must carry an `Origin` header (or, absent that, `Sec-Fetch-Site: same-origin`) equal to `WEB_ORIGIN`, otherwise 403; and the body
  must be JSON (a non-simple request). Bearer-authenticated requests are not CSRF-exposed and skip the check. The login endpoint
  applies the origin check whenever an `Origin` header is present (login CSRF). No CORS is enabled: the browser uses the same-origin
  proxy of the Compose stack and of the Vite dev server.
- **Lifetime.** Two limits, both stored on the row: an idle expiry (default 24 h, slid forward on use, written at most once a
  minute) and an absolute expiry (default 14 days). Defaults are configuration (`SESSION_IDLE_TTL_MINUTES`,
  `SESSION_ABSOLUTE_TTL_HOURS`); the rest of the policy is code.
- **Revocation.** `POST /auth/logout` revokes the current session; `POST /auth/logout-all` revokes every session of the user. A
  revoked or expired session is indistinguishable from an unknown token (401).
- **Rotation.** A new token is issued at every login (there is no pre-authentication session, so there is nothing to fixate), and
  on password change (decision 3). There is **no periodic rotation** in Phase 2: parallel requests carrying the old token would race
  the rotation, and the benefit is small given `HttpOnly`, hashed storage, idle expiry and revocation. Revisit with a grace window if
  a reason appears.
- **Invalidation after security-sensitive changes.** Password change revokes every other session of that user and rotates the
  current one. Disabling a user (`status = disabled`) revokes all their sessions in the same transaction, and every session
  resolution re-checks `status`. Role changes and removal from an organization need no session action: authorization is evaluated
  from the database on every request and no role or permission is cached in the session. (A future email or MFA change must revoke
  sessions too; it is listed so it is not forgotten.)
- **Rate limiting (Redis counters, ephemeral by design).** Counters are keyed by a hash of the normalized email and by client
  address, never by raw values. Failed sign-ins: per account (counted even for emails that do not exist, so the limiter itself does
  not reveal which accounts exist) and per address; registration and password change have their own limits. Over a limit the
  answer is `429` with `Retry-After` and one generic message. Numbers live in code (like the queue retry policy), not in the
  environment. If Redis is unavailable, sign-in and registration **fail closed** (`503`, generic): they are the abuse surface, and
  session resolution does not use Redis, so existing sessions keep working. Client address comes from `req.ip` with Express
  `trust proxy` set from configuration (`TRUST_PROXY_HOPS`, default 0), because behind nginx the socket address is the proxy.
- **Generic failures.** Unknown email, wrong password and disabled account produce the same status, code, message and (by the dummy
  verification in decision 3) comparable timing. A different, specific error appears only after authentication succeeds.
- **Bootstrap and registration.** `POST /auth/register` is allowed when no user exists yet (instance bootstrap, serialized with a
  transaction-level advisory lock so two simultaneous first registrations cannot both win) or when `AUTH_ALLOW_REGISTRATION=true`;
  otherwise `403 registration_closed`. Registration creates a user and nothing else.
- **`Principal`** is `{ userId, sessionId }` and is the only thing authentication hands downstream. A later OIDC login produces the
  same `Principal` from a different credential type; nothing downstream changes.

### 3. Password hashing (scrypt)

| Item                  | Value                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm             | `crypto.scrypt` (asynchronous)                                                                                                                                                                                                                                                                                                                                   |
| Cost                  | N = 2^17 (131072), r = 8, p = 1: the first OWASP-listed scrypt configuration, 128 MiB of memory per hash                                                                                                                                                                                                                                                         |
| Output length         | 32 bytes                                                                                                                                                                                                                                                                                                                                                         |
| Salt                  | 16 random bytes per password (`crypto.randomBytes`), never reused, never derived from user data                                                                                                                                                                                                                                                                  |
| `maxmem`              | Set explicitly to 256 MiB. Verified: Node's default (32 MiB) rejects N = 2^17 with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`                                                                                                                                                                                                                                            |
| Input                 | NFKC-normalized, then UTF-8. Minimum 12 characters, maximum 1024 bytes (bounds the work an attacker can force), no composition rules                                                                                                                                                                                                                             |
| Stored representation | One versioned string, `$scrypt$v=1$ln=17,r=8,p=1,len=32$<salt>$<hash>` (unpadded base64url), so cost and algorithm travel with the hash                                                                                                                                                                                                                          |
| Comparison            | `crypto.timingSafeEqual` over equal-length buffers, after re-deriving with the **stored** parameters                                                                                                                                                                                                                                                             |
| Upgrade               | Parameters live in code as policy version 1. After a successful sign-in, if the stored version or any parameter differs from the current policy, the hash is recomputed from the just-verified password and updated in the same transaction as the new session. Never downgraded. An unknown version fails the sign-in and logs an error naming the version only |
| Unknown accounts      | A verification against a precomputed dummy hash runs for unknown or disabled accounts so timing does not reveal them                                                                                                                                                                                                                                             |

Measured on the development machine (Node 22.14, Windows): about 265 ms per hash at N = 2^17 (about 253 ms for the equivalent
N = 2^16, r = 8, p = 2 at 64 MiB); six concurrent hashes took about 590 ms in total, because libuv's four-thread pool runs four at a
time. So the operational cost is memory and thread-pool occupancy, not latency: up to 4 x 128 MiB transiently. Mitigation: a
per-process semaphore limits concurrent hashing to 2 (peak about 256 MiB), excess requests wait briefly then receive `503`, and the
rate limiter runs **before** hashing. Containers running the API need memory headroom for this (documented in docker-compose.md at
implementation time). No pepper is used: it needs secret management that does not exist yet (recorded as a limitation).

**Secrets never reach logs or audit.** Request bodies are never logged. The shared logger already redacts
`req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]` and one-level `*.password`, `*.token`, `*.secret`,
`*.apiKey`; the pino wildcard `*.x` matches **one level only**, so this phase adds `*.currentPassword`, `*.newPassword`,
`*.passwordHash`, `*.sessionToken` and `*.credential` in `packages/logger`. Audit records cannot contain secrets by construction:
event metadata is a typed, validated schema per action (decision 6) with only ids and enums. Two tests are mandatory: capture the
logs of a complete sign-in/registration/password-change flow with known passwords and tokens and assert none appears; dump the audit
table after the same flow and assert the same.

**Future capabilities (out of scope, with the limits they leave).**

- _Password reset_ needs email delivery, single-use expiring reset tokens and rate limits. Until it exists a forgotten password
  can only be recovered by an operator (there is no recovery CLI yet either), so a single-owner instance can lose access.
- _Email verification_ needs the same delivery. Until then the email is an **unverified identifier**: it must not be used to
  auto-join organizations by domain, to deliver anything sensitive, or as proof of identity; any later invitation feature must bind
  to a verified address.
- Without either, accounts on a public instance cannot be self-recovered; this is why registration is closed by default.

### 4. Tenant isolation (mandatory rules)

1. **Organization context comes from the authenticated `Principal` and a membership validated against the database, on every
   request.** A client-supplied `organizationId` (body, query or path) is only a _selector_: `TenantAccess.resolve(principal,
organizationId)` accepts it only if the principal is a member, and yields a `TenantContext { organizationId, userId, role }`.
   A non-member gets `404`, the same as a nonexistent organization. Nothing downstream authorizes from the raw id.
2. **Every organization-scoped repository method requires an explicit `OrganizationScope`** (an opaque value produced from a
   `TenantContext`, a non-optional first parameter). The method builds its `WHERE` from it. A missing, empty or malformed scope
   **throws** (an internal error) before any query runs: the system fails closed, never "returns everything".
3. **Resources addressed by id alone** (`/projects/:projectId`): the lookup is `WHERE id = $1 AND organization_id IN (the
principal's organizations)` in one query; no row means `404` whether the project does not exist or belongs to someone else. The
   organization found on the row is then resolved through `TenantAccess` for the role check.
4. **Mandatory tests:** (a) every organization-scoped route is exercised as a member of another organization, as a non-member and
   unauthenticated, and must answer 404/404/401 with no data; (b) each repository rejects an absent or malformed scope without
   issuing a query; (c) a route-metadata test enumerates every controller route and fails if a route is neither `@Public()` nor
   declares a required permission (deny by default is also checked, not only intended); (d) concurrent and repeated creations
   cannot collide across organizations (slug uniqueness is per organization).
5. **RLS readiness (not RLS).** Every tenant statement already filters by `organization_id` (also what an index wants); no raw
   SQL outside repositories; all access goes through `DatabaseClient`, so a later change can set the tenant context
   (`SET LOCAL` inside the transaction `TransactionRunner` opens) in one place. Two obstacles are recorded, not solved now: Prisma's
   pool does not pin statements outside a transaction to one connection, so tenant reads would need a scoped-transaction helper; and
   the development database role is a PostgreSQL superuser, which bypasses RLS entirely, so RLS cannot be tested until the API
   connects with a restricted role.

### 5. Authorization

- **The permission catalog is code**, defined once in `packages/contracts/src/permissions.ts` (`PermissionKey`, a description, and the
  roles that hold it). `contracts` is the one place both the API and the web may read; the API remains authoritative and the web
  only uses it to hide controls. A domain adds its permissions there as part of "contracts first".
- **Roles are code too, in Phase 2.** The four organization roles and their permission sets are constants; membership stores the role
  as an enum value. There is no `permission` or `role_permission` table and no per-organization role rows: nothing could edit
  them, so they would only be ceremony. Custom roles (the spec's `Role`/`Permission`/`RolePermission` entities) arrive with the
  phase that needs them and add tables then. **System roles cannot be modified or deleted at runtime because they are not data**;
  changing the matrix is a code review plus deployment, visible in git.
- **Matrix** (initial; `R` = read, listed once per permission):

  | Permission                                 | owner | admin | member | viewer |
  | ------------------------------------------ | :---: | :---: | :----: | :----: |
  | `organization.read`, `member.read`         |  yes  |  yes  |  yes   |  yes   |
  | `organization.update`, `member.manage`     |  yes  |  yes  |   no   |   no   |
  | Grant or revoke `owner` (ownership change) |  yes  |  no   |   no   |   no   |
  | `project.create`                           |  yes  |  yes  |  yes   |   no   |
  | Every project permission, on every project |  yes  |  yes  |   no   |   no   |

  Project-level roles (`project_admin`, `project_member`, `project_viewer` on `project_member`) grant, **only on that project**:
  viewer: `project.read`; member: `project.read`; admin: `project.read`, `project.update`, `project.archive`,
  `project.member.manage`. An organization `member` or `viewer` has **no access to a project they are not a member of**
  (least privilege). The creator of a project becomes its `project_admin`. The effective permission set on a project is the
  union of the organization role's and the project role's grants.

- **`AuthorizationService` is a policy execution boundary, not a business-logic service.** It evaluates "does this `TenantContext`
  (plus an optional project role) hold this permission" against the code-owned matrix and either returns or throws. It contains no
  rule about _how_ a domain object may change. Those stay in the owning domain: the last-owner invariant is an organizations
  domain policy, "the project member must belong to the organization" and project-role rules are projects domain policies.
  Failure semantics: not a member of the organization = `404` (decision 4); a member lacking the permission = `403 forbidden`.
- **Last-owner protection.** An organization always has at least one `owner`. Removing an owner, or changing an owner's role, is
  rejected if it would leave none. Because two concurrent demotions could each see "another owner exists", the check runs inside
  the transaction after locking the organization's owner memberships (`SELECT ... FOR UPDATE`, in the repository); a test runs the
  race. A user may leave an organization only if they are not its last owner.
- **Declared on every route.** Controllers state `@RequirePermission(...)` (or `@Public()`); the authentication guard is registered as a
  global `APP_GUARD` in the **composition root** (`AppModule`, which already registers the global pipe and filters), so a route
  nobody annotated is authenticated-only and the metadata test (decision 4.4c) flags it. Domain modules still register no global
  provider.

### 6. Audit

- **Shape.** `security.audit_log`: `id`, `occurred_at` (UTC), `actor_user_id` (nullable), `organization_id` (nullable: sign-in events
  have none), `project_id` (nullable), `action`, `resource_type`, `resource_id`, `result` (`success`/`failure`), `correlation_id`
  (from `currentCorrelationId()`), `metadata` (jsonb). **No foreign keys:** a history must outlive and never block what it
  describes, and this keeps `audit` a leaf. Indexed by (`organization_id`, `occurred_at`) and by `action`.
- **Typed events, no free-form payload.** `packages/contracts/src/audit.ts` lists every action with a strict zod schema for its
  `metadata` (ids, enum values, changed-field _names_; never user-entered text, credentials or tokens). `record()` accepts only a
  valid event. This is what makes decision 3's "no secrets in audit" structural.
- **Atomic with the operation.** `AuditRecorder.record(event, tx)` takes the transaction handle; the application service opens the
  transaction (`TransactionRunner`) and passes `tx` to both the change and the audit append. If the append fails, the change rolls
  back. Events that record a **refusal** rather than a state change (a failed sign-in, a throttle) have no business transaction;
  they are written in their own short transaction and a failure to write them is logged at error level without changing the response.
- **Append-only, in three layers.** (1) The repository exposes `append` and nothing that updates or deletes; (2) no HTTP endpoint writes
  or deletes audit records (and none reads them in Phase 2, see open question 5); (3) a database trigger raises on `UPDATE` and
  `DELETE` of the table, shipped in the migration as hand-written SQL. Verified in a probe on Prisma 6.19.3: the trigger fires for
  Prisma `updateMany`, `migrate dev` reports no drift with it present, and the fresh-database `migrate deploy` path applies it. It
  is defense in depth, not a security boundary (a superuser can drop it); the boundary is a restricted production role, a later
  hardening item. Retention or purging will need its own privileged, audited path and is out of scope.
- **Actions covered** (the catalog; more are added with their domain):

  | Area            | Actions                                                                                                                                                                       |
  | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Authentication  | `auth.registered`, `auth.login_succeeded`, `auth.login_failed`, `auth.login_throttled`, `auth.logout`, `auth.logout_all`, `auth.password_changed`, `session.revoked` (reason) |
  | Organizations   | `organization.created`, `organization.updated`                                                                                                                                |
  | Membership      | `membership.added`, `membership.removed`, `membership.role_changed`                                                                                                           |
  | Ownership       | `organization.owner_granted`, `organization.owner_revoked` (emitted in addition to `membership.role_changed` whenever `owner` is involved)                                    |
  | Projects        | `project.created`, `project.updated`, `project.archived`, `project.restored` (see open question 1 on "deletion")                                                              |
  | Project members | `project_member.added`, `project_member.removed`, `project_member.role_changed`                                                                                               |

  Role and permission _definitions_ are code (decision 5), so the runtime event is the role **assignment** (`membership.role_changed`,
  `project_member.role_changed`). `auth.login_failed` is recorded only for **existing** accounts; failures for unknown emails
  are counted in Redis and logged at `warn` but not stored, so an attacker cannot grow the table with invented addresses; the
  per-account limiter bounds the rest. Audit retention is unbounded in Phase 2 and recorded as a limitation.

- **Not building:** search, export, streaming, tamper-evident hashing chains, a configuration UI. This is one table, one recorder, one
  trigger.

### 7. Prisma and the database (verified against the repository)

The proposal in revision 1 (per-domain Prisma files, `multiSchema`) was checked on the exact toolchain (Prisma and
`@prisma/client` 6.19.3, `prisma.config.ts` with `schema: prisma/schema`, the repository's PostgreSQL 17 image, Node 22.14,
Windows) using a throwaway copy outside the repository and a throwaway database that was dropped afterwards. **Repository state was
not changed by the probe.**

| Question                        | Finding                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is `multiSchema` available?     | Yes, without any `previewFeatures` entry in 6.19.3 (verified: the schema validates and migrates with none). The `datasource` block gains `schemas = ["identity", "projects", "security"]`; every model **and enum** needs `@@schema("...")`. `prisma validate` passes. A model name must be unique across all schemas.                        |
| Folder-based multi-file schema  | Works unchanged with the existing `prisma.config.ts`. Only `base.prisma` (which holds the datasource) changes, in step 2.1.                                                                                                                                                                                                                   |
| Migrations                      | One history in `apps/api/prisma/migrations`; the first migration emits `CREATE SCHEMA IF NOT EXISTS` for each schema, so no manual DDL. `_prisma_migrations` lives in `public`, not in a domain schema. `migrate deploy` on a fresh database applies everything.                                                                              |
| Cross-schema foreign keys       | Generated and enforced (`projects.project.organization_id` → `identity.organization.id`); relation fields work across files.                                                                                                                                                                                                                  |
| Generated client                | **One** client for all schemas; one interactive `$transaction` created rows in `identity`, `projects` and the audit table and read them back with a cross-schema `include`. `TransactionRunner` and `DatabaseClient` need no change. A client per domain has no demonstrated need and is rejected.                                            |
| Hand-written SQL in a migration | A trigger in its own migration coexists with Prisma: `migrate dev` reports "already in sync", `migrate status` is up to date.                                                                                                                                                                                                                 |
| Composite uniqueness            | `@@unique([organizationId, slug])` yields error `P2002`, which the existing `isUniqueConstraintViolation` already recognizes.                                                                                                                                                                                                                 |
| Existing test helper            | A fresh, empty database plus `prisma migrate deploy` produced the complete schema (verified in the probe, which created its databases by hand). `createIsolatedDatabase` itself was not exercised with it. Phase 2 integration tests need a small helper that runs the deploy against an isolated database (step 2.1); it does not exist yet. |
| Not changed by this             | `db:validate` in CI, `db:generate`, the Compose `migrate` service and `check:env`.                                                                                                                                                                                                                                                            |
| Caveats                         | The CLI prints an "update available (8.0.0-rc)" banner: not acted on, Prisma stays pinned. Raw SQL must schema-qualify names. `CREATE SCHEMA` needs the `CREATE` privilege on the database for the role that runs migrations (the development superuser has it; production needs it granted to the migrate role).                             |

**Ownership.**

- **Schema files** (one per module, as `base.prisma` already announces): `identity.prisma` (user, credential, session), `organizations.prisma`
  (organization, membership; `@@schema("identity")`), `projects.prisma` (`@@schema("projects")`), `audit.prisma`
  (`@@schema("security")`, where the spec's §6.1 places the audit table). Two modules share the `identity` PostgreSQL schema but never
  a table; ownership is by table.
- **Migrations:** one history owned by the repository. Each step adds its schema file and one migration named `<domain>_<change>`;
  a module's migration creates only its own tables; applied migrations are never edited (existing rule).
- **Generated client:** one `@prisma/client`, generated by `db:generate` from the whole folder, imported only in `modules/database`
  and in a domain's `infrastructure/` layer (existing ADR-0004 rule). Other modules never see its model types.
- **Cross-domain foreign keys:** allowed only **from the downstream module to the upstream one**, i.e. in the direction of the module
  dependency (`projects` → `organizations` → `identity`), never the reverse; always `ON DELETE RESTRICT` (no cross-domain cascades);
  `audit` has none. A foreign key is the database mirror of an `import`.
- **Transaction boundaries:** unchanged from backend.md: the application service opens the transaction with `TransactionRunner` and
  passes `tx`; one transaction may span schemas and modules (that is how the audit append and the change commit together). The
  hand-offs between modules pass `tx` explicitly; no module opens a nested transaction.
- **Schema ownership:** a PostgreSQL schema belongs to its **domain**, a table to its **module**. Conventions: UUID primary keys,
  `timestamptz` in UTC, explicit foreign keys, business uniqueness as database constraints.

### 8. API

All under `/api/v1`, documented with the existing zod-to-OpenAPI helpers, errors in the `ApiError` shape, lists with
`paginationQuerySchema`/`paginatedSchema`.

```http
POST   /auth/register     POST /auth/login     POST /auth/logout     POST /auth/logout-all
GET    /me                POST /me/password
GET    /organizations     POST /organizations  GET|PATCH /organizations/:organizationId
GET    /organizations/:organizationId/members        POST .../members (existing user, by email)
PATCH|DELETE /organizations/:organizationId/members/:userId
GET    /projects?organizationId=      POST /projects (organizationId in the body)
GET|PATCH /projects/:projectId        POST /projects/:projectId/archive   POST /projects/:projectId/restore
GET    /projects/:projectId/members   POST /projects/:projectId/members   PATCH|DELETE .../members/:userId
```

`/projects` keeps the paths of spec §7.3 and carries the organization as an explicit selector, validated per decision 4.1.
Secrets are never in a response other than the single sign-in response (token delivery) and the password-change response; an email
address is returned only to members of a shared organization.

### 9. Contracts, web, configuration, dependencies

- **Contracts first:** `packages/contracts/src/{identity,organizations,projects,permissions,audit}.ts` (zod only, no framework).
- **Web:** `features/auth`, `features/organizations`, `features/projects`, per [frontend.md](../architecture/frontend.md); the active
  organization/project is a browser preference, sent explicitly on every request and never trusted by the server.
- **Configuration** (declared in the config schema, `.env.example` and Compose; `check:env` enforces): `AUTH_ALLOW_REGISTRATION`,
  `AUTH_ALLOW_INSECURE_ORIGIN`, `SESSION_IDLE_TTL_MINUTES`, `SESSION_ABSOLUTE_TTL_HOURS`, `WEB_ORIGIN`, `TRUST_PROXY_HOPS`. No signing key exists because tokens are random and stored
  hashed.
- **Dependencies:** none planned. `crypto.scrypt`, `randomBytes`, `timingSafeEqual`, `createHash` are built in. If cookie parsing needs
  a package it is `cookie`, already in the lockfile through Express, stated in the pull request.

### 10. Delivery in four reviewable steps

| Step | Content                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `base.prisma` `schemas`, `identity.prisma`, `audit.prisma` (+ trigger), contracts, the `audit` and `identity` modules, hashing, sessions, rate limiting, `/auth/*`, `/me`, guard, migration-deploy test helper |
| 2.2  | `organizations`: organizations, memberships, the role matrix, `TenantAccess`, `AuthorizationService`, last-owner invariant, route-metadata test                                                                |
| 2.3  | `projects`: projects, members, project roles, cross-organization isolation test matrix                                                                                                                         |
| 2.4  | Web slice, system-test scenario (register, sign in, create organization and project through the real stack), documentation, ADR finalization                                                                   |

Each step ends with `pnpm verify`, `pnpm test:integration` and, for 2.4, `pnpm test:system`, and is reviewed before the next begins.
Amendments to backend.md (repository ports in `application/`, the request-scoped principal, the global guard in the composition
root, the structured `AuditRecorder` replacing the `record('agent.created', id, tx)` sketch, logger redaction paths) are made in the
step that proves them.

## Consequences

- Later domains get a settled tenant model and one authorization entry point: a new resource is a permission key, a route
  annotation and a scoped repository, not a new access-control design.
- Sessions in PostgreSQL add one indexed read per authenticated request (cacheable in Redis later without changing the contract).
- Local passwords make AgentOS responsible for credential storage until OIDC exists; mitigated by scrypt, rate limiting, generic
  errors, hashing concurrency limits, registration closed by default and the documented seam.
- scrypt at 128 MiB needs memory headroom and limits sign-in throughput (about two concurrent hashes per API process).
- Application-enforced tenancy means a missing scope is a data leak; the mitigation is structural (required `OrganizationScope`,
  fail-closed repositories, the mandatory cross-organization and route-metadata tests), not a promise.
- Code-owned roles make permission changes a deployment, and custom roles a later schema change; in exchange there is no
  permission data to corrupt or to seed per organization.
- The audit table grows without a retention policy until one is designed.

## Alternatives considered

- **JWT access + refresh tokens:** rejected for now; revocation and refresh storage reproduce a session table with more ways to get it
  wrong. Revisit when an external IdP issues tokens.
- **An identity library or service (Keycloak, Auth.js, Passport):** rejected for Phase 2: a heavy dependency or a new service for one
  login form; §12.1 asks to avoid a custom protocol, not a custom form over a standard session.
- **`argon2`/`bcrypt`:** stronger or more familiar, but native addons conflict with pnpm 11's blocked install scripts and add a
  dependency. Parameters are stored per hash, so a later switch is a version bump.
- **Role and permission tables now:** rejected as unused data; see decision 5.
- **One `identity` module for organizations and projects too:** rejected; it would let project code reach membership internals.
- **PostgreSQL RLS as the primary control:** rejected for this phase (decision 4.5).
- **A Prisma client per domain:** rejected: no technical need, and it would split transactions (decision 7).
- **Foreign keys from `audit_log`:** rejected; see decision 6.

## Decisions requiring approval (remaining open questions)

1. **"Project deletion".** The audit requirement lists project creation and deletion; this draft has archive/restore, not deletion.
   Recommendation: archive and restore only (`project.archived`/`project.restored`); hard deletion waits until the first child
   data (agents, executions) forces a retention and cascade design. If review wants deletion now, say so and `project.deleted` is added.
2. **Who may create an organization.** Recommendation: any authenticated user (the registration gate already decides who can exist).
3. **How a second user appears on a closed instance.** With registration closed and no invitations, additional users need an operator
   to enable `AUTH_ALLOW_REGISTRATION`. Recommendation: accept and document this limitation; admin-provisioned accounts and invitations
   are a later phase.
4. **Sign-in when Redis is down.** Recommendation: fail closed (decision 2). The alternative is an in-process limiter fallback.
5. **A read endpoint for the audit log.** Recommendation: not in Phase 2 (verified through integration tests and SQL); the first reader
   is a later phase.
6. **The append-only trigger.** Recommendation: include it (verified in the probe); the alternative is application-level only.
7. **Roles as an enum with a code-owned matrix** (decision 5), deferring the spec's `Role`/`Permission`/`RolePermission` entities.
8. **Project roles** `project_admin`/`project_member`/`project_viewer`, and organization members having no default access to projects
   they do not belong to.
9. The four-step plan and its review gates (decision 10).

## Conflicts with the existing architecture and repository

| Where                                  | Conflict or gap                                                                                                                                                   | Resolution proposed                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Spec §6.2 (conceptual ERD)             | `Role`, `Permission`, `RolePermission` entities.                                                                                                                  | Deferred with custom roles (decision 5, open question 7). §6.3 states the ERD is conceptual.              |
| Spec §6.1 / §6.2                       | The audit table belongs to "Observability & Security"; the logical schema list has `security`.                                                                    | `audit_log` in schema `security`, owned by `audit` (decision 7).                                          |
| Spec §7.3                              | `/projects` has no organization segment.                                                                                                                          | Organization as a validated selector (decision 4.1, 8).                                                   |
| ESLint layer rules                     | The domain layer may not import `modules/database`; the application layer may (not `PrismaService`). A port carrying `db: DatabaseClient` cannot be in `domain/`. | Ports in `application/`; domain stays pure (decision 1). Amend backend.md in step 2.1.                    |
| backend.md checklist                   | "Do not register global providers" (aimed at domain modules); the composition root already registers `APP_PIPE`/`APP_FILTER`.                                     | `APP_GUARD` in `AppModule`; wording clarified in step 2.1.                                                |
| backend.md audit sketch                | `this.audit.record('agent.created', agent.id, tx)` is untyped.                                                                                                    | Structured, typed events (decision 6); update the sketch in step 2.1.                                     |
| `packages/logger`                      | Redaction wildcards match one level only; no `currentPassword`/`newPassword`/`passwordHash`/`sessionToken`.                                                       | Add the paths and a test (decision 3).                                                                    |
| Compose development database role      | PostgreSQL superuser: bypasses RLS and any privilege-based audit protection.                                                                                      | Recorded as a limitation; restricted API role is a later hardening item (decisions 4.5, 6).               |
| `base.prisma`                          | Datasource has no `schemas` list; the comment predicts one file per domain.                                                                                       | `schemas` added in step 2.1; file-per-module layout matches the comment.                                  |
| CLAUDE.md "Redis is cache / ephemeral" | Rate-limit counters.                                                                                                                                              | Compliant: counters are ephemeral and not the source of truth for anything (sessions stay in PostgreSQL). |
| Worker                                 | None: no job and no database access are needed in Phase 2.                                                                                                        | No change.                                                                                                |

## Known limitations (accepted for Phase 2)

No password reset, email verification, MFA, invitations or recovery path (decision 3); no pepper; audit retention unbounded and
unread through the API; RLS absent and untestable with the development superuser; scrypt memory and concurrency cost; one session
token format for browsers and API clients, so an API client that stores its token carelessly bears that risk.
