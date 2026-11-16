# ADR-0010: Identity, organizations and projects (first domain slice)

**Status:** Accepted (revision 3, approved at commit `16d1abe`; implementation proceeds in the steps of decision 10, each needing review and approval before the next)
**Context:** The foundation (Phases 1.1-1.6) is merged: API, web app, worker, contracts, queue, Compose stack, system tests and CI.
No domain entity exists yet. The specification ([§5.1, §5.2, §6.1, §6.2, §6.4, §7.3, §12.1, §12.2, §12.6, §18](../architecture/technical-architecture-specification.md))
makes Identity, Organizations and Projects the first domain phase, and steps 1-2 of the MVP scenario (§19: "user creates an
organization", "user creates a project") depend on it. Every later domain is scoped by organization and project, so the tenancy and
authorization decisions made here are the hardest to change afterwards. This is also the first real test of the conventions in
[backend.md](../architecture/backend.md), whose ADR-0004 expects amendments ("the conventions are unproven against a real domain").

## Approved decisions

**From the review of revision 1** (not reopened):

1. Local email/password authentication with PostgreSQL-backed opaque server-side sessions.
2. Node.js `crypto.scrypt` for password hashing.
3. Registration closed by default after the initial instance bootstrap.
4. OIDC deferred behind a provider-independent `Principal` abstraction.
5. Four initial organization roles: owner, admin, member, viewer.
6. Deny-by-default authorization.
7. 404 for cross-organization resource access.
8. Application-enforced tenancy first; PostgreSQL RLS deferred.
9. A minimal transactional, append-only audit capability in Phase 2.

**From the review of revision 2** (the nine open questions, now final):

| #   | Question                         | Final decision                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Project deletion                 | Archive and restore are supported. **Permanent deletion is deferred** until retention and dependent-data policies are designed. No `DELETE` endpoint and no `project.deleted` action exist in Phase 2.                                                                                                                                                                                                  |
| 2   | Organization creation            | Any authenticated user may create an organization.                                                                                                                                                                                                                                                                                                                                                      |
| 3   | Closed instance, more users      | Registration stays closed by default after bootstrap. With no invitation mechanism, an **instance operator must explicitly enable registration** (`AUTH_ALLOW_REGISTRATION=true`) when another user needs to join. This is a documented operational limitation (decision 2, Known limitations).                                                                                                         |
| 4   | Redis unavailable at sign-in     | **Fail closed** for new sign-in attempts while the required rate limiter is unavailable. PostgreSQL-backed session validation does **not** depend on Redis (decision 2).                                                                                                                                                                                                                                |
| 5   | Audit read API                   | Deferred. The data model and the writer are kept ready for a future authorized reader (decision 6).                                                                                                                                                                                                                                                                                                     |
| 6   | Append-only trigger              | Included in Phase 2. Database superusers and sufficiently privileged schema owners remain outside this protection boundary, which the ADR states (decision 6).                                                                                                                                                                                                                                          |
| 7   | Organization roles               | Code-owned role definitions and a code-owned permission matrix; an **enum** for the supported role values; system roles are never mutable runtime data (decision 5).                                                                                                                                                                                                                                    |
| 8   | Project roles and default access | `project_admin`, `project_member`, `project_viewer`. Organization membership alone gives no project access. Organization `owner` and `admin` have implicit administrative access to every project of their organization; `member` and `viewer` need explicit project membership. Project roles never elevate organization-level privileges. Implemented centrally and tested consistently (decision 5). |
| 9   | Delivery                         | The four-step plan is unchanged. **Each step requires review and approval before the next begins** (decision 10).                                                                                                                                                                                                                                                                                       |

Revisions 2 and 3 refine how these decisions are realized. They do not reopen them.

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
  environment. **If the limiter is unavailable (Redis down), the endpoints that depend on it fail closed** with a generic `503`:
  sign-in, registration and password change (each verifies or sets a credential, so each is a guessing or abuse surface). The
  rationale: a limiter that silently disappears is an attack window. **Nothing else depends on Redis.** Session validation reads
  PostgreSQL only (including the throttled `last_seen_at` write), so a request that carries an existing session, `GET /me`,
  `POST /auth/logout` and `POST /auth/logout-all` keep working during a Redis outage; only _new_ sign-ins stop. Mandatory test:
  with Redis stopped, sign-in answers 503, an already-authenticated request answers 200 and logout succeeds. Client address comes
  from `req.ip` with Express `trust proxy` set from configuration (`TRUST_PROXY_HOPS`, default 0), because behind nginx the socket
  address is the proxy.
- **Generic failures.** Unknown email, wrong password and disabled account produce the same status, code, message and (by the dummy
  verification in decision 3) comparable timing. A different, specific error appears only after authentication succeeds.
- **Bootstrap and registration.** `POST /auth/register` is allowed when no user exists yet (instance bootstrap, serialized with a
  transaction-level advisory lock so two simultaneous first registrations cannot both win) or when `AUTH_ALLOW_REGISTRATION=true`;
  otherwise `403 registration_closed`. Registration creates a user and nothing else. Any authenticated user may then create an
  organization (`POST /organizations`) and becomes its `owner`.
- **Operational limitation: adding a user to a closed instance.** There are no invitations and no operator-created accounts in
  Phase 2. To let another person join, **an instance operator must set `AUTH_ALLOW_REGISTRATION=true` and restart the API** (the
  value is read at startup), let that person register, and set it back. While it is `true`, **anyone who can reach the API can
  create an account**, so it should only be enabled on a trusted network or for the shortest possible time. An existing user can
  then be added to an organization by an owner or admin (`POST /organizations/:id/members`, by email). This is documented in
  environment.md when implemented and recorded under Known limitations.
- **`Principal`** is `{ userId, sessionId }` and is the only thing authentication hands downstream. A later OIDC login produces the
  same `Principal` from a different credential type; nothing downstream changes.

### 3. Password hashing (scrypt)

| Item                  | Value                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm             | `crypto.scrypt` (asynchronous)                                                                                                                                                                                                                                                                                                                                   |
| Cost                  | N = 2^17 (131072), r = 8, p = 1: the first OWASP-listed scrypt configuration, 128 MiB of memory per hash                                                                                                                                                                                                                                                         |
| Output length         | 32 bytes                                                                                                                                                                                                                                                                                                                                                         |
| Salt                  | 16 random bytes per password (`crypto.randomBytes`), never reused, never derived from user data                                                                                                                                                                                                                                                                  |
| `maxmem`              | Set explicitly on every call to 256 MiB: twice the 128 MiB the approved cost needs, so the call has headroom but is still a hard ceiling. It is a limit, not a reservation. Verified: Node's default (32 MiB) rejects N = 2^17 with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, so omitting it breaks sign-in rather than weakening it                                   |
| Input                 | NFKC-normalized, then UTF-8. Minimum 12 characters, maximum 1024 bytes (bounds the work an attacker can force), no composition rules                                                                                                                                                                                                                             |
| Stored representation | One versioned string, `$scrypt$v=1$ln=17,r=8,p=1,len=32$<salt>$<hash>` (unpadded base64url), so cost and algorithm travel with the hash                                                                                                                                                                                                                          |
| Comparison            | `crypto.timingSafeEqual` over equal-length buffers, after re-deriving with the **stored** parameters                                                                                                                                                                                                                                                             |
| Upgrade               | Parameters live in code as policy version 1. After a successful sign-in, if the stored version or any parameter differs from the current policy, the hash is recomputed from the just-verified password and updated in the same transaction as the new session. Never downgraded. An unknown version fails the sign-in and logs an error naming the version only |
| Unknown accounts      | A verification against a precomputed dummy hash runs for unknown or disabled accounts so timing does not reveal them                                                                                                                                                                                                                                             |

Measured on the development machine (Node 22.14, Windows): about 265 ms per hash at N = 2^17 (about 253 ms for the equivalent
N = 2^16, r = 8, p = 2 at 64 MiB); six concurrent hashes took about 590 ms in total, because libuv's four-thread pool runs four at a
time. So the operational cost is memory and thread-pool occupancy, not latency: up to 4 x 128 MiB transiently. Mitigation: a
semaphore limits concurrent hashing to **2 per API process**, excess requests wait briefly then receive `503`, and the rate limiter
runs **before** hashing. No pepper is used: it needs secret management that does not exist yet (recorded as a limitation).

**Resource limits, stated precisely.**

- **The concurrency limit is per API process, not global.** It is an in-process semaphore; there is no distributed lock, because
  coordinating one through Redis would add a dependency to the sign-in path for little gain. With `R` API replicas the worst case is
  `2 x R` hashes running at once, and the aggregate transient memory is **about `R x 256 MiB`** (2 hashes x 128 MiB) on top of each
  process's normal footprint. This is a sizing rule for operators, written into docker-compose.md when the
  stack runs the API: the memory limit of an API container must cover the Node baseline plus 256 MiB for hashing, and capacity
  planning multiplies by the replica count. The Redis rate limiter, by contrast, **is** shared across replicas, so the _rate_ of
  attempts is bounded globally even though the _concurrency_ is bounded per process.
- **Memory pressure is answered by queueing and scaling, never by weaker hashing.** If the host cannot afford 256 MiB per API
  process, the remedies are to reduce `2` (more waiting and `503`s under load) or to add memory or replicas.
- **Parameters read from storage are validated before use.** The cost parameters in a stored hash string are accepted only if they
  lie inside an allowed range (N = 2^14 to 2^18, r = 8, p = 1 to 4, length 32); anything else fails the verification as if the
  password were wrong and logs the version only. Without this, a corrupted or tampered row could make the process allocate
  gigabytes. `maxmem` is the second line of defense.
- **The approved parameters are pinned by a test.** A unit test asserts the current policy equals N = 2^17, r = 8, p = 1, 32-byte
  output, 16-byte salt, `maxmem` 256 MiB and concurrency 2. Changing any value therefore fails CI and needs a deliberate edit with
  review (and an ADR amendment for anything that lowers cost), so the parameters cannot be weakened silently.
- **Upgrade on successful sign-in is unchanged** (table above): only a verified password is rehashed, and only toward the current
  policy, never toward a cheaper one.

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

  Project-level roles (`project_admin`, `project_member`, `project_viewer`, stored on `project_member` as an enum) grant,
  **only on that project**: viewer: `project.read`; member: `project.read`; admin: `project.read`, `project.update`,
  `project.archive`, `project.member.manage`. (`project_member` and `project_viewer` are separate roles now so they can diverge
  when project content exists; today they hold the same permissions.)

- **Project access policy (final decision 8), stated once.**
  1. **Belonging to an organization gives no project access by itself.** An organization `member` or `viewer` can see and use only
     the projects where they have an explicit `project_member` row.
  2. **Organization `owner` and `admin` have implicit administrative access to every project of their organization**, with no
     `project_member` row needed. Demoting them removes that access on the next request (nothing is cached).
  3. **Project roles never elevate organization-level privileges.** A project role contributes only permissions scoped to
     projects, and only on that project; it can never grant `organization.*`, `member.*`, `project.create` or ownership changes.
  4. The effective permission set on a project is the union of what the organization role grants over projects and what the
     project role grants on that project. The creator of a project becomes its `project_admin`.
  5. **Visibility follows access.** A project the caller has no access to is answered with `404` (the same as a project of another
     organization), and is absent from lists. A caller who has access but lacks the permission gets `403 forbidden`.
- **Where that policy lives, so it cannot diverge.** The permission catalog tags every key with its scope (`organization` or
  `project`), and the project role definitions are typed to accept **only project-scoped keys**, so point 3 is a compile-time
  property, not a convention. The evaluation is **one pure function**, `permissionsFor(organizationRole, projectRole | null)`, in the
  `organizations` domain layer behind `AuthorizationService`; no controller, service or repository decides access on its own. The
  `projects` module supplies the caller's project role (it owns that data) and asks the service; it never re-implements the matrix.
  Mandatory tests: (a) a table-driven test over **every** organization role x every project role (and none) x every permission
  against one expected table; (b) a property test that, for every combination, the decision on an organization-scoped permission
  equals the organization role's own decision (a project role never changes it); (c) each project endpoint exercised for owner,
  admin, member with and without membership, viewer with and without membership, and a non-member of the organization.
- **`AuthorizationService` is a policy execution boundary, not a business-logic service.** It evaluates "does this `TenantContext`
  (plus an optional project role) hold this permission" against the code-owned matrix and either returns or throws. It contains no
  rule about _how_ a domain object may change. Those stay in the owning domain: the last-owner invariant is an organizations
  domain policy, "the project member must belong to the organization" and archive/restore rules are projects domain policies.
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
  describes, and this keeps `audit` a leaf. Indexed by (`organization_id`, `occurred_at`, `id`), which is the key a future
  organization-scoped, keyset-paginated reader needs, and by `action`. The reader itself is deferred (final decision 5): when it
  arrives it adds an `audit.read` permission for `owner`/`admin` and a read-only `AuditReader`; nothing in the table or the writer
  has to change, and nothing for it is built or exposed now.
- **Typed events, no free-form payload.** `packages/contracts/src/audit.ts` lists every action with a strict zod schema for its
  `metadata` (ids, enum values, changed-field _names_; never user-entered text, credentials or tokens). `record()` accepts only a
  valid event. This is what makes decision 3's "no secrets in audit" structural.
- **Atomic with the operation.** `AuditRecorder.record(event, tx)` takes the transaction handle; the application service opens the
  transaction (`TransactionRunner`) and passes `tx` to both the change and the audit append. If the append fails, the change rolls
  back. Events that record a **refusal** rather than a state change (a failed sign-in, a throttle) have no business transaction;
  they are written in their own short transaction and a failure to write them is logged at error level without changing the response.
- **Append-only, in four layers** (the first two are application conventions, the last two are enforced by PostgreSQL):
  1. The repository exposes `append` and nothing that updates or deletes.
  2. No HTTP endpoint writes or deletes audit records, and none reads them in Phase 2 (final decision 5).
  3. **Privileges.** The application's database role may `INSERT` (and `SELECT`, for the future reader and for tests) on the audit
     table, and has **no** `UPDATE`, `DELETE`, `TRUNCATE` or `TRIGGER` privilege and does not own the table.
  4. **Trigger.** A `BEFORE UPDATE OR DELETE` row trigger raises an exception, and a statement-level `BEFORE TRUNCATE` trigger does
     the same, both shipped in the migration as hand-written SQL. Verified in a probe on Prisma 6.19.3 for the `UPDATE` trigger: it
     fires for Prisma `updateMany`, `migrate dev` reports no drift with it present, and the fresh-database `migrate deploy` path
     applies it. The `TRUNCATE` trigger was **not** probed and is verified by step 2.1's tests.

  **The actual security boundary, stated plainly.** Layers 3 and 4 hold against ordinary application code, including a bug or an
  injected statement running with the application's credentials. They do **not** hold against a **PostgreSQL superuser** (who can
  drop or disable the trigger, set `session_replication_role = replica` or edit the table) or against the **owner of the table or
  schema** (who can disable triggers, alter or drop the table, and grant privileges). Whoever holds those credentials is outside this
  protection. The protection is therefore only as strong as the separation of credentials described next.

- **Actions covered** (the catalog; more are added with their domain):

  | Area            | Actions                                                                                                                                                                                                                                                                              |
  | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Authentication  | `auth.registered`, `auth.login_succeeded`, `auth.login_failed`, `auth.login_throttled`, `auth.logout`, `auth.logout_all`, `auth.password_changed`, `auth.password_change_failed` (reason; added in step 2.1), `session.revoked` (reason; **not emitted**, see implementation note 8) |
  | Organizations   | `organization.created`, `organization.updated`                                                                                                                                                                                                                                       |
  | Membership      | `membership.added`, `membership.removed`, `membership.role_changed`                                                                                                                                                                                                                  |
  | Ownership       | `organization.owner_granted`, `organization.owner_revoked` (emitted in addition to `membership.role_changed` whenever `owner` is involved)                                                                                                                                           |
  | Projects        | `project.created`, `project.updated`, `project.archived`, `project.restored` (permanent deletion is deferred, final decision 1)                                                                                                                                                      |
  | Project members | `project_member.added`, `project_member.removed`, `project_member.role_changed`                                                                                                                                                                                                      |

  Role and permission _definitions_ are code (decision 5), so the runtime event is the role **assignment** (`membership.role_changed`,
  `project_member.role_changed`). `auth.login_failed` is recorded only for **existing** accounts; failures for unknown emails
  are counted in Redis and logged at `warn` but not stored, so an attacker cannot grow the table with invented addresses; the
  per-account limiter bounds the rest. Audit retention is unbounded in Phase 2 and recorded as a limitation.

- **Not building:** search, export, streaming, tamper-evident hashing chains, a configuration UI. This is one table, one recorder, two
  triggers and a few grants.

**Database credentials and privileges (kept minimal).** The requirements, which describe the production architecture:

1. **The application's database credentials must not be a superuser**, must not hold `CREATEDB`, `CREATEROLE` or `BYPASSRLS`, and
   must not own any schema or table.
2. **Migration privileges are separate from application privileges.** A migration role owns the schemas and tables and is the only
   one used by `prisma migrate deploy` (the `migrate` service or an operator); the API never runs with it.
3. **Ordinary application code cannot alter or disable the audit triggers**: that needs ownership or superuser, which the
   application role lacks (requirement 1).
4. **The audit writer inserts but never updates or deletes**: `INSERT` and `SELECT` only (layer 3 above).

The mechanism is deliberately small, with no privilege-management subsystem: **one `NOLOGIN` privilege role, `agentos_app`**, created
idempotently by the first migration that needs it (guarded by `IF NOT EXISTS`; where the migration role may not create roles, the
operator creates it first). **Each migration grants on its own tables**: `USAGE` on its schema, `SELECT/INSERT/UPDATE/DELETE` on
ordinary tables and `SELECT/INSERT` only on the audit table. The API's real login role, with its password, is provisioned by the
deployment and made a member of `agentos_app`. No role-handling code exists in the application, nothing grants at runtime, and
there are no per-tenant database roles.

**Tested without changing the development stack.** A step 2.1 integration test creates a throwaway login role that is a member of
`agentos_app` in an isolated database, connects as it, and asserts: audit `INSERT`/`SELECT` succeed; `UPDATE`, `DELETE` and
`TRUNCATE` on the audit table are denied; `ALTER TABLE ... DISABLE TRIGGER` is denied; creating a table in any domain schema is
denied; ordinary tables work. (Roles are cluster-wide objects, so the test creates and drops its own login role and leaves
`agentos_app` in place.)

**Known limitation: the development configuration.** The Compose PostgreSQL has one superuser, and both the `api` and `migrate`
services connect with it through the same `DATABASE_URL`. In the development stack and in CI the API therefore runs as a superuser,
the grants and triggers above are **not** exercised end to end, and RLS could not work either. This is a limitation of the
**development configuration, not production architecture**; such a configuration must not be deployed. Splitting the credentials in
Compose (a separate connection setting for `migrate`, a provisioned non-superuser login role for `api`, and the matching changes to
`check:env`, CI and the system tests) is deferred to the production-hardening work unless the review pulls it into Phase 2. Phase 2
ships the grants and their test so that doing the split later is a change of credentials, not a redesign.

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

**Archive and restore replace deletion** (final decision 1). Archiving sets `status = archived` and is reversible; there is no
`DELETE /projects/:projectId`, no `project.deleted` audit action and no cascade. An archived project is left out of default lists
(`status` filter to include it), accepts no updates and no new members, and can only be restored; both transitions need the
`project.archive` permission (project admins and organization owners/admins) and are audited. Permanent deletion needs a retention
policy and a rule for dependent data (agents, executions, usage) that does not exist yet; adding it later is a new decision.

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

Each step ends with `pnpm verify`, `pnpm test:integration` and, for 2.4, `pnpm test:system`. **Each step is reviewed and explicitly
approved before the next one begins** (final decision 9); finishing a step never starts the following one.
Amendments to backend.md (repository ports in `application/`, the request-scoped principal, the global guard in the composition
root, the structured `AuditRecorder` replacing the `record('agent.created', id, tx)` sketch, logger redaction paths) are made in the
step that proves them.

## Consequences

- Later domains get a settled tenant model and one authorization entry point: a new resource is a permission key, a route
  annotation and a scoped repository, not a new access-control design.
- Sessions in PostgreSQL add one indexed read per authenticated request (cacheable in Redis later without changing the contract).
- Local passwords make AgentOS responsible for credential storage until OIDC exists; mitigated by scrypt, rate limiting, generic
  errors, hashing concurrency limits, registration closed by default and the documented seam.
- scrypt at 128 MiB needs memory headroom and limits sign-in throughput: two concurrent hashes **per API process**, so aggregate
  memory is about 256 MiB times the number of replicas (decision 3).
- Sign-in depends on Redis (the rate limiter) and stops during a Redis outage, while existing sessions keep working.
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

## Open questions

None. The nine questions of revision 2 are resolved and recorded under "Approved decisions".

**Points to confirm during implementation** (not open architecture questions; each is verified or reported in the step named):

- The `BEFORE TRUNCATE` trigger and the role-privilege test (decision 6), step 2.1.
- The memory limit of the API container against the 256 MiB hashing budget per replica (decision 3), documented in step 2.1 and
  revisited if the stack is deployed with several replicas.
- Whether the production credential split should be pulled into Phase 2 or stay in the hardening work (decision 6, last
  paragraph). The default in this ADR is to defer it.

## Conflicts with the existing architecture and repository

| Where                                  | Conflict or gap                                                                                                                                                   | Resolution proposed                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec §6.2 (conceptual ERD)             | `Role`, `Permission`, `RolePermission` entities.                                                                                                                  | Deferred with custom roles (decision 5, final decision 7). §6.3 states the ERD is conceptual.                                                                                               |
| Spec §6.1 / §6.2                       | The audit table belongs to "Observability & Security"; the logical schema list has `security`.                                                                    | `audit_log` in schema `security`, owned by `audit` (decision 7).                                                                                                                            |
| Spec §7.3                              | `/projects` has no organization segment.                                                                                                                          | Organization as a validated selector (decision 4.1, 8).                                                                                                                                     |
| ESLint layer rules                     | The domain layer may not import `modules/database`; the application layer may (not `PrismaService`). A port carrying `db: DatabaseClient` cannot be in `domain/`. | Ports in `application/`; domain stays pure (decision 1). Amend backend.md in step 2.1.                                                                                                      |
| backend.md checklist                   | "Do not register global providers" (aimed at domain modules); the composition root already registers `APP_PIPE`/`APP_FILTER`.                                     | `APP_GUARD` in `AppModule`; wording clarified in step 2.1.                                                                                                                                  |
| backend.md audit sketch                | `this.audit.record('agent.created', agent.id, tx)` is untyped.                                                                                                    | Structured, typed events (decision 6); update the sketch in step 2.1.                                                                                                                       |
| `packages/logger`                      | Redaction wildcards match one level only; no `currentPassword`/`newPassword`/`passwordHash`/`sessionToken`.                                                       | Add the paths and a test (decision 3).                                                                                                                                                      |
| Compose development database role      | Single PostgreSQL superuser shared by `api` and `migrate`: bypasses RLS, grants and the audit triggers.                                                           | Recorded as a development-configuration limitation, not production architecture; grants and a role-privilege test ship in 2.1, the Compose credential split is deferred (decisions 4.5, 6). |
| `base.prisma`                          | Datasource has no `schemas` list; the comment predicts one file per domain.                                                                                       | `schemas` added in step 2.1; file-per-module layout matches the comment.                                                                                                                    |
| CLAUDE.md "Redis is cache / ephemeral" | Rate-limit counters.                                                                                                                                              | Compliant: counters are ephemeral and not the source of truth for anything (sessions stay in PostgreSQL).                                                                                   |
| Worker                                 | None: no job and no database access are needed in Phase 2.                                                                                                        | No change.                                                                                                                                                                                  |

## Known limitations (accepted for Phase 2)

- No password reset, email verification, MFA, invitations or recovery path (decision 3); no pepper.
- **Adding users to a closed instance needs an operator** to enable registration and restart the API, and while it is enabled anyone
  who can reach the API can register (decision 2).
- **Development database configuration (superseded in step 2.1, see the implementation notes):** the first draft of this limitation
  described one superuser shared by `api` and `migrate`. Step 2.1 replaced it with three roles; what remains is that the **superuser still
  exists** in the development stack (bootstrap, test tooling), that RLS is untestable until a later phase, and that the audit protection
  does not hold against a superuser or a schema owner (decision 6).
- Audit retention is unbounded and the log is not readable through the API; no permanent project deletion.
- scrypt memory and concurrency cost: 256 MiB of hashing budget per API process, so memory scales with replicas (decision 3).
- One session token format for browsers and API clients, so an API client that stores its token carelessly bears that risk.
- Tenant isolation is application-enforced; RLS is absent (decision 4.5).
- **Development-only compromises (not production architecture):** the Compose stack's session cookies are not `Secure` (the origin is
  `http://localhost:<port>`, accepted only for localhost), including in containers that run with `NODE_ENV=production`; and the API is
  published on `127.0.0.1:${API_PORT}` while `TRUST_PROXY_HOPS=1`, so a client connecting there directly can choose its address with
  `X-Forwarded-For` and **bypass per-address rate limits** (per-account limits are unaffected). In production the API port is not
  published; see environment.md, "Production requirements for authentication". A trusted-proxy list instead of a hop count is deferred.
- **Authentication rate limiting is not solved for these cases (accepted):** (1) a per-account limit means repeated failed attempts can
  **temporarily deny a legitimate user** their own account; (2) **IPv6 address rotation** bypasses per-address limits; (3) requests with
  no `req.ip` all share the single `unknown` bucket.

## Implementation notes (step 2.1: identity, authentication and sessions)

Recorded when step 2.1 was implemented. The decisions above stand; these are the places where the implementation settled a detail, or
differs from the wording of the ADR, with the reason. Nothing here reopens an approved decision.

| #   | Topic                                                        | What was built                                                                                                                                                                                                                                                                                                                                                                                                                              | Why / relation to the ADR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Database credentials split in 2.1**                        | The Compose stack now has the three roles (superuser, `agentos_migrate`, `agentos_api`), a `db-roles` provisioning service, `DATABASE_MIGRATE_URL` and `DATABASE_ADMIN_URL`, and `check-env`, CI and the system tests were updated.                                                                                                                                                                                                         | The ADR defaulted this to a later hardening step; the step-2.1 instructions pulled it forward. The "known limitation" about the shared superuser is therefore superseded (see above).                                                                                                                                                                                                                                                                                                                                            |
| 2   | **`db-roles` idles instead of exiting**                      | The provisioning service applies `roles.sql`, then stays running and reports healthy.                                                                                                                                                                                                                                                                                                                                                       | `docker compose up --wait` treats an exited container as a failure (found when `pnpm infra:up` failed), and `depends_on: service_healthy` then orders it. Idempotent, safe on an existing volume.                                                                                                                                                                                                                                                                                                                                |
| 3   | **Prisma datasource URL**                                    | `base.prisma` uses `env("DATABASE_MIGRATE_URL")`; the running API passes `DATABASE_URL` to the client explicitly.                                                                                                                                                                                                                                                                                                                           | Verified: with `directUrl`, `validate` needs both variables everywhere. A single CLI variable is simpler, and the API cannot reach the owner's credentials.                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | **Audit SELECT removed**                                     | The application role has `INSERT` only on the audit table, no `SELECT`. The repository uses `createMany`; Prisma `create` (RETURNING) is denied.                                                                                                                                                                                                                                                                                            | Verified against the real role (`identity-privileges.int.spec.ts`). A future reader gets its own privilege.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **`TRUNCATE` trigger verified**                              | The statement-level trigger is exercised as the table owner and by name in the system test.                                                                                                                                                                                                                                                                                                                                                 | Was listed as "to confirm" in revision 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | **Audit module shape**                                       | `audit` has `application/` and `infrastructure/` folders, not a flat layout.                                                                                                                                                                                                                                                                                                                                                                | The lint rules allow Prisma only in an `infrastructure/` layer; the ADR said "flat".                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | **Accepted scrypt cost range**                               | Stored hashes with `ln` 14 to **17** are accepted (the ADR said 14 to 18).                                                                                                                                                                                                                                                                                                                                                                  | N = 2^18 needs exactly 256 MiB and Node requires strictly more than `maxmem`; 2^17 is the largest cost that fits the approved ceiling. Raising the cost later also raises the ceiling.                                                                                                                                                                                                                                                                                                                                           |
| 8   | **`session.revoked` is not emitted (accepted deviation)**    | The catalog has no `session.revoked` event, and none is emitted until an **owner-initiated** revocation path exists (for example disabling a user). Every revocation path that exists emits its own, more specific event in the same transaction as the revocation: `auth.logout`, `auth.logout_all` (with the number of sessions revoked) and `auth.password_changed` (with the number of other sessions revoked).                         | The ADR reserved `session.revoked` for revocations the owner did not initiate. An event nothing emits is dead catalog data. Accepted by the security review of step 2.1; it is added with the first such path.                                                                                                                                                                                                                                                                                                                   |
| 9   | **`/auth/logout-all` and `/me/password`**                    | Both endpoints are implemented in this step.                                                                                                                                                                                                                                                                                                                                                                                                | Revocation, rotation and "invalidation after a security-sensitive change" need a concrete change to rotate on (the ADR's step 2.1 lists `/auth/*`, `/me`).                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | **CSRF body check**                                          | The JSON-body requirement applies to cookie-authenticated requests that **carry a body**; a bodyless request such as logout is protected by the `Origin` / `Sec-Fetch-Site` check alone.                                                                                                                                                                                                                                                    | A bodyless POST has no content type to check. The ADR wording ("the body must be JSON") assumed a body.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | **Fail-closed scope**                                        | Redis being unavailable makes sign-in, registration **and password change** answer `503 authentication_unavailable`; session validation, `/me`, logout and logout-all never touch Redis.                                                                                                                                                                                                                                                    | Password change verifies a credential, so it is a guessing surface like sign-in. Final decision 4 is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 12  | **`UserDirectory` built without a consumer**                 | `UserDirectory` (find a user by id or email) is part of the module's public contract and is implemented now, although the first consumer (organizations) arrives in step 2.2.                                                                                                                                                                                                                                                               | The step-2.1 instructions keep the ADR's public contracts. It is a thin read.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | **Bootstrap registration**                                   | Registration creates a user only; the first organization is created through the organizations API (step 2.2). The decision runs in one transaction behind a `pg_advisory_xact_lock`, and a cheap early refusal skips hashing on a closed instance.                                                                                                                                                                                          | As decided; verified with five simultaneous first registrations (exactly one wins).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Session token rotation**                                   | A password change replaces the token of the **same** session row in place (creation time and expiry unchanged) and revokes the others.                                                                                                                                                                                                                                                                                                      | The ADR said "rotate the current one"; keeping the row means rotation cannot extend a session's life.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 15  | **Test-only routes are `@Public()`**                         | The three test fixture controllers (`test-echo`, `test-conventions`, `test-db`) carry `@Public()`; an allowlist test pins the real public routes.                                                                                                                                                                                                                                                                                           | Default deny applies to them too. Their assertions are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 16  | **A defect found by the real database**                      | `pg_advisory_xact_lock` returns `void`, which Prisma cannot deserialize; the lock query selects an integer next to it.                                                                                                                                                                                                                                                                                                                      | Found by the first integration run (a unit test with fakes could not have found it).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 17  | **Canonical email enforced by the database**                 | `canonicalizeEmail` (packages/contracts) is the single canonicalization, used by `emailSchema` and `UserDirectory`. The migration `20261115130000_identity_email_canonical_check` adds `identity.user_email_canonical`: `CHECK (email ~ '^[!-~]+$' AND email = lower(email COLLATE "C"))`, i.e. printable ASCII only and no upper case. It first counts violating rows and stops with an actionable message instead of rewriting any email. | The ADR said "stored lower-cased and trimmed"; only the application enforced it, and a non-canonical row could coexist with the canonical one and be unreachable by sign-in. The constraint matches the contract: `z.email()` accepts printable ASCII only, so everything the application can store satisfies it; whitespace (everything JavaScript `trim()` strips), control characters and non-ASCII are excluded. `COLLATE "C"` keeps `lower()` independent of the database locale. The accepted email contract is unchanged. |
| 18  | **Insecure origin refused in production**                    | `NODE_ENV=production` with `AUTH_ALLOW_INSECURE_ORIGIN=true` fails configuration validation: the API does not start (verified with the real compiled entry point: exit code 1).                                                                                                                                                                                                                                                             | A development convenience that makes session cookies non-`Secure` must not be able to reach production by configuration drift.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **`auth.password_change_failed` (added beyond the catalog)** | Recorded for a wrong current password (`reason: wrong_current_password`) and once per window for the failure that exhausts the password-change budget (`reason: rate_limited`), in its own short transaction like a failed sign-in; an audit failure never changes the response. Refused (429) attempts are not recorded.                                                                                                                   | Re-authentication guessing by someone holding a stolen session is a security event the catalog did not cover. Reasons only: no password, hash or token, and no per-session events.                                                                                                                                                                                                                                                                                                                                               |

## Implementation notes (step 2.2: organizations and memberships)

Recorded when step 2.2 was implemented. The decisions above stand; these are the places where the implementation settled a detail, or
differs from the wording of the ADR, with the reason. Nothing here reopens an approved decision.

| #   | Topic                                                 | What was built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | **No organization slug**                              | Decision 4.4(d) ("slug uniqueness is per organization") is about the slugs of _projects_ and arrives in step 2.3. Organizations are addressed by id only: a global slug would add a uniqueness race, a rename policy and an enumeration surface for no use case in this phase.                                                                                                                                                                                                                                                                                                                     |
| 21  | **One new permission key: `member.manage_owners`**    | The matrix row "grant or revoke `owner`" is a catalog key (owner only), so ownership changes go through the same `AuthorizationService` as everything else. Changing a membership needs `member.manage`, and **also** `member.manage_owners` whenever an owner is involved, before or after (`permissionsToChangeMembership`, a pure function with a table test). The `project.*` keys and the project-role parameter of `permissionsFor` are **not** added: no placeholders before step 2.3.                                                                                                      |
| 22  | **Membership has its own id**                         | `identity.membership` has a UUID primary key and a unique `(organization_id, user_id)`. The audit events of a membership use that id as `resourceId`. Both foreign keys are `ON DELETE RESTRICT` (verified, also for the table owner).                                                                                                                                                                                                                                                                                                                                                             |
| 23  | **`User.memberships` in `identity.prisma`**           | Prisma needs both ends of a relation in the schema, so the `User` model gained the back-reference field. Identity never reads it; the foreign key still points organizations -> identity. `prisma migrate diff` against a database built from the migrations reports no difference.                                                                                                                                                                                                                                                                                                                |
| 24  | **`UserDirectory.findByIds`**                         | Added to Identity's public surface so the member list gets emails and display names without organizations reading Identity's tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 25  | **Every membership change locks the owners first**    | Not only changes that involve an owner. `MembershipRepository.lockOwners` runs `SELECT ... FOR UPDATE` on the organization's owner rows (ordered by id, so no cycles) and then **re-reads** the owners in a separate statement. Because adding, re-roling and removing all take the same lock, they run one after another per organization; that also stops an admin's change from overwriting a concurrent promotion to owner. The actor's role is re-read inside the transaction after the lock. Cost: membership changes of one organization serialize, which is irrelevant at this write rate. |
| 26  | **The race test is proven to fail without the lock**  | Four concurrent scenarios (two owners demote themselves, leave, remove each other, demote each other) run eight rounds each against real PostgreSQL. With `FOR UPDATE` removed all four fail with both requests succeeding (`200,200` / `204,204`); with it each ends with exactly one winner and the other answering `409 last_owner`, `404` or `403`. A fifth scenario (add one owner while two leave) passed even without the lock and was dropped rather than kept as false assurance.                                                                                                         |
| 27  | **Tenant guard and route declaration**                | `OrganizationAccessGuard` is applied with `@UseGuards` on the organization controllers (domain modules still register no global provider). It resolves `:organizationId` through `TenantAccess` (a malformed id is the same 404 as a stranger), checks the permission from `@RequirePermission`, and hands the handler a `TenantContext`. Using the guard on a route that declares no permission is refused with a 500, never served. `test/route-metadata.e2e.spec.ts` enumerates every route and pins its class (see 28).                                                                        |
| 28  | **Three route classes, one explicit list**            | A route is `@Public()`, gated by a declared permission (every route under `:organizationId`), or on a short allowlist of **account-scoped** routes (`/me`, `/auth/logout*`, `GET` and `POST /organizations`). Adding a route that is none of these fails the test. `DELETE .../members/:userId` declares `member.read` because _leaving_ needs only membership; the service requires `member.manage` (and `member.manage_owners` for an owner) to remove someone else.                                                                                                                             |
| 29  | **Who may do what to ownership**                      | Any authenticated user may create an organization and becomes its owner (no quota in this phase). Only an owner can add an owner, change an owner's role, promote anyone to owner or remove an owner; an admin manages every non-owner. Anyone may leave, unless they are the last owner (`409 last_owner`). An owner may demote or remove themselves when another owner exists. A role change to the role a member already has, and a rename to the current name, change nothing and are not audited.                                                                                             |
| 30  | **Audit: set, not sequence**                          | `occurred_at` is the transaction's start time, so the events written by one transaction (for example `membership.role_changed` and `organization.owner_granted`) share it and have no defined order. Readers and tests must treat them as a set. This is a property of the 2.1 table, found here; a future reader orders by `(occurred_at, id)` knowing ties are unordered.                                                                                                                                                                                                                        |
| 31  | **Refusals are not audited in this step**             | The catalog (decision 6) lists successful state changes only. A refused attempt (`403`, `409 last_owner`) leaves the `ApiError` response and the request log, not an audit row. If refused ownership attempts should be auditable, that is a new catalog entry and a decision for review.                                                                                                                                                                                                                                                                                                          |
| 32  | **Adding by email reveals whether an account exists** | `POST .../members` answers `404 user_not_found` for an unknown or disabled email and `409 already_member` for a member. Anyone who may add members learns whether an address has an account, and any user may create an organization and so gain that ability. Accepted for now because registration is closed by default and there are no invitations; it must be revisited together with invitations and email verification.                                                                                                                                                                     |
| 33  | **Organization name constraint**                      | `identity.organization_name_valid`: trimmed length at least 1, at most 100 characters. There is **no database constraint** that an organization has an owner: it cannot be a simple `CHECK`, and a deferred constraint trigger would be another moving part. The invariant is held by the application inside a locked transaction and proven by the concurrency test above.                                                                                                                                                                                                                        |
| 34  | **`MembershipDirectory` built without a consumer**    | `isMember` and `organizationIdsOf` are implemented now as the ADR's contract for step 2.3, as `UserDirectory` was in step 2.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 35  | **Grants**                                            | The migration `organizations_privileges_and_constraints` grants `SELECT, INSERT, UPDATE` on `organization` (never deleted in this phase) and `SELECT, INSERT, UPDATE, DELETE` on `membership` (`UPDATE` is also what `SELECT ... FOR UPDATE` needs). The exact-grants test of the application role lists them.                                                                                                                                                                                                                                                                                     |

## Implementation notes (step 2.3: the additive amendments of ADR-0011)

Recorded when step 2.3 was implemented. They are the four additive amendments ADR-0011 announced (A1 to A4) and nothing else; no
decision above is reopened. [ADR-0011](0011-projects-and-project-members.md) holds the design and its implementation status.

| #   | ADR-0010 text amended                                                           | What was built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 36  | **A1.** Decision 1: the public contract of `organizations`.                     | `organizations/index.ts` now also exports `MembershipLifecycle` (the registry of removal participants, sealed when the application has bootstrapped), the types `MembershipRemovalParticipant` and `MembershipRemoval`, `MembershipDirectory.holdMember(organizationId, userId, tx)` (`SELECT … FOR SHARE` on one membership row, for the project side), `permissionsFor(organizationRole, projectRole)` (the union rule), `AuthorizationService.permissionsOn` / `authorizeOnProject`, and `requireScope` (the fail-closed scope check). |
| 37  | **A2.** Decision 1, dependency diagram: `projects → identity (Principal only)`. | `projects` also imports `UserDirectory.findByIds` through `identity/index.ts`, to return the email and display name of project members.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 38  | **A3.** Decision 5, project access policy (points 1 to 5).                      | Point 6: **the end of an organization membership ends the user's project memberships in that organization, in the same transaction** (the removal participant, ADR-0011 decision 3). Point 7: the creator's explicit `project_admin` row survives the loss of owner/admin status but not the loss of the organization membership.                                                                                                                                                                                                         |
| 39  | **A4.** Note 25: every membership change locks the owner rows first.            | The mechanism is unchanged. Added: removing a membership also locks the **removed member's** row `FOR UPDATE` before the participants run (`lockMember`), and a foreign-key violation on the final delete is answered `409 membership_in_use` (new code in `ORGANIZATION_ERROR_CODES`) instead of a 500. The project side may hold **one** organization-membership row at a time (the target or the creator, never the actor): a stress test guards against the deadlock a second held row causes.                                        |
