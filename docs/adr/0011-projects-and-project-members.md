# ADR-0011: Projects and project members (Phase 2.3)

**Status:** Proposed (design only; nothing in this ADR is implemented). Needs review and explicit approval before any code is written.
**Context:** [ADR-0010](0010-identity-organizations-projects.md) (Accepted) fixed the architecture of Phase 2 and delivers it in four
reviewed steps. Steps 2.1 (identity, authentication, sessions, audit) and 2.2 (organizations, memberships, tenant isolation,
authorization) are merged (`main` at `7db426f`). This ADR designs step 2.3: the `projects` module, its two tables, its API and its
tests. It was written against the actual repository, not against summaries; where the repository differs from ADR-0010 or leaves a
gap, that is reported under "Findings" and decided or asked, never changed silently.

**Relationship to ADR-0010.** Nothing in ADR-0010 is reopened. This ADR _applies_ decisions 1 (modules), 4 (tenant isolation), 5
(authorization and the project access policy), 6 (audit), 7 (Prisma) and 8 (API), and final decisions 1 (archive/restore, no
deletion) and 8 (project roles and default access). The places where it needs something ADR-0010 did not say are listed as numbered
questions at the end, each with a recommendation.

## Findings in the current repository

Reported, not fixed (this phase is design only and must not change Phase 2.1/2.2 behavior).

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                       | Consequence for this design                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Removing a user from an organization knows nothing about projects.** ADR-0010 says a demotion "removes that access on the next request" for owner/admin, but is silent on what happens to a user's `project_member` rows when their _organization membership_ ends (removal or leaving). Implemented 2.2 simply deletes the `membership` row.                               | A real gap. Without a decision, project grants outlive the organization membership and could revive when the user is re-added. Decision 3 closes it (needs one additive amendment to `organizations`, question Q1/Q2).                                   |
| F2  | **`OrganizationAccessGuard`, `@RequirePermission` and `@CurrentTenant` are private to `organizations`** (not in its `index.ts`), and the guard resolves only a `:organizationId` path parameter.                                                                                                                                                                              | `/projects/:projectId` and `/projects?organizationId=` cannot reuse it. `projects` gets its own access guard built on the public `TenantAccess`, `AuthorizationService` and `MembershipDirectory`. No change to the 2.2 guard.                           |
| F3  | **`permissionsFor(organizationRole, projectRole)` does not exist yet.** 2.2 implemented `permissionsFor(role)` (domain, unexported) and said the project parameter arrives in 2.3, as ADR-0010 decision 5 requires ("one pure function, in the organizations domain, behind `AuthorizationService`").                                                                         | An additive change to `organizations` (new function and one `AuthorizationService` method, exported). Not a behavior change.                                                                                                                             |
| F4  | **`OrganizationScope` is opaque by convention only.** Its constructor is private but `OrganizationScope.of(id)` is public and `scopeOf` accepts any object shaped like a `TenantContext`. The scope fails closed on a missing or malformed id (proven by tests); it does **not** stop in-process code from constructing a scope for the wrong, but well-formed, organization. | Real, and inherent to application-enforced tenancy (ADR-0010 decision 4.5). The new `ProjectScope` follows the same pattern; the compensating controls are listed in decision 5. Optional hardening is Q9. No claim is made that a scope is unforgeable. |
| F5  | **ADR-0010's dependency diagram says `projects → identity (Principal only)`.** Listing project members needs each member's email and display name, which only `UserDirectory.findByIds` (public, added in 2.2) provides.                                                                                                                                                      | A small, visible deviation: `projects` also imports `UserDirectory`. The alternative is a second user-lookup surface. Q8.                                                                                                                                |
| F6  | **No database-level link prevents an orphaned or cross-organization project membership today** because the tables do not exist yet; ADR-0010 states the rule ("a project member must belong to the project's organization") but puts it only in `projects`.                                                                                                                   | Decision 7 adds a database-level guarantee through composite foreign keys, which is where a concrete integrity benefit exists.                                                                                                                           |
| F7  | **The audit contract and table already carry `projectId`** (`common.projectId`, column `project_id`, index on `organization_id`).                                                                                                                                                                                                                                             | No change to `audit` or its migration; only new event schemas in `packages/contracts/src/audit.ts`.                                                                                                                                                      |
| F8  | **ADR-0010 assigns the end-to-end system scenario to step 2.4.**                                                                                                                                                                                                                                                                                                              | This design proposes a small API-level system test in 2.3 anyway, because only the Compose stack exercises a **new PostgreSQL schema** created by the migration role. Q10.                                                                               |

## Decisions

### 1. Module boundaries and ownership

`modules/projects` is a new layered module (`domain/`, `application/`, `infrastructure/`, `presentation/`, public `index.ts`), the third
domain module in the chain `projects → organizations → identity → audit`. It owns `projects.project` and `projects.project_member` and
nothing else.

| Responsibility                                               | Owner                         | How `projects` obtains it                                                                                                                                           |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who the caller is (`Principal`, authentication, sessions)    | `identity`                    | `CurrentPrincipal`, `Principal` from `modules/identity` (the global `AuthenticationGuard` has already run). No access to `identity` tables or repositories.         |
| Display data of a user (email, display name)                 | `identity`                    | `UserDirectory.findByIds` (public; finding F5).                                                                                                                     |
| Is the caller a member of organization X, and with what role | `organizations`               | `TenantAccess.resolve(principal, organizationId)` → `TenantContext`; `MembershipDirectory.isMember` / `organizationIdsOf`. Read from the database on every request. |
| Does a role hold a permission (the matrix)                   | `organizations` (+ contracts) | `AuthorizationService` (extended additively, decision 4). `projects` never re-implements the matrix.                                                                |
| Projects, project members, project roles, their rules        | `projects`                    | Own repositories; no Prisma model of another module is ever imported or `include`d.                                                                                 |
| Audit recording                                              | `audit`                       | `AuditRecorder.record(event, tx)` with typed events from `packages/contracts`.                                                                                      |
| Transactions                                                 | application services          | `TransactionRunner`; repositories take `tx`.                                                                                                                        |

**Dependency edges added:** `projects → organizations`, `projects → identity`, `projects → audit`, `projects → database`. **No edge
points at `projects`** and no cycle exists (`tools/check-module-boundaries.mjs` enforces both). The one place where `organizations`
must react to something `projects` owns (decision 3, the end of an organization membership) is solved by **inversion**: `organizations`
defines a small interface and `projects` registers an implementation, so the dependency still points `projects → organizations`.

`projects` exports through `index.ts` only `ProjectsModule`. ADR-0010's `ProjectAccess` public contract waits for its first consumer
(Agent Runtime), as that ADR decided; internally the module has a `ProjectAccess` application service that the guard uses.

**Additive surface in `organizations` (needs approval, Q2).** No existing behavior changes:

1. `permissionsFor(organizationRole, projectRole | null)` and `AuthorizationService.permissionsOn(tenant, projectRole)` /
   `authorizeOnProject(tenant, projectRole, ...permissions)`, exported.
2. A `MembershipLifecycle` registry (decision 3): `registerRemovalParticipant(participant)` plus one call inside the existing
   transaction of `MembershipService.remove`.
3. A back-relation field on the `Membership` and `Organization` Prisma models (Prisma needs both ends of a relation; the same thing 2.2
   did to `identity.prisma`). Organizations never reads them.

### 2. Project model

A project belongs to **exactly one organization**, fixed at creation.

| Field                      | Decision                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | UUID primary key. Projects are addressed by id (`/projects/:projectId`); the slug is never an authority.                                                                                                                                                                                                                                                  |
| `organization_id`          | Required, foreign key to `identity.organization(id)`, `ON DELETE RESTRICT`. **Immutable**: not part of any update contract, and the application role has no `UPDATE` privilege on the column (decision 7). A project is never transferred implicitly; **transfer between organizations is deferred** (a new decision with its own data rules).            |
| `name`                     | Required, trimmed, 1 to 100 characters. Not unique (two projects may share a display name).                                                                                                                                                                                                                                                               |
| `slug`                     | Required on creation, lower-case letters, digits and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`), 2 to 48 characters. **Unique per organization** (`UNIQUE (organization_id, slug)`), as ADR-0010 states. **Immutable** after creation (stable references; no rename policy). Archived projects keep their slug reserved, so a restore can never collide. |
| `description`              | Optional text, at most 2000 characters, `NULL` when absent. **No free-form `metadata` column**: it has no consumer and would be unvalidated data in a security-sensitive table; a typed field is added when a feature needs it.                                                                                                                           |
| `status`                   | Enum `active` \| `archived`.                                                                                                                                                                                                                                                                                                                              |
| `archived_at`              | `timestamptz`, `NULL` while active. `CHECK ((status = 'archived') = (archived_at IS NOT NULL))`, so the two can never disagree.                                                                                                                                                                                                                           |
| `created_at`, `updated_at` | `timestamptz` UTC. `updated_at` moves on any change including archive and restore. No `created_by` column: the actor is in the audit event and the creator is the first `project_admin` member (ADR-0010 decision 5, point 4).                                                                                                                            |

**Lifecycle.** `active ⇄ archived`, both transitions audited. An archived project is read-only: it accepts **no updates and no new
members**, and member role changes and removals are refused too (`409 project_archived`); it can only be restored. It stays readable,
and stays in its members' lists only when asked for (`status=archived|all`). Archive and restore are idempotent: repeating one changes
nothing and writes no audit event (the convention of 2.2).

**Deletion is deferred** (ADR-0010 final decision 1): no `DELETE /projects/:id`, no `project.deleted` event, no `DELETE` privilege on
`projects.project` for the application role.

**Organization deletion.** No organization deletion exists (no endpoint, no `DELETE` privilege on `identity.organization`). The foreign
key from `project` to `organization` is `RESTRICT`, so when organization deletion is eventually designed it **cannot** silently remove
projects: it must archive or explicitly delete them first, by a decision made then.

### 3. Project membership

A **project membership** is a row that gives one user one project role on one project. It is a different concept from an organization
membership and never changes it.

Rules (all mandatory, each enforced where it can be enforced best):

| #   | Rule                                                                                            | Enforced by                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Organization `owner` and `admin` have implicit access to every project of their organization.   | `permissionsFor` (decision 4). They need no row, and are **not listed** as project members unless they also have one.                                                                                          |
| 2   | Organization `member` and `viewer` need an explicit project membership to see or use a project. | `permissionsFor` and the visibility rule (a project without access is a 404).                                                                                                                                  |
| 3   | A project role cannot grant organization-level permissions or elevate the organization role.    | **Compile time**: project-role entries are typed to accept only project-scoped keys (ADR-0010 decision 5). Test: a type-level assertion and a property test over every combination.                            |
| 4   | A user can be a project member only if they are a member of the project's organization.         | **Database**: composite foreign key `(organization_id, user_id) → identity.membership(organization_id, user_id)`. Application: a pre-check gives the friendly 404 before the insert.                           |
| 5   | Cross-organization project membership is impossible.                                            | **Database**: composite foreign key `(project_id, organization_id) → project(id, organization_id)` plus rule 4. A row whose organization differs from its project's, or whose user is not in it, cannot exist. |
| 6   | A user has at most one role per project.                                                        | `UNIQUE (project_id, user_id)`.                                                                                                                                                                                |
| 7   | The end of an organization membership ends the user's project memberships in that organization. | See below.                                                                                                                                                                                                     |

**Lifecycle.** `added` (by a user holding `project.member.manage` on that project, for an existing, active member of the organization)
→ `role changed` (any project role to any other) → `removed`. There is no "last project admin" invariant: organization `owner`/`admin`
always hold implicit administrative access, so a project can never become unmanageable and nothing needs the ownership-style lock of
2.2. A project member cannot remove themselves in this step (Q5).

**Rule 7 and finding F1 (the end of an organization membership).** Evaluated options:

| Option                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Leave the rows and rely on every request re-checking organization membership.                                    | Rejected. Access is safe while the user is out, but the stale grant **revives** if they are added back, and no foreign key could exist (it would block the removal).                                                                                                                                                                                                                     |
| B. `ON DELETE CASCADE` from the membership foreign key.                                                             | Rejected. ADR-0010 decision 7 forbids cross-domain cascades, and a cascade is invisible to the audit trail (no `project_member.removed`).                                                                                                                                                                                                                                                |
| C. Foreign key `RESTRICT` only; removing an organization member fails while project memberships exist.              | Workable but changes the 2.2 API (a new 409 and a mandatory cleanup order) and makes "leave the organization" depend on project state.                                                                                                                                                                                                                                                   |
| **D. Foreign key `RESTRICT` as the safety net, plus a removal participant registered by `projects` (recommended).** | **Recommended.** Inside the same transaction as the organization membership removal, `projects` deletes that user's project memberships in that organization and writes one `project_member.removed` event each (reason `organization_membership_removed`). The foreign key guarantees that nothing can be orphaned even if a participant were forgotten: the removal would fail loudly. |

Option D keeps the dependency pointing `projects → organizations`: `organizations` owns a small interface
(`MembershipRemovalParticipant.onMembershipRemoved({ organizationId, userId, actorUserId }, tx)`) and a registry; `projects` registers an
implementation when it starts. The participant bypasses the "archived projects are read-only" rule, because a user who left must lose
access to archived projects too.

### 4. Permissions and roles

Permissions and roles stay **code** (`packages/contracts/src/permissions.ts`); no table. Keys are tagged with their scope.

**New roles:** `ProjectRole` = `project_admin` | `project_member` | `project_viewer` (an enum stored on `project_member`).

**New keys:**

| Key                     | Scope          | Meaning                                                                                                                                                      |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project.list`          | `organization` | Call the project list of an organization. The list then contains only projects the caller has access to (visibility follows access). Held by every org role. |
| `project.create`        | `organization` | Create a project in an organization. Organization-scoped because no project exists yet and a project role can never grant it (ADR-0010 matrix).              |
| `project.read`          | `project`      | See the project and its members. Having it **is** having access: without it the project does not exist for the caller.                                       |
| `project.update`        | `project`      | Change the name and description.                                                                                                                             |
| `project.archive`       | `project`      | Archive and restore.                                                                                                                                         |
| `project.member.manage` | `project`      | Add, re-role and remove project members.                                                                                                                     |

Listing the members needs only `project.read` (every organization member can already see every organization member's email, so this
discloses nothing new). `project.list` is a new key rather than reuse of `organization.read` so that the catalog says what the route
does (Q7).

**Typing of the catalog (compile-time property for rule 3).** A definition is a union: an `organization` key has only `roles`
(organization roles); a `project` key has `roles` (the organization roles that hold it **implicitly on every project**) and
`projectRoles` (the roles that hold it **on that project**). An organization key cannot carry `projectRoles`, so a project role cannot be
made to grant an organization permission without a compile error.

**Evaluation (one pure function, `permissionsFor(organizationRole, projectRole | null)`):** the permission set is the **union** of what
the organization role grants (organization keys, plus project keys it holds implicitly) and what the project role grants on that
project. Access to a project means the set contains `project.read`.

**Permission matrix.** "Holds it on that project" for the project-role columns; the project roles add **nothing** at organization level.

| Permission                                 | Org owner | Org admin | Org member | Org viewer | Project admin | Project member | Project viewer | Authenticated, not in the org |
| ------------------------------------------ | :-------: | :-------: | :--------: | :--------: | :-----------: | :------------: | :------------: | :---------------------------: |
| **Organization level**                     |           |           |            |            |               |                |                |                               |
| `organization.read`, `member.read`         |    yes    |    yes    |    yes     |    yes     |   no change   |   no change    |   no change    |           no (404)            |
| `organization.update`, `member.manage`     |    yes    |    yes    |     no     |     no     |   no change   |   no change    |   no change    |           no (404)            |
| `member.manage_owners`                     |    yes    |    no     |     no     |     no     |   no change   |   no change    |   no change    |           no (404)            |
| **Project management**                     |           |           |            |            |               |                |                |                               |
| `project.list` (result filtered by access) |    yes    |    yes    |    yes     |    yes     |   no change   |   no change    |   no change    |           no (404)            |
| `project.create`                           |    yes    |    yes    |    yes     |     no     |   no change   |   no change    |   no change    |           no (404)            |
| `project.update`                           |  all (i)  |  all (i)  |  no (ii)   |  no (ii)   |      yes      |       no       |       no       |           no (404)            |
| `project.archive` (archive and restore)    |  all (i)  |  all (i)  |  no (ii)   |  no (ii)   |      yes      |       no       |       no       |           no (404)            |
| **Project member management**              |           |           |            |            |               |                |                |                               |
| `project.member.manage`                    |  all (i)  |  all (i)  |  no (ii)   |  no (ii)   |      yes      |       no       |       no       |           no (404)            |
| **Project data access**                    |           |           |            |            |               |                |                |                               |
| `project.read` (project, member list)      |  all (i)  |  all (i)  | only (iii) | only (iii) |      yes      |      yes       |      yes       |           no (404)            |

(i) implicitly on **every** project of the organization, with no row. (ii) not on any project by organization role alone; a
`project_admin` row grants these on that one project only. (iii) only on projects where the person has a row; elsewhere the project
does not exist for them (404).

Project data (agents, executions, usage, files) does not exist yet. When a later domain adds data permissions it adds project-scoped
keys to this catalog; `project_member` and `project_viewer` hold identical permissions today (ADR-0010) and diverge then.

**Combined cases worth stating.** An organization `member` or `viewer` who is `project_admin` of project P can update, archive/restore
and manage the members of **P only**. They hold no organization-level permission beyond their organization role (a viewer still cannot
create projects), and they cannot see any other project they have no row in. A `project_admin` cannot manage organization members or
settings. If an owner/admin is demoted to member, their implicit access ends on the next request and only their
explicit rows remain; if they are removed from the organization, decision 3 removes the rows.

### 5. Authorization flow and tenant isolation

Deny by default holds: every route needs a session (global guard) and, under `/projects`, a declared permission (`@RequirePermission`
equivalent in `projects`, pinned by the route-metadata test).

**Source of truth for every decision:** the organization role comes from `identity.membership`, the project role from
`projects.project_member`, the project's status from `projects.project`, **each read from PostgreSQL on that request** (inside the
transaction for mutations). Nothing is cached, in the session or elsewhere.

**Organization-addressed routes** (`GET /projects?organizationId=`, `POST /projects` with `organizationId` in the body):

1. The id is a _selector_. If absent: `400`. If present, `TenantAccess.resolve(principal, organizationId)`; malformed, unknown and
   not-a-member are the same `404 organization_not_found`.
2. `AuthorizationService.authorize(tenant, 'project.list' | 'project.create')` → `403 forbidden`.
3. The service receives the `TenantContext` and builds an `OrganizationScope` with `scopeOf`; repositories take the scope first.

**Project-addressed routes** (`/projects/:projectId/...`), implemented by an application service `ProjectAccess.resolve(principal,
projectId, permission)` that a guard calls:

1. `projectId` is validated as a UUID; otherwise `404 project_not_found` (same as unknown).
2. `organizationIds = MembershipDirectory.organizationIdsOf(principal.userId)`. If empty: `404`, no query.
3. **One** query: `SELECT … FROM projects.project WHERE id = $1 AND organization_id IN (…)` (ADR-0010 decision 4.3). No row means
   `404 project_not_found` whether the project does not exist or belongs to an organization the caller is not in.
4. `TenantAccess.resolve(principal, project.organizationId)` yields the authoritative role (a membership that ended between steps 2 and
   4 is a 404).
5. The explicit project role is read only when the organization role does not already grant implicit access (`owner`/`admin`).
6. `permissions = permissionsFor(role, projectRole)`. If `project.read` is missing: `404 project_not_found` (**visibility follows
   access**). If it is present but the route's permission is missing: `403 forbidden`.
7. The guard attaches a `ProjectContext` (tenant, project id, explicit role, effective permissions); handlers and services never see the
   raw ids as authority.

**Mutations re-run steps 4 to 6 inside the transaction** after taking the project row lock (decision 9), exactly as 2.2 does for
memberships, so a demotion or removal that committed a moment ago applies to the request that is already in flight.

**Failure semantics:**

| Situation                                                                    | Answer                              |
| ---------------------------------------------------------------------------- | ----------------------------------- |
| Not authenticated                                                            | `401 unauthenticated`               |
| Project does not exist                                                       | `404 project_not_found`             |
| Project belongs to another organization                                      | `404 project_not_found` (identical) |
| Caller is not a member of the project's organization                         | `404 project_not_found` (identical) |
| Caller is a `member`/`viewer` of the organization with no project membership | `404 project_not_found` (identical) |
| Caller has access but lacks the permission                                   | `403 forbidden`                     |
| Organization selector (list/create) is not one the caller belongs to         | `404 organization_not_found`        |
| Project is archived and the action is a change                               | `409 project_archived`              |

**Scope objects.** `OrganizationScope` (existing) guards organization-level queries (list, create, slug conflicts). A new
`ProjectScope` (class with a private constructor, built only by `projectScopeOf(projectContext)`) carries the organization scope and the
project id and is the required first parameter of every project-scoped repository method (`update`, `archive`, `restore`, `lockProject`,
every member method). A missing, forged-shaped or malformed scope throws before any query (the 2.2 `requireScope` pattern, proven by a
unit test over every method that fails when a method is added without being listed). Every statement filters by **both** `id` and
`organization_id` (members: `project_id` and `organization_id`). The single exception is the id-only resolution of step 3, a
clearly named method that takes an explicit, non-empty list of organization ids and returns nothing for an empty or malformed list.

**What this prevents, and the compensating controls where it does not fully:**

| Threat                                   | Control                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-organization project access / IDOR | Step 3's single `IN (caller's organizations)` query; every later query also filters by organization; identical 404 for missing and foreign.                                                                                                                                         |
| Cross-organization project membership    | Composite foreign keys (decision 7): impossible in the data, not only in code.                                                                                                                                                                                                      |
| Project role escalation                  | Typed catalog (project roles cannot hold organization keys); property test; role changes need `project.member.manage` on that project.                                                                                                                                              |
| Manipulated route parameters             | `:projectId` is only a lookup key resolved against the caller's organizations; `:userId` is looked up inside `(project, organization)`; the body `organizationId` of `POST /projects` is a selector validated by `TenantAccess`; no contract accepts an `organizationId` on update. |
| Accidental unscoped repository queries   | Required scope objects, the "all methods listed" unit test, no raw SQL outside repositories, and PostgreSQL privileges (decision 7). In-process forgery of a well-formed scope remains possible (finding F4); review and the cross-tenant test matrix are the remaining control.    |
| Moving a project to another organization | Not in any contract; the application role has no `UPDATE` on `project.organization_id` (decision 7).                                                                                                                                                                                |
| Enumeration of projects or members       | Lists contain only what the caller can access; every non-access answer is the same 404; project member lists require `project.read`.                                                                                                                                                |

### 6. API

All under `/api/v1`, errors in the `ApiError` shape, documented with the zod-to-OpenAPI helpers, lists with `paginationQuerySchema` /
`paginatedSchema`. Lists use a fixed stable order (`created_at`, then `id`) like 2.2, so paging never repeats or skips a row.

New contracts (`packages/contracts/src/projects.ts`): `projectSchema` (`id`, `organizationId`, `name`, `slug`, `description` or `null`,
`status`, `archivedAt` or `null`, `createdAt`, `updatedAt`, `projectRole`: the caller's **explicit** role or `null`),
`createProjectRequestSchema` (`organizationId`, `name`, `slug`, optional `description`), `updateProjectRequestSchema` (optional `name`,
optional `description` where `null` clears it; at least one field), `listProjectsQuerySchema` (`organizationId`, `status`:
`active` default | `archived` | `all`, plus pagination), `projectMemberSchema` (`userId`, `email`, `displayName`, `role`, `joinedAt`),
`addProjectMemberRequestSchema` (`userId`, `projectRole`), `updateProjectMemberRequestSchema` (`projectRole`), and
`PROJECT_ERROR_CODES`.

| Method and route                              | Permission (scope)                        | Request                                          | Success                             | Errors                                                                                                                      | Audit events                                                           |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /projects?organizationId=…`              | `project.list` (organization, selector)   | query                                            | `200 Paginated<Project>`            | 400, 401, 403, 404 `organization_not_found`                                                                                 | none                                                                   |
| `POST /projects`                              | `project.create` (organization, selector) | `organizationId`, `name`, `slug`, `description?` | `201 Project`                       | 400, 401, 403, 404 `organization_not_found`, 409 `project_slug_taken`                                                       | `project.created`, `project_member.added` (creator as `project_admin`) |
| `GET /projects/:projectId`                    | `project.read` (project)                  | -                                                | `200 Project`                       | 401, 404 `project_not_found`                                                                                                | none                                                                   |
| `PATCH /projects/:projectId`                  | `project.update` (project)                | `name?`, `description?`                          | `200 Project`                       | 400, 401, 403, 404, 409 `project_archived`                                                                                  | `project.updated` (only if something changed)                          |
| `POST /projects/:projectId/archive`           | `project.archive` (project)               | -                                                | `200 Project` (idempotent)          | 401, 403, 404                                                                                                               | `project.archived` (only on a real change)                             |
| `POST /projects/:projectId/restore`           | `project.archive` (project)               | -                                                | `200 Project` (idempotent)          | 401, 403, 404                                                                                                               | `project.restored` (only on a real change)                             |
| `GET /projects/:projectId/members`            | `project.read` (project)                  | pagination query                                 | `200 Paginated<ProjectMember>`      | 400, 401, 404                                                                                                               | none                                                                   |
| `POST /projects/:projectId/members`           | `project.member.manage` (project)         | `userId`, `projectRole`                          | `201 ProjectMember`                 | 400, 401, 403, 404 `project_not_found` / `organization_member_not_found`, 409 `already_project_member` / `project_archived` | `project_member.added`                                                 |
| `PATCH /projects/:projectId/members/:userId`  | `project.member.manage` (project)         | `projectRole`                                    | `200 ProjectMember` (no-op allowed) | 400, 401, 403, 404 `project_member_not_found`, 409 `project_archived`                                                       | `project_member.role_changed` (only if the role changed)               |
| `DELETE /projects/:projectId/members/:userId` | `project.member.manage` (project)         | -                                                | `204`                               | 400, 401, 403, 404 `project_member_not_found`, 409 `project_archived`                                                       | `project_member.removed`                                               |

Notes. The target of `POST …/members` is identified by **`userId`**, not by email: the caller picks from the organization member list
(visible to every organization member), and an unknown id or a user outside the organization both answer `404
organization_member_not_found`, so the endpoint is not an email-existence oracle (the limitation 2.2 accepted for organization invitations
by email, ADR-0010 note 32, is not repeated; Q4). No registration, invitation or email flow is added. `projectRole` is the caller's
explicit role and is `null` for owners/admins who act through implicit access. `Project` responses never contain organization member data.

### 7. Database and Prisma

New PostgreSQL schema **`projects`** (ADR-0010 decision 7), new Prisma file `projects.prisma`, `schemas = ["identity", "projects", "security"]`
in `base.prisma`. Verified on a **scratch copy outside the repository** (Prisma 6.19.3, no database, nothing applied): `prisma validate`
passes and `migrate diff` emits `CREATE SCHEMA IF NOT EXISTS "projects"`, both enums, both tables, all indexes, and **both composite
foreign keys** (one into `projects.project`, one across schemas into `identity.membership`).

```text
projects.project
  id uuid PK, organization_id uuid NOT NULL -> identity.organization(id) RESTRICT,
  name text, slug text, description text NULL, status projects.project_status DEFAULT 'active',
  archived_at timestamptz NULL, created_at, updated_at
  UNIQUE (organization_id, slug)        -- organization-scoped slug
  UNIQUE (id, organization_id)          -- target of the composite foreign key (redundant with the PK, but required)
  INDEX  (organization_id, status, created_at, id)   -- the list query
  CHECK  slug_valid, name_valid, description_valid, archive_state

projects.project_member
  id uuid PK, project_id uuid, organization_id uuid, user_id uuid, role projects.project_role NOT NULL, created_at, updated_at
  FOREIGN KEY (project_id, organization_id) -> projects.project(id, organization_id) RESTRICT
  FOREIGN KEY (organization_id, user_id)    -> identity.membership(organization_id, user_id) RESTRICT
  UNIQUE (project_id, user_id)
  INDEX  (organization_id, user_id), (user_id)
```

**Why composite foreign keys earn their complexity (the concrete benefit):** `project_member.organization_id` is a denormalized copy,
but the two foreign keys force it to equal the project's organization **and** to be an organization the user is a member of. Cross-
organization membership, an orphan after an organization membership ends, and a membership for a user who was never in the organization
are all impossible in the data, independent of application bugs. The referenced columns already have a unique constraint in
`identity.membership`. No other table in this step uses a composite key.

**Constraints:** `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 48` (lower-case is enforced, so a plain unique
index is case-safe, no `citext`); `char_length(btrim(name)) >= 1 AND char_length(name) <= 100`; `description IS NULL OR char_length(description) <= 2000`;
`(status = 'archived') = (archived_at IS NOT NULL)`. `ON UPDATE CASCADE` (Prisma's default) is irrelevant because identifiers are never updated; it can be set
to `Restrict` in the schema.

**Privileges (least privilege, exact-grants test updated).** `USAGE ON SCHEMA projects`; on `project`: `SELECT`, `INSERT` and **column-level
`UPDATE (name, description, status, archived_at, updated_at)`**; on `project_member`: `SELECT`, `INSERT`, `DELETE` and
`UPDATE (role, updated_at)`. No `DELETE` on `project`. Consequences: the API role **cannot** change `organization_id`, `slug`, `id` or
`created_at` of a project, or the project/user/organization of a membership, whatever the application code does; "never transferred
implicitly" and "slug immutable" become database facts. `SELECT … FOR UPDATE` (decision 9) needs `UPDATE` on at least one column and is
covered. **Verified in a throwaway database with the real roles (not in the repository):** `SELECT … FOR UPDATE` succeeds with
column-level `UPDATE` only; updating a granted column succeeds; updating `organization_id` or `slug`, and `DELETE`, are denied.
Prisma's `update` sets only the columns it is given (plus `updated_at`), so the code is unaffected; step S3 confirms that against the
real client and adjusts the column list if it does not hold (Q6).

**Migration plan.** Two new migration directories (applied migrations are never edited): `projects_tables` (generated: schema, enums,
tables, indexes, foreign keys) and `projects_privileges_and_constraints` (hand-written: `agentos_app` guard as before, grants, CHECK
constraints). Purely additive: no existing table is altered, so existing data is untouched and no Docker volume needs to be recreated.
The migration role already holds `CREATE` on the database (`roles.sql`), which creating the schema needs; production must grant the same
(documented since 2.1). `identity.prisma` is not changed; `organizations.prisma` gains two back-relation fields (additive, same as 2.2).
The Compose `migrate` service applies it with `prisma migrate deploy` as the migration role; the system test that asserts table owners
must include the `projects` schema.

### 8. Audit

Typed events in `packages/contracts/src/audit.ts`, strict metadata (ids, enum values, field names; never user-entered text such as names,
slugs or descriptions). All are `result: success` and are written with `AuditRecorder.record(event, tx)` **in the same transaction as
the change**: an audit failure rolls the change back (the 2.2 pattern, tested with a failing store).

| Event                         | `resourceType`   | `resourceId`  | Metadata                                                                   | When                                                          |
| ----------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `project.created`             | `project`        | project id    | none                                                                       | creation                                                      |
| `project.updated`             | `project`        | project id    | `changedFields`: `name` and/or `description`                               | only if a value changed                                       |
| `project.archived`            | `project`        | project id    | none                                                                       | state actually changed                                        |
| `project.restored`            | `project`        | project id    | none                                                                       | state actually changed                                        |
| `project_member.added`        | `project_member` | membership id | `userId`, `role`                                                           | add, and for the creator at project creation                  |
| `project_member.role_changed` | `project_member` | membership id | `userId`, `previousRole`, `role`                                           | only if the role changed                                      |
| `project_member.removed`      | `project_member` | membership id | `userId`, `role`, `reason`: `removed` \| `organization_membership_removed` | removal; one per project when an organization membership ends |

Every event carries `actorUserId` (the person who acted; for the end of an organization membership, the person who removed the member
or the member who left), `organizationId` and `projectId`. `project_id` and `organization_id` columns already exist on `audit_log`; no
audit migration is needed. Events of one transaction share `occurred_at` and have no defined order (2.2 note 30).

**Rejected authorization attempts are not audited**, preserving the 2.2 policy (note 31): the catalog records successful state
changes; refusals leave the `ApiError` response and the request log. There is no compelling reason to change this in this step. If
refused project-role escalation attempts should be auditable, that is a new catalog entry and a separate decision.

### 9. Concurrency and security

PostgreSQL constraints and transactions only; no Redis, no advisory or distributed locks. Default `READ COMMITTED`.

**One lock for the project invariants.** Every _change_ to a project or its members (update, archive, restore, add, re-role, remove)
starts its transaction with `SELECT … FROM projects.project WHERE id = $1 AND organization_id = $2 FOR UPDATE` (`lockProject(scope)`),
which returns the fresh row, then re-resolves the actor (decision 5), then acts. Changes to one project therefore run one after another;
changes to different projects do not interact. This is cheap (project changes are rare) and is what makes the archived-project rule
race-free. No ownership-style owner lock is needed here (decision 3: there is no last-project-admin invariant).

| Case                                                                   | Outcome and mechanism                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two users create the same slug in one organization                     | `UNIQUE (organization_id, slug)`: exactly one `201`, the others `409 project_slug_taken` (the constraint, not a check-then-insert). The same slug in **different** organizations always succeeds. The creator's membership insert is in the same transaction, so a lost race leaves nothing.                                                                                         |
| Concurrent adds of the same member                                     | Project lock plus `UNIQUE (project_id, user_id)`: one `201`, the rest `409 already_project_member`.                                                                                                                                                                                                                                                                                  |
| Concurrent role changes of one member                                  | Serialized by the project lock; the last committed request wins, each audited with the role it actually replaced.                                                                                                                                                                                                                                                                    |
| Concurrent removals of one member                                      | Serialized: one `204`, the rest `404 project_member_not_found`.                                                                                                                                                                                                                                                                                                                      |
| Archive while another request changes membership                       | Serialized by the project lock. The later one re-reads the status inside the lock: add/re-role/remove after an archive answer `409 project_archived`; an archive after an add succeeds. A member can therefore never be added to an already-archived project.                                                                                                                        |
| Organization membership revoked while the user has project memberships | Decision 3: removed in the same transaction (reason `organization_membership_removed`). Meanwhile every request re-checks organization membership first, so access stops at once even before the rows go. The foreign key makes an orphan row impossible.                                                                                                                            |
| An add of that user to a project races the organization removal        | The insert takes a `FOR KEY SHARE` lock on the referenced organization membership through the foreign key. Either the removal wins (the insert fails the foreign key → `404 organization_member_not_found`) or the insert commits first and the removal's final `DELETE` fails `RESTRICT` and is reported as a retryable `409` (not a `500`). Never an orphan. To be proven by test. |
| Owner/admin access after an organization role change                   | Implicit access is derived from the membership row on every request. A mutation in flight re-reads the role inside its transaction after the project lock, so a demotion that committed first applies. Reads see at most one request of staleness.                                                                                                                                   |
| Adding a user who is not an organization member                        | Pre-check gives `404 organization_member_not_found`; the composite foreign key is the guarantee if the pre-check races a removal.                                                                                                                                                                                                                                                    |

Lock ordering is fixed to avoid deadlocks: organization-level locks (2.2's owner rows) are taken before project-level ones, and the
removal participant only deletes `project_member` rows without taking project locks. The one blocking interaction (a unique-index wait on
a row the removal deleted) was reasoned through to a clean `404`/`409` and is part of the concurrency test plan.

### 10. Testing strategy

Follows the existing conventions: unit tests beside the code; integration tests (`*.int.spec.ts`) against **real PostgreSQL and Redis**
with a throwaway database, the real migrations and the API connecting as the non-superuser role; system tests through the real Compose
stack. Mock-only tests are used only for pure rules; everything that is a guarantee is also proven against PostgreSQL.

**Unit**

- Domain rules: slug and name validation, the lifecycle (archive/restore idempotence, archived is read-only), the member-change rules.
- `permissionsFor(organizationRole, projectRole | null)`: a table-driven test over **every** organization role × every project role and
  none × every permission against one independently written expected table (the matrix above); a property test that the decision on an
  organization-scoped permission equals the organization role's own decision for every combination; a type-level test that a project
  role cannot be given an organization key.
- Scope validation: `ProjectScope` and `OrganizationScope` reject missing, forged-shaped and malformed values for **every** project
  repository method without touching the database, and the test fails if a scoped method is added without being listed.
- The guard: no declared permission → refused; non-member / no access → 404; lacking permission → 403.

**Integration (real PostgreSQL)**

- Constraints: slug format/length, name, description, archive-state CHECKs; `UNIQUE (organization_id, slug)` incl. archived; both
  composite foreign keys (cross-organization membership, non-member, orphan after an organization membership delete) and `RESTRICT`
  everywhere; privileges: exact-grants list incl. column privileges, no `DELETE` on `project`, `UPDATE` of `organization_id`, `slug` or a
  membership's user denied as the API role, `FOR UPDATE` allowed.
- Lifecycle: create (creator becomes `project_admin`), update, archive/restore (idempotent, audited once), member add/re-role/remove, the
  archived-project rules, list filtering by status and by access, pagination stability.
- **Tenant isolation matrix** (ADR-0010 4.4a): every project route as a member of another organization, as a user in no organization and
  unauthenticated → `404 project_not_found` / `404 organization_not_found` / `401`, with no data in the body and no side effect.
- Access policy: every route for org owner, admin, member and viewer **with and without** a project row, each project role, and a
  non-member, against the expected statuses (ADR-0010 5(c)); implicit owner/admin access without a row; demotion and removal taking
  effect on the very next request.
- Audit: events and metadata per operation; **atomicity** with a failing audit store (nothing persists); no secret or user-entered text
  in the trail.
- Removal participant: removing/leaving an organization removes the user's project memberships and audits each; archived projects too.
- **Concurrency** (real concurrent HTTP requests, repeated rounds): same-slug creation (one winner; different organizations both win),
  duplicate adds, concurrent re-roles, concurrent removals, archive versus add (never a member on an archived project), organization
  removal versus project add (never an orphan; statuses within the documented set). **Each guarantee is proven to fail** by removing the
  mechanism (the project lock, the unique constraint, the participant, a composite foreign key) in a mutation check, as in 2.2.
- Route metadata: the existing test is extended so every `/projects` route is permission-gated or on the account-scoped list, and pins the
  permission of each.

**System (Compose stack, API level)**

- The migration role creates the `projects` schema and tables; the API role has exactly the granted privileges (extends the existing
  ownership/privilege system test).
- Workflow: register → create organization → create project → add an organization member to it → archive and restore; unauthorized
  access (a user outside the project, a member with no row); cross-tenant attempts from a second organization; an organization role
  change (admin → member, removal) changing project access on the next request.

### 11. Phase boundary

**In Phase 2.3:** the `projects` module and its two tables, project and project-member lifecycle and endpoints, project roles and
project-scoped permissions, the additive `organizations` surface (decision 1), the removal participant, audit events, contracts, tests,
and documentation (this ADR's implementation notes, `backend.md`, README, `CLAUDE.md`).

**Deferred (not in 2.3, and not prepared with placeholders):** tasks or work items; agent execution; repository connections; MCP
integrations; project-level API keys; invitations and email verification; billing and quotas (no limit on projects per organization);
project templates; project transfer between organizations; permanent deletion and organization deletion; a project-member self-leave;
free-form project metadata; the web slice, the browser-level system scenario and ADR finalization (**Phase 2.4**); an audit reader.

### 12. Implementation plan (small, reviewable steps)

Each step ends with `pnpm verify` and, where it touches PostgreSQL, `pnpm test:integration`; commits are unprefixed.

| Step | Content                                                                                                                                                                                                                                                        | Review focus                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| S1   | Contracts: `ProjectRole`, new permission keys and the union-typed catalog, `projects.ts`, project audit events; matrix and contract tests.                                                                                                                     | The matrix and the typing guarantee.                 |
| S2   | `organizations` additive amendment: `permissionsFor(role, projectRole)`, `AuthorizationService` project methods, `MembershipLifecycle` registry and its call in `MembershipService.remove`, exports; tests for the hook (no participant = unchanged behavior). | That 2.2 behavior is unchanged; the seam is minimal. |
| S3   | Database: `projects.prisma`, `base.prisma`, back-relations, the two migrations, privileges and constraint tests against real PostgreSQL (incl. the column-privilege and composite-FK verification).                                                            | Migration safety, grants, the integrity guarantees.  |
| S4   | `projects` module, part 1: domain, repositories with scopes, `ProjectAccess`, guard, project endpoints (list, create, get, update, archive, restore), tests including the isolation matrix and slug race.                                                      | Authorization flow and 404/403 semantics.            |
| S5   | `projects` module, part 2: member endpoints, the removal participant registration, concurrency tests with mutation checks, audit atomicity tests, route-metadata update.                                                                                       | Concurrency and the organization-membership seam.    |
| S6   | System test (API level), documentation, ADR implementation notes; this ADR moves to `Accepted` with the notes (as ADR-0010 did).                                                                                                                               | Docs and the end-to-end proof.                       |

The steps are internal commits of one pull request; the natural review checkpoints are after S3 (data model) and at the end.

## Open questions requiring explicit approval

| #   | Question                                                                                                                                             | Recommendation                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What happens to project memberships when an organization membership ends (finding F1)?                                                               | Option D: composite foreign key `RESTRICT` plus a removal participant registered by `projects`, in the same transaction, audited.                                   |
| Q2  | May `organizations` be amended **additively** (project-aware `permissionsFor`/`AuthorizationService`, the lifecycle registry, back-relation fields)? | Yes. It is what ADR-0010 decision 5 prescribes for the matrix and the only way to satisfy Q1 without a cascade or a dependency cycle. Behavior unchanged.           |
| Q3  | May an organization `viewer` hold `project_admin` and so write to one project (the ADR's union rule)? Or cap project roles by organization role?     | Keep the union exactly as ADR-0010 states, and document it. A cap would be a new rule (for example "a viewer can only be `project_viewer`"); say so if you want it. |
| Q4  | Add project members by `userId` (not email)?                                                                                                         | Yes: no email-existence oracle, and the picker is the organization member list.                                                                                     |
| Q5  | Can a project member remove themselves from a project in this step?                                                                                  | No (deferred): a project admin or an owner/admin removes them. Smaller surface; revisit with the web slice.                                                         |
| Q6  | Column-level `UPDATE` privileges for `agentos_app` so `organization_id`, `slug`, ids and membership identity are immutable at the database?          | Yes, subject to the S3 verification that `SELECT … FOR UPDATE` and Prisma updates work with them; fall back to table-level `UPDATE` plus tests if not.              |
| Q7  | New key `project.list` rather than reusing `organization.read` for the list route?                                                                   | New key: the catalog then says what the route does, at no cost.                                                                                                     |
| Q8  | Allow the `projects → identity` edge to include `UserDirectory.findByIds` (ADR-0010's diagram says "Principal only")?                                | Yes; the alternative is a duplicate user-lookup surface.                                                                                                            |
| Q9  | Optional hardening for finding F4: an architecture test that only the access classes may call `scopeOf` / build a scope?                             | Yes, as a small test in S4, since the scope is the main tenant control. It is a test, not new production code.                                                      |
| Q10 | Include a small API-level system test in 2.3 although ADR-0010 puts the system scenario in 2.4?                                                      | Yes: a new PostgreSQL schema and grants are exercised only by the Compose stack. The browser-level scenario stays in 2.4.                                           |
| Q11 | Must the creator always get an explicit `project_admin` row, even if they are an organization owner/admin (who already have implicit access)?        | Yes (ADR-0010 decision 5, point 4): it records the creator and gives them access that survives a later demotion.                                                    |
| Q12 | Are idempotent archive/restore (200, no event) acceptable, versus `409` for a repeated transition?                                                   | Idempotent, matching 2.2's "no change, no audit".                                                                                                                   |

## Risks, accepted trade-offs and deferred items

- **Per-project serialization.** Every change to a project or its members takes one row lock. Acceptable at this write rate; if projects
  ever receive heavy concurrent writes the lock granularity would be revisited.
- **A new seam in `organizations`** (the removal participant registry) is the price of keeping the dependency direction and the audit
  completeness; the foreign key guarantees correctness even if the seam is misused.
- **Union privilege (Q3):** a person with a low organization role can administer one project; this is the accepted ADR rule and is made
  visible in the matrix and the tests.
- **Application-enforced tenancy** remains (no RLS); a scope is not unforgeable (F4). The cross-tenant matrix, the required scopes and
  the database constraints/privileges are the controls.
- **Stale reads:** a read in flight can use a role that changed a moment ago; mutations re-check inside their transaction.
- **Archived slugs stay reserved forever** (no deletion); acceptable and consistent with deferred deletion.
- **No quotas:** any member who may create projects can create many.
- **Refusals are not audited** (consistent with 2.2).
- **Deferred:** everything listed in decision 11, plus a project audit reader and the retention policy of ADR-0010.

## Alternatives considered

- **Slug unique globally:** rejected; ADR-0010 states organization scope and a global namespace would leak names across tenants.
- **Mutable slug:** rejected for this step; it needs a redirect/alias and conflict policy.
- **Project role stored on the organization membership:** rejected; a project role is per project and must not touch organization data.
- **A `project_member` without the denormalized `organization_id`:** rejected; without it the database cannot prove that the project and
  the organization membership belong to the same organization.
- **Checking membership only in the application:** rejected for rule 4/5; a bug or a race would leave an unrecoverable cross-tenant row.
- **Inert rows, cascade or a blocking foreign key for F1:** see decision 3.
- **`organizationId` in the path (`/organizations/:id/projects`):** it would let the 2.2 guard be reused, but it departs from the API of
  ADR-0010 section 8 and the specification's paths; kept as the ADR states, with the selector validated by `TenantAccess`.
- **Free-form `metadata` jsonb on the project:** rejected; no consumer, unvalidated data.
