# ADR-0010: Identity, organizations and projects (first domain slice)

**Status:** Proposed (awaiting architectural review; no implementation has started)
**Context:** The foundation (Phases 1.1-1.6) is merged: API, web app, worker, contracts, queue, Compose stack, system tests and CI.
No domain entity exists yet. The specification ([§5.1, §5.2, §6.2, §6.4, §7.3, §12.1, §12.2, §12.6, §18](../architecture/technical-architecture-specification.md))
makes Identity, Organizations and Projects the first domain phase, and steps 1-2 of the MVP scenario (§19: "user creates an
organization", "user creates a project") depend on it. Every later domain (agents, models, MCP, software intelligence) is
scoped by organization and project, so the tenancy and authorization decisions made here are the hardest to change later.
This is also the first real test of the conventions in [backend.md](../architecture/backend.md), whose ADR-0004 expects
amendments ("the conventions are unproven against a real domain").

## Scope

**In scope:** users, local authentication, sessions, organizations, memberships, roles and permissions (RBAC), projects, project
members, an authorization interface other modules will use, a minimal append-only audit log for identity/organization/project
changes, the API in §7.3 plus the authentication endpoints, and a web slice (sign in, organization and project selection, create
and list projects).

**Out of scope (later phases):** OIDC / external identity providers (the design leaves the seam, decision 3), invitations by
email, password reset by email, SSO/SAML, API keys and service accounts, per-agent/tool permissions, policy-based authorization,
PostgreSQL Row Level Security (decision 5), billing, any agent/model/MCP entity, and any new worker job.

## Decisions

### 1. Two modules, one public authorization interface

`modules/identity` (users, credentials, sessions, organizations, memberships, roles, permissions, audit log) and
`modules/projects` (projects, project members). Both are **layered** (they have real invariants: last-owner protection, slug
rules, role/permission checks). `projects` depends on `identity` through `modules/identity/index.ts` only; `identity` never
imports `projects` (no cycle). The public interface other modules use is an `AuthorizationService`, never repositories:

```ts
authorize(principal, permission, scope: { organizationId: string; projectId?: string }): Promise<void>  // throws AppError('forbidden' | 'not_found')
```

Why two modules: spec §5.1 and §5.2 are separate domains with separate ownership; merging them would let project code reach
membership internals.

### 2. Data model

One PostgreSQL cluster, one Prisma schema file per domain (`identity.prisma`, `projects.prisma`), using Prisma `multiSchema`
(GA in Prisma 6.19, already pinned) with `@@schema("identity")` and `@@schema("projects")` to realize the logical schemas of §6.1.
UUID primary keys, UTC timestamps, explicit foreign keys.

| Table (schema)             | Key fields and constraints                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.user`            | id, email (stored lower-cased, **unique**), display_name, status (`active`/`disabled`)                                                |
| `identity.credential`      | user_id (unique), password_hash, algorithm params; kept apart so a second identity type (OIDC) is another row, not a column on `user` |
| `identity.session`         | id, user_id, token_hash (**unique**), created_at, expires_at, last_seen_at, revoked_at, user_agent (no IP stored)                     |
| `identity.organization`    | id, name, slug (**unique**), status                                                                                                   |
| `identity.permission`      | key (**unique**, e.g. `project.create`), description; a fixed catalog seeded by migration                                             |
| `identity.role`            | id, organization_id, name, is_system; unique (organization_id, name)                                                                  |
| `identity.role_permission` | role_id, permission_id (composite PK)                                                                                                 |
| `identity.membership`      | user_id, organization_id, role_id; unique (user_id, organization_id)                                                                  |
| `identity.audit_log`       | id, organization_id (nullable for sign-in events), actor_id, action, resource_type, resource_id, result, correlation_id, created_at   |
| `projects.project`         | id, organization_id, name, slug, settings (jsonb, validated), status; unique (organization_id, slug)                                  |
| `projects.project_member`  | project_id, user_id, role; the user **must** already be a member of the project's organization (enforced in the application service)  |

Rules: organization-scoped uniqueness is a database constraint (§6.4); no soft deletion in this phase (projects and organizations
are `status = archived`, rows are not removed; deletion needs a retention decision and is deferred); `audit_log` has no update or
delete path in the application. `ProjectIntegration` (§6.2) is **not** created now: nothing can use it yet.

### 3. Authentication: local credentials now, OIDC behind a seam later

- **Local email + password**, as §12.1 allows for initial self-hosted use. Passwords are hashed with **`crypto.scrypt`** from Node
  (no new dependency; no native addon needing an install script under pnpm 11), per-user random salt, parameters stored with the hash
  so they can be raised and old hashes rehashed on sign-in. Constant-time comparison. Minimum length 12, no composition rules.
- **Server-side sessions, not self-contained JWTs.** An opaque 256-bit random token is returned once; only its SHA-256 hash is
  stored. Sessions are revocable (logout, "sign out everywhere", disabling a user) and expire (sliding idle timeout plus absolute
  maximum). This satisfies "short-lived access tokens / secure session handling" (§12.1) without building a token-refresh
  protocol, and PostgreSQL (the source of truth) holds the sessions; Redis is not authoritative.
- **Two transports, one session:** browser clients get an `HttpOnly`, `Secure` (except plain-http development), `SameSite=Lax`
  cookie; API clients may send `Authorization: Bearer <token>`. Cookie-authenticated mutating requests require a CSRF defense
  (the `SameSite` cookie plus an `Origin` check against the configured web origin; no token dance needed for a same-site SPA behind
  the nginx proxy). A request is authenticated by exactly one mechanism.
- **Bootstrap:** the first registered user on an empty instance becomes the owner of their first organization; afterwards
  `POST /auth/register` is controlled by `AUTH_ALLOW_REGISTRATION` (default `false`). Self-service sign-up on a public instance
  must be a deliberate choice.
- **Abuse resistance:** sign-in attempts are counted per account and per client address in Redis (ephemeral state, appropriate
  use of Redis); sign-in failures return one generic error, and the audit log records them. A fixed small delay is applied on unknown
  users so timing does not reveal which emails exist.
- **OIDC seam:** authentication produces a `Principal { userId, sessionId }`. A later phase adds an OIDC login that creates a
  `credential` row of another type and the same session; nothing downstream changes. No OIDC code now.

### 4. Authorization: deny-by-default RBAC over a fixed permission catalog

- Permissions are a code-defined catalog (`organization.read`, `organization.update`, `member.manage`, `project.create`,
  `project.read`, `project.update`, `project.archive`, ...) mirrored into `identity.permission` by the migration; **roles are
  data** (per organization), permissions are **code**. Four system roles are created with every organization: `owner`, `admin`,
  `member`, `viewer`, with a documented permission matrix. Custom roles are out of scope but the model supports them.
- Controllers declare the requirement (`@RequirePermission('project.update')`); a guard authenticates, resolves the scope from the
  **resource** (never from client-supplied organization ids that disagree with it), and calls `AuthorizationService`. Application
  services re-check for operations that start from another service rather than a controller.
- Project access = organization permission **and**, where the role is not organization-wide, project membership (§6.4: "access
  checks validate both organization and project membership"). Organization `owner`/`admin` see every project of the organization.
- Cross-organization access is denied by default. A resource in another organization answers **404, not 403**, so existence is not
  disclosed. Invariants: an organization always keeps at least one `owner`; a user cannot remove their own last owner role.

### 5. Tenant isolation is application-enforced now; RLS is deferred

Every query on an organization- or project-owned table carries the organization scope in the repository method signature (no
"find by id alone" for tenant data). This phase does **not** introduce PostgreSQL Row Level Security: §6.4 says it may be added
as defense in depth and must correctly set and reset tenant context on pooled connections, which needs its own design
(transaction-scoped `SET LOCAL`, a non-superuser application role, test coverage). The schema (organization id on every row)
is designed so RLS can be added without a data migration. Recorded as a known limitation, not a silent omission.

### 6. Audit log, minimal

One table, written by the application service **inside the same transaction** as the change it records (sign-in, sign-out,
organization/project/membership/role changes). Append-only from the application's perspective (§12.6): the repository exposes
`append` and `list`, nothing else. Observability owns trace/span data; this table is the security audit trail and lives in the
identity schema until a Security domain exists. No secrets, no request bodies.

### 7. API

All under `/api/v1`, documented with the existing Zod-to-OpenAPI helpers, errors in the `ApiError` shape, lists with
`paginationQuerySchema`/`paginatedSchema`:

```http
POST   /auth/register          (bootstrap / AUTH_ALLOW_REGISTRATION)
POST   /auth/login             POST /auth/logout        POST /auth/logout-all
GET    /me
GET    /organizations          POST /organizations
GET    /organizations/:organizationId
PATCH  /organizations/:organizationId
GET    /organizations/:organizationId/members      PATCH/DELETE .../members/:userId
GET    /projects?organizationId=      POST /projects      GET/PATCH /projects/:projectId
GET    /projects/:projectId/members   POST /projects/:projectId/members   DELETE .../members/:userId
```

The spec lists `/projects` without an organization segment (§7.3); this ADR keeps those paths and makes `organizationId` an
explicit query/body field that the server validates against the caller's memberships. Credentials and tokens never appear in any
response other than the single sign-in response; `email` is only returned to members of a shared organization.

### 8. Contracts and web

Contracts first (`packages/contracts/src/identity.ts`, `projects.ts`: requests, responses, permission keys, role names; zod only).
The web slice (`features/auth`, `features/organizations`, `features/projects`) uses `apiRequest`, TanStack Query key factories,
a session-aware app shell, `Page`/state components, English and Persian strings, and logical CSS properties, per
[frontend.md](../architecture/frontend.md). The active organization/project is a browser preference (Zustand store); the
**server** never trusts it, it is sent explicitly on each request.

### 9. Dependencies and configuration

No new package is planned (`crypto.scrypt`, `crypto.randomBytes`, `crypto.timingSafeEqual`, Express's own cookie support). If
cookie parsing needs a package, it will be `cookie`, already in the lockfile through Express, stated in the PR. New environment
variables (declared in the config schema, `.env.example` and Compose, checked by `check:env`): `AUTH_ALLOW_REGISTRATION`,
`SESSION_IDLE_TTL_MINUTES`, `SESSION_ABSOLUTE_TTL_HOURS`, `WEB_ORIGIN`. No secret is needed for sessions (tokens are random and
stored hashed), so there is no signing key to manage or rotate in this phase.

### 10. Delivery in four reviewable steps

| Step | Content                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | Contracts, `identity.prisma` (users, credentials, sessions), password hashing, sessions, `/auth/*`, `/me`, guard, login throttling, audit table |
| 2.2  | Organizations, memberships, roles/permissions, `AuthorizationService`, organization endpoints, last-owner invariants                            |
| 2.3  | Projects and project members, project-level authorization, cross-tenant isolation tests                                                         |
| 2.4  | Web slice, system-test scenario (register, sign in, create organization and project through the real stack), docs, ADR finalization             |

Each step ends with `pnpm verify`, `pnpm test:integration` and, for 2.4, `pnpm test:system`; each goes through its own review
before the next starts.

## Consequences

- Every later domain has a settled tenant model and a single authorization entry point; adding a resource type is a permission
  key plus a guard decorator, not a new access-control design.
- Sessions in PostgreSQL add a read per authenticated request; acceptable now (indexed unique lookup, `last_seen_at` updated at
  most once a minute) and cacheable in Redis later without changing the contract.
- Local passwords make AgentOS responsible for credential storage until OIDC exists; mitigated by scrypt, throttling, generic
  errors and the documented seam, and by shipping registration closed by default.
- Application-enforced tenancy means a missed scope in a repository method is a data leak; mitigated by repository signatures that
  require the scope and by cross-tenant tests per resource. RLS stays a documented follow-up.
- This phase will probably require amendments to backend.md (a request-scoped principal, guards, the first layered module); they
  will be recorded when discovered, not guessed now.

## Alternatives considered

- **JWT access + refresh tokens:** rejected for now; revocation, rotation and refresh storage reproduce a session table anyway,
  with more ways to get it wrong. Revisit when an external IdP issues the tokens.
- **Adopt an identity library or service now (Keycloak, Auth.js, Passport strategies):** rejected for Phase 2: a heavy
  dependency or a new infrastructure service for one login form; §12.1 asks to avoid a custom _protocol_, not a custom form over
  a standard session.
- **`argon2` / `bcrypt`:** stronger or more familiar, but native addons conflict with pnpm 11's blocked install scripts and add a
  dependency; `scrypt` is acceptable (OWASP-listed) and built in. Easy to swap because parameters are stored with each hash.
- **One `identity` module for projects too:** rejected, see decision 1.
- **PostgreSQL RLS from the start:** rejected as the primary control, see decision 5.
- **Soft-delete everywhere:** rejected, see decision 2.

## Decisions requiring approval

1. Local email/password + opaque server-side sessions now, OIDC later behind the `Principal` seam (decision 3).
2. `crypto.scrypt` instead of `argon2`/`bcrypt` (decision 3).
3. Registration closed by default; first user bootstraps the instance (decision 3).
4. Roles as per-organization data, permissions as a code catalog, four system roles, no custom roles yet (decision 4).
5. 404 for cross-organization resources (decision 4).
6. RLS deferred; application-enforced tenancy with scoped repository signatures (decision 5).
7. A minimal audit table in this phase rather than waiting for a Security domain (decision 6).
8. Prisma `multiSchema` for the logical schemas in §6.1 (decision 2).
9. The four-step delivery plan and review gates (decision 10).
