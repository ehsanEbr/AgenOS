# ADR-0011: Projects and project members (Phase 2.3)

**Status:** Proposed. Revision 2 of the design was approved in principle and has been **implemented in step 2.3** on the branch
`phase-2.3-projects-project-members`; the implementation is awaiting review, so this ADR is **not** yet Accepted. See "Implementation
status (step 2.3)" at the end for what was built, what was found and what differs from the text.
**Context:** [ADR-0010](0010-identity-organizations-projects.md) (Accepted) fixed the architecture of Phase 2 and delivers it in four
reviewed steps. Steps 2.1 (identity, authentication, sessions, audit) and 2.2 (organizations, memberships, tenant isolation,
authorization) are merged (`main` at `7db426f`). This ADR designs step 2.3: the `projects` module, its two tables, its API and its
tests. It was written against the actual repository, not against summaries; where the repository differs from ADR-0010 or leaves a
gap, that is reported under "Findings" and decided or asked, never changed silently.

**Relationship to ADR-0010.** Nothing in ADR-0010 is reopened. This ADR _applies_ decisions 1 (modules), 4 (tenant isolation), 5
(authorization and the project access policy), 6 (audit), 7 (Prisma) and 8 (API), and final decisions 1 (archive/restore, no
deletion) and 8 (project roles and default access). Three **additive** amendments to ADR-0010 are needed and are stated exactly in
"Amendments to ADR-0010"; they will be recorded as ADR-0010 implementation notes when the step is implemented, and ADR-0010 is not
edited now.

## What revision 2 settles

The review of revision 1 approved the design in principle and decided the following. Each is incorporated where shown.

| #   | Decision of the review                                                                                                                                                                              | Where             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Ending an organization membership also ends the user's project memberships in that organization; composite foreign key `RESTRICT`; a removal participant registered by `projects`; one transaction. | Decision 3        |
| 2   | Lock ordering across both modules is mandatory and must make it impossible to create or keep a project membership after the organization membership is gone.                                        | Decision 9        |
| 3   | The union rule: effective project permissions = organization permissions ∪ project permissions, confined to the one authorized project.                                                             | Decision 4        |
| 4   | `project.list` returns only projects the caller can access.                                                                                                                                         | Decision 6        |
| 5   | `projects` may use `UserDirectory` through its public interface.                                                                                                                                    | Decision 1        |
| 6   | An architecture test restricts where scopes may be constructed; repositories require validated scopes.                                                                                              | Decision 5        |
| 7   | The creator gets an explicit `project_admin` row in the same transaction as the project; the audit semantics are fixed.                                                                             | Decisions 3 and 8 |
| 8   | Archive and restore are idempotent, with no duplicate state-change events.                                                                                                                          | Decisions 2 and 6 |

## Evidence gathered for this design

Everything below was checked against the real toolchain (Prisma 6.19.3, the repository's PostgreSQL 17 image, the real roles
`agentos_migrate` and `agentos_api`) in **throwaway databases outside the repository, dropped afterwards**. Nothing in the repository
was changed and no migration was created.

| #   | Question                                                                                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Does Prisma generate the schema and the two composite foreign keys, across schemas?                                                                        | Yes: `CREATE SCHEMA projects`, both enums, both tables, and foreign keys `(project_id, organization_id)` and `(organization_id, user_id)` into `identity.membership`. `prisma validate` passes.                                                                                                                                                                                                            |
| E2  | Does column-level `UPDATE` work together with `SELECT … FOR UPDATE`?                                                                                       | Yes. `FOR UPDATE` succeeds with column-level `UPDATE` only; updating `organization_id` or `slug` and `DELETE` are denied.                                                                                                                                                                                                                                                                                  |
| E3  | Add holds the membership first, removal arrives second.                                                                                                    | The removal **blocks** until the add commits, then sees the new row, cleans it up and deletes the membership. No foreign-key error.                                                                                                                                                                                                                                                                        |
| E4  | Removal holds the membership first, add arrives second.                                                                                                    | The add **blocks** until the removal commits, then finds no membership: a clean "not a member", nothing inserted.                                                                                                                                                                                                                                                                                          |
| E5  | Same race **without** the hold.                                                                                                                            | The cleanup cannot see the uncommitted row; the membership delete waits on the insert's foreign-key lock and then fails with `23503` (`RESTRICT`). So the foreign key is a correct backstop, but the hold is what turns that failure into a clean outcome.                                                                                                                                                 |
| E6  | Lock compatibility.                                                                                                                                        | A non-key `UPDATE` of `membership.role` does **not** block a project-member insert (the foreign-key check takes `FOR KEY SHARE`); a `FOR SHARE` hold **does** conflict with it.                                                                                                                                                                                                                            |
| E7  | Stress: 12 connections, 5,760 mixed transactions per variant (organization remove/add/re-role/rename, project-member add/change, archive, create-project). | **Variant V0** (the protocol first drafted: owner-row mutex plus a hold on actor and target): **6 deadlocks (`40P01`)**. **V1** (2.2's owner-row lock plus a hold on the target only): **0 errors**. **V2** (one lock row per organization plus holds on actor and target): **0 errors**. **V3** (no holds): 50 spurious `23503` failures. Orphan rows: 0 in every variant (the foreign key always holds). |

E7 is why decision 9 is written the way it is: the obvious protocol deadlocks, because the owner lock of 2.2 is itself a set of
membership rows and the project side locked membership rows in a different order.

## Findings in the current repository

Reported, not fixed (this phase is design only and must not change Phase 2.1/2.2 behavior).

| #   | Finding                                                                                                                                                                                                                                                                                                                                                 | Consequence for this design                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Removing a user from an organization knows nothing about projects.** ADR-0010 says a demotion "removes that access on the next request" for owner/admin, but is silent on what happens to a user's `project_member` rows when their _organization membership_ ends. Implemented 2.2 simply deletes the `membership` row.                              | A real gap. Closed by decision 3 (approved), which needs additive changes to `organizations`.                                                                                                                                                  |
| F2  | **`OrganizationAccessGuard`, `@RequirePermission` and `@CurrentTenant` are private to `organizations`**, and the guard resolves only a `:organizationId` path parameter.                                                                                                                                                                                | `/projects/:projectId` and `/projects?organizationId=` cannot reuse it. `projects` gets its own access service and guard on the public `TenantAccess`, `AuthorizationService` and `MembershipDirectory`.                                       |
| F3  | **`permissionsFor(organizationRole, projectRole)` does not exist yet** (2.2 has the single-role version, unexported), as ADR-0010 decision 5 anticipates.                                                                                                                                                                                               | Additive change to `organizations`.                                                                                                                                                                                                            |
| F4  | **`OrganizationScope` is opaque by convention only.** The constructor is private but `OrganizationScope.of(id)` is public and `scopeOf` accepts any `TenantContext`-shaped object. The scope fails closed on a missing or malformed id (proven by tests); it cannot stop in-process code from building a scope for the wrong, well-formed organization. | Inherent to application-enforced tenancy. Decision 5 adds an architecture test that pins every place a scope may be built, and makes `ProjectContext` a class that only `ProjectAccess` creates. No claim is made that a scope is unforgeable. |
| F5  | ~~ADR-0010's diagram says `projects → identity (Principal only)`.~~ **Resolved by the review:** `projects` also uses `UserDirectory.findByIds` through its public interface.                                                                                                                                                                            | Recorded as an additive amendment.                                                                                                                                                                                                             |
| F6  | **Nothing in the data prevents an orphaned or cross-organization project membership**, because the tables do not exist yet; ADR-0010 states the rule but puts it only in `projects`.                                                                                                                                                                    | Decision 7: composite foreign keys.                                                                                                                                                                                                            |
| F7  | **The audit contract and table already carry `projectId`** (`common.projectId`, column `project_id`).                                                                                                                                                                                                                                                   | No change to `audit` or its migration; only new event schemas in `packages/contracts`.                                                                                                                                                         |
| F8  | **ADR-0010 assigns the end-to-end system scenario to step 2.4.**                                                                                                                                                                                                                                                                                        | A small API-level system test is proposed in 2.3 because only the Compose stack exercises a new PostgreSQL schema created by the migration role (Q10).                                                                                         |
| F9  | **2.2's owner lock is a set of membership rows** (`lockOwners` locks the owner memberships `ORDER BY id`). Any other code that locks membership rows in another order can deadlock with it.                                                                                                                                                             | Found by the stress test (E7, V0). Decision 9 fixes the order and limits project-side code to **one** membership row.                                                                                                                          |

## Decisions

### 1. Module boundaries and ownership

`modules/projects` is a new layered module (`domain/`, `application/`, `infrastructure/`, `presentation/`, public `index.ts`), the third
domain module in the chain `projects → organizations → identity → audit`. It owns `projects.project` and `projects.project_member` and
nothing else.

| Responsibility                                            | Owner                         | How `projects` obtains it                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who the caller is (`Principal`, authentication, sessions) | `identity`                    | `CurrentPrincipal`, `Principal` from `modules/identity` (the global `AuthenticationGuard` has already run). No access to `identity` tables or repositories. |
| Display data of a user (email, display name)              | `identity`                    | `UserDirectory.findByIds` through `modules/identity/index.ts` only (approved). No import of Identity infrastructure, repositories or Prisma models.         |
| Is the caller a member of organization X, with what role  | `organizations`               | `TenantAccess.resolve(principal, organizationId)` → `TenantContext`; `MembershipDirectory.organizationIdsOf`. Read from the database on every request.      |
| Does a role hold a permission (the matrix)                | `organizations` (+ contracts) | `AuthorizationService` (extended additively, decision 4). `projects` never re-implements the matrix.                                                        |
| Projects, project members, project roles, their rules     | `projects`                    | Own repositories; no Prisma model of another module is ever imported or `include`d.                                                                         |
| The end of an organization membership                     | `organizations` (workflow)    | `organizations` runs the removal and calls registered participants; `projects` owns the deletion of its own `project_member` rows (decision 3).             |
| Audit recording                                           | `audit`                       | `AuditRecorder.record(event, tx)` with typed events from `packages/contracts`.                                                                              |
| Transactions                                              | application services          | `TransactionRunner`; repositories take `tx`.                                                                                                                |

**Dependency edges added:** `projects → organizations`, `projects → identity`, `projects → audit`, `projects → database`. **No edge
points at `projects`** and no cycle exists (`tools/check-module-boundaries.mjs` enforces both). The one place where `organizations` must
react to something `projects` owns (decision 3) is solved by **inversion**: `organizations` defines and exports an interface and a
registry; `projects` imports them and registers an implementation. The import still points `projects → organizations`.

`projects` exports through `index.ts` only `ProjectsModule`. ADR-0010's `ProjectAccess` public contract waits for its first consumer
(Agent Runtime), as that ADR decided; internally the module has a `ProjectAccess` application service that its guard uses.

**Additive surface in `organizations` (approved in principle, exact list).** No existing behavior changes when no participant is
registered and no project membership exists:

1. `permissionsFor(organizationRole, projectRole | null)` and `AuthorizationService.permissionsOn(tenant, projectRole)` /
   `authorizeOnProject(tenant, projectRole, ...permissions)`, exported.
2. `MembershipLifecycle` (registry), `MembershipRemovalParticipant` and `MembershipRemoval` (types), exported (decision 3).
3. `MembershipDirectory.holdMember(organizationId, userId, tx): Promise<boolean>`: a `SELECT … FOR SHARE` on that organization
   membership row, which keeps it from being removed or re-roled until the transaction ends (decision 9). The membership table stays
   private to `organizations`; `projects` only calls this method.
4. In `MembershipService.remove`: the subject's membership row is read with `FOR UPDATE` instead of plainly (new repository method
   `lockMember`), the registered participants are invoked before the delete, and a foreign-key violation on the final delete is
   reported as `409 membership_in_use` (new code in `ORGANIZATION_ERROR_CODES`).
5. Back-relation fields on the `Organization` and `Membership` Prisma models (Prisma needs both ends of a relation; 2.2 did the same
   to `identity.prisma`). `organizations` never reads them.

### 2. Project model

A project belongs to **exactly one organization**, fixed at creation.

| Field                      | Decision                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | UUID primary key. Projects are addressed by id (`/projects/:projectId`); the slug is never an authority.                                                                                                                                                                                                            |
| `organization_id`          | Required, foreign key to `identity.organization(id)`, `ON DELETE RESTRICT`. **Immutable**: in no update contract, and the application role has no `UPDATE` privilege on the column (decision 7). **Transfer between organizations is deferred** (a new decision with its own data rules).                           |
| `name`                     | Required, trimmed, 1 to 100 characters. Not unique.                                                                                                                                                                                                                                                                 |
| `slug`                     | Required on creation, lower-case letters, digits and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`), 2 to 48 characters. **Unique per organization** (`UNIQUE (organization_id, slug)`), as ADR-0010 states. **Immutable** after creation. Archived projects keep their slug reserved, so a restore can never collide. |
| `description`              | Optional text, at most 2000 characters, `NULL` when absent. **No free-form `metadata` column**: it has no consumer and would be unvalidated data in a security-sensitive table.                                                                                                                                     |
| `status`                   | Enum `active` \| `archived`.                                                                                                                                                                                                                                                                                        |
| `archived_at`              | `timestamptz`, `NULL` while active. `CHECK ((status = 'archived') = (archived_at IS NOT NULL))`.                                                                                                                                                                                                                    |
| `created_at`, `updated_at` | `timestamptz` UTC. No `created_by` column: the actor is in the audit event and the creator is the first `project_admin` member.                                                                                                                                                                                     |

**Lifecycle.** `active ⇄ archived`, both transitions audited. An archived project is read-only: it accepts **no updates and no new
members**, and member role changes and removals requested by a user are refused too (`409 project_archived`); it can only be restored.
It stays readable. The one exception is the system-initiated cleanup when a user's organization membership ends (decision 3), which
also removes their rows on archived projects.

**Archive and restore are idempotent (approved).** A request that finds the project already in the requested state **changes nothing,
writes no audit event and answers `200` with the current project**, unchanged: `archivedAt` keeps its original value, `updatedAt` does
not move, and the body has the same shape as the first call. The caller is still authenticated and authorized first, so a caller
without `project.archive` gets `403`/`404` even for a no-op, and a repeated request is not an oracle. Concurrent repeated requests are
serialized by the project lock (decision 9): exactly one of them performs the transition and writes the single event; the others see
the new state and are no-ops. There is no `409` for a repeated transition. `409 project_archived` applies only to _other_ changes
(update, member changes) on an archived project.

**Deletion is deferred** (ADR-0010 final decision 1): no `DELETE /projects/:id`, no `project.deleted` event, no `DELETE` privilege on
`projects.project` for the application role.

**Organization deletion.** No organization deletion exists (no endpoint, no `DELETE` privilege on `identity.organization`). The foreign
key from `project` to `organization` is `RESTRICT`, so when organization deletion is eventually designed it **cannot** silently remove
projects: it must archive or explicitly delete them first, by a decision made then.

### 3. Project membership and the end of an organization membership

A **project membership** is a row that gives one user one project role on one project. It is a different concept from an organization
membership and never changes it.

| #   | Rule                                                                                                                                                                                               | Enforced by                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Organization `owner` and `admin` have implicit access to every project of their organization.                                                                                                      | `permissionsFor` (decision 4). They need no row and are **not listed** as project members unless they also have one.                                                                        |
| 2   | Organization `member` and `viewer` need an explicit project membership to see or use a project.                                                                                                    | `permissionsFor`, and the visibility rule (a project without access is a 404, absent from lists).                                                                                           |
| 3   | A project role cannot grant organization-level permissions or elevate the organization role.                                                                                                       | **Compile time**: project-role entries accept only project-scoped keys. Test: a type-level assertion and a property test over every combination.                                            |
| 4   | A user can be a project member only if they are a member of the project's organization.                                                                                                            | **Database**: composite foreign key `(organization_id, user_id) → identity.membership(organization_id, user_id)`. Application: a held pre-check gives the friendly 404 (decision 9).        |
| 5   | Cross-organization project membership is impossible.                                                                                                                                               | **Database**: composite foreign key `(project_id, organization_id) → project(id, organization_id)` plus rule 4.                                                                             |
| 6   | A user has at most one role per project.                                                                                                                                                           | `UNIQUE (project_id, user_id)`.                                                                                                                                                             |
| 7   | **A project membership never exists without the organization membership.** When the organization membership ends, the user's project memberships in that organization end in the same transaction. | The removal participant below, with the foreign key as the safety net.                                                                                                                      |
| 8   | The creator of a project holds an explicit `project_admin` row from the moment the project exists.                                                                                                 | Created in the same transaction as the project (decision 8). It survives a later loss of owner/admin status; it ends only with the organization membership (rule 7) or an explicit removal. |

**Lifecycle.** `added` (by a holder of `project.member.manage` on that project, for an existing member of the organization, or
automatically for the creator) → `role changed` → `removed` (explicitly, or by rule 7). There is no "last project admin" invariant:
organization `owner`/`admin` always hold implicit administrative access, so a project can never become unmanageable and nothing needs
an ownership-style lock. A project member cannot remove themselves in this step (Q5).

#### The removal participant (decision 3, approved)

Organizations owns the workflow of ending a membership; Projects owns the deletion of its own records. The contract, defined and
exported by `organizations` (`application/membership-lifecycle.ts`), is the only thing `projects` depends on:

```ts
interface MembershipRemoval {
  readonly organizationId: string;
  readonly userId: string; // the user whose membership ends
  readonly membershipId: string;
  readonly actorUserId: string; // who is removing them (the user themselves when leaving)
}
interface MembershipRemovalParticipant {
  readonly name: string; // stable identifier, used in errors and logs
  onMembershipRemoved(removal: MembershipRemoval, tx: DatabaseClient): Promise<void>;
}
class MembershipLifecycle {
  registerRemovalParticipant(participant: MembershipRemovalParticipant): void;
  participants(): readonly MembershipRemovalParticipant[]; // used only by MembershipService
}
```

- **Registration and lifecycle.** `MembershipLifecycle` is a singleton provider of `OrganizationsModule`, exported. `ProjectsModule`
  imports `OrganizationsModule` and registers its `ProjectMembershipCleanup` in `onModuleInit`. The registry is **sealed in
  `onApplicationBootstrap`**, which Nest runs after every module's `onModuleInit`; a later registration, or a second participant with
  the same `name`, throws. So the set is fixed before the first request is served and cannot change at runtime. Participants are
  stateless application services, never request-scoped. They are called in registration order.
- **Shared transaction.** `MembershipService.remove` already runs inside `TransactionRunner.run(async (tx) => …)`. It passes that same
  `tx` to every participant. A participant may not open a transaction of its own (it receives only `tx`; the "no nested transactions"
  rule of backend.md applies); it uses its repository with `tx` and `AuditRecorder.record(event, tx)`.
- **Order inside the transaction** (the numbers match decision 9): (1) lock the owner memberships (`lockOwners`, 2.2); (2) lock the
  subject's membership row `FOR UPDATE` (`lockMember`); (3) authorize and apply the last-owner rule (2.2); (4) call the participants;
  (5) delete the membership row; (6) write the organization's own audit events. Participants run **before** the delete because
  `RESTRICT` is checked immediately.
- **What `ProjectMembershipCleanup` does:** `DELETE FROM projects.project_member WHERE organization_id = $1 AND user_id = $2 RETURNING
id, project_id, role` (one statement; raw SQL is allowed inside a repository, and `RETURNING` gives the audit the role the row had
  _at deletion_, which a read-then-delete could not), then one `project_member.removed` event per row with reason
  `organization_membership_removed`, `actorUserId` the remover, and `projectId`/`organizationId` set. It deliberately ignores whether
  a project is archived. It takes **no project row lock** (decision 9).
- **Failure rolls everything back.** A participant that throws (database error, audit failure, a bug) propagates out of
  `TransactionRunner.run`: the participant's deletes and events, the membership delete and the organization's events are all rolled
  back, and the membership is still there. An `AppError` keeps its status; anything else is an unexpected `500` through the existing
  filters. A participant must not catch and swallow its own failure. Test: a participant that deletes rows and then throws leaves the
  database exactly as before.
- **Atomic audit.** The participant's events, `membership.removed` and (for an owner) `organization.owner_revoked` are written by the
  same `tx`: all of them commit with the removal or none does. They share the request's correlation id.
- **No participant registered.** The behavior is exactly that of 2.2: nothing to call, the membership is deleted, the organization events
  are written. If `projects` is not loaded but `project_member` rows exist (a configuration the application does not ship), the final
  delete fails the foreign key and is answered **`409 membership_in_use`**, with nothing changed: it fails closed and never orphans a
  row. In the shipped `AppModule` both modules are always present. Tests cover both cases.
- **Dependency check.** `organizations` imports nothing from `projects`: the interface is its own, `projects` implements it, and the
  boundary tool sees only `projects → organizations`. A removal `409 membership_in_use` can only mean a missing participant or a
  race the lock order prevents; it is retryable only after the cause is fixed, and is not expected in normal operation.

Options considered for rule 7 and rejected: leaving the rows and relying on per-request checks (the grant revives if the user returns,
and no foreign key could exist); `ON DELETE CASCADE` (ADR-0010 forbids cross-domain cascades and a cascade is invisible to the audit
trail); a foreign key `RESTRICT` alone (changes the 2.2 API and makes "leave the organization" depend on project state).

### 4. Permissions, roles and the union rule

Permissions and roles stay **code** (`packages/contracts/src/permissions.ts`); no table. Keys are tagged with their scope.

**New roles:** `ProjectRole` = `project_admin` | `project_member` | `project_viewer` (an enum stored on `project_member`).

**New keys:**

| Key                     | Scope          | Meaning                                                                                                                                            |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.list`          | `organization` | Call the project list of an organization. The list contains **only projects the caller can access** (decision 6). Held by every organization role. |
| `project.create`        | `organization` | Create a project in an organization. Organization-scoped because no project exists yet and a project role can never grant it.                      |
| `project.read`          | `project`      | See the project and its members. Having it **is** having access: without it the project does not exist for the caller.                             |
| `project.update`        | `project`      | Change the name and description.                                                                                                                   |
| `project.archive`       | `project`      | Archive and restore.                                                                                                                               |
| `project.member.manage` | `project`      | Add, re-role and remove project members.                                                                                                           |

**Typing of the catalog.** A definition is a union: an `organization` key has only `roles` (organization roles); a `project` key has
`roles` (the organization roles that hold it **implicitly on every project**) and `projectRoles` (the roles that hold it **on that
project**). An organization key cannot carry `projectRoles`, so a project role cannot be made to grant an organization permission
without a compile error.

#### The union rule (approved) and its confinement

```text
permissionsFor(orgRole, projectRole | null)  =  organizationKeys(orgRole)      -- keys with scope 'organization' that orgRole holds
                                              ∪ implicitProjectKeys(orgRole)    -- keys with scope 'project' that orgRole holds on every project
                                              ∪ explicitProjectKeys(projectRole)-- keys with scope 'project' that the project role holds (empty if null)
```

`explicitProjectKeys` can contain only project-scoped keys (compile-time), so the union never adds an organization permission. The
result is **confined to one project** because of how it is produced and used:

1. `projectRole` is read from the row `(this project, this user)` of the project the request resolved (`findRole(projectScope, userId)`,
   keyed by the project scope); there is no API that returns a role "for the user" in general, so a role on another project, or in
   another organization, cannot be mixed in.
2. The result lives in the `ProjectContext` of that one request and project. Acting on another project requires another
   `ProjectAccess.resolve`, which reads that project's role. A permission set is never stored on the tenant, the session or anywhere
   shared.
3. Organization-scoped routes (`/organizations/...`, `project.list`, `project.create`) are evaluated with `projectRole = null`: they use
   the organization role alone, always.

So an organization **viewer** with an explicit `project_admin` row on project P _can_ update, archive/restore and manage the members
of **P** (the approved write path through the union), and **cannot**: create projects (the viewer's organization role lacks
`project.create`), manage organization members or settings, see any other project, or change anything about P's organization.
`project_admin` never means more than "administer this project".

**Permission matrix.** "Holds it on that project" for the project-role columns; the project roles add **nothing** at organization level.

| Permission                                            | Org owner | Org admin | Org member | Org viewer | Project admin | Project member | Project viewer | Authenticated, not in the org |
| ----------------------------------------------------- | :-------: | :-------: | :--------: | :--------: | :-----------: | :------------: | :------------: | :---------------------------: |
| **Organization level**                                |           |           |            |            |               |                |                |                               |
| `organization.read`, `member.read`                    |    yes    |    yes    |    yes     |    yes     |   no change   |   no change    |   no change    |           no (404)            |
| `organization.update`, `member.manage`                |    yes    |    yes    |     no     |     no     |   no change   |   no change    |   no change    |           no (404)            |
| `member.manage_owners`                                |    yes    |    no     |     no     |     no     |   no change   |   no change    |   no change    |           no (404)            |
| **Project management**                                |           |           |            |            |               |                |                |                               |
| `project.list` (only accessible projects, decision 6) |    yes    |    yes    |    yes     |    yes     |   no change   |   no change    |   no change    |           no (404)            |
| `project.create`                                      |    yes    |    yes    |    yes     |     no     |   no change   |   no change    |   no change    |           no (404)            |
| `project.update`                                      |  all (i)  |  all (i)  |  no (ii)   |  no (ii)   |   yes (iv)    |       no       |       no       |           no (404)            |
| `project.archive` (archive and restore)               |  all (i)  |  all (i)  |  no (ii)   |  no (ii)   |   yes (iv)    |       no       |       no       |           no (404)            |
| **Project member management**                         |           |           |            |            |               |                |                |                               |
| `project.member.manage`                               |  all (i)  |  all (i)  |  no (ii)   |  no (ii)   |   yes (iv)    |       no       |       no       |           no (404)            |
| **Project data access**                               |           |           |            |            |               |                |                |                               |
| `project.read` (project, member list)                 |  all (i)  |  all (i)  | only (iii) | only (iii) |      yes      |      yes       |      yes       |           no (404)            |

(i) implicitly on **every** project of the organization, with no row. (ii) not on any project by organization role alone. (iii) only on
projects where the person has a row; elsewhere the project does not exist for them (404). (iv) on **that one project**, whatever the
holder's organization role, including `viewer`.

**Effective permissions of an organization `member` or `viewer` by explicit project role** (organization-level permissions are
unchanged in every row):

| Their organization role | Project role on P | On P                                                            | On any other project Q (no row) | At organization level                         |
| ----------------------- | ----------------- | --------------------------------------------------------------- | ------------------------------- | --------------------------------------------- |
| member                  | none              | nothing (404)                                                   | nothing (404)                   | `project.create`, `project.list`, read        |
| member                  | `project_viewer`  | `project.read`                                                  | nothing (404)                   | unchanged                                     |
| member                  | `project_member`  | `project.read`                                                  | nothing (404)                   | unchanged                                     |
| member                  | `project_admin`   | `project.read`, `.update`, `.archive`, `.member.manage`         | nothing (404)                   | unchanged                                     |
| viewer                  | none              | nothing (404)                                                   | nothing (404)                   | read, `project.list`; **no** `project.create` |
| viewer                  | `project_viewer`  | `project.read`                                                  | nothing (404)                   | unchanged                                     |
| viewer                  | `project_member`  | `project.read`                                                  | nothing (404)                   | unchanged                                     |
| viewer                  | `project_admin`   | `project.read`, `.update`, `.archive`, `.member.manage` (union) | nothing (404)                   | unchanged: read-only, no `project.create`     |

Project data (agents, executions, usage, files) does not exist yet. When a later domain adds data permissions it adds project-scoped
keys to this catalog; `project_member` and `project_viewer` hold identical permissions today (ADR-0010) and diverge then. If an
owner/admin is demoted to member, their implicit access ends on the next request and only their explicit rows remain; if they are
removed from the organization, decision 3 removes the rows.

### 5. Authorization flow and tenant isolation

Deny by default holds: every route needs a session (global guard) and, under `/projects`, a declared permission, pinned by the
route-metadata test.

**Source of truth for every decision:** the organization role from `identity.membership`, the project role from
`projects.project_member`, the project's status from `projects.project`, **each read from PostgreSQL on that request** (inside the
transaction, under the locks of decision 9, for mutations). Nothing is cached in the session or elsewhere.

**Organization-addressed routes** (`GET /projects?organizationId=`, `POST /projects` with `organizationId` in the body):

1. The id is a _selector_. Absent: `400`. Present: `TenantAccess.resolve(principal, organizationId)`; malformed, unknown and
   not-a-member are the same `404 organization_not_found`.
2. `AuthorizationService.authorize(tenant, 'project.list' | 'project.create')` → `403 forbidden`.
3. `ProjectAccess` returns an `OrganizationContext` (tenant plus its `OrganizationScope`); services and repositories use that.

**Project-addressed routes** (`/projects/:projectId/...`), through `ProjectAccess.resolve(principal, projectId, permission)`:

1. `projectId` is validated as a UUID; otherwise `404 project_not_found`.
2. `organizationIds = MembershipDirectory.organizationIdsOf(principal.userId)`. Empty: `404`, no query.
3. **One** query: `SELECT … FROM projects.project WHERE id = $1 AND organization_id IN (…)` (ADR-0010 decision 4.3). No row means
   `404 project_not_found` whether the project does not exist or belongs to an organization the caller is not in.
4. `TenantAccess.resolve(principal, project.organizationId)` yields the authoritative role (a membership that ended between steps 2
   and 4 is a 404).
5. The explicit project role is read only when the organization role does not already grant implicit access.
6. `permissions = permissionsFor(role, projectRole)` (decision 4). Without `project.read`: `404 project_not_found` (**visibility follows
   access**). With it but without the route's permission: `403 forbidden`.
7. A `ProjectContext` is created (decision 5, scope construction) and handed to the handler.

**Mutations re-run steps 4 to 6 inside the transaction**, after the project lock and the holds of decision 9, so a role change or
removal that committed a moment earlier applies to the request already in flight.

**Failure semantics:**

| Situation                                                                    | Answer                       |
| ---------------------------------------------------------------------------- | ---------------------------- |
| Not authenticated                                                            | `401 unauthenticated`        |
| Project does not exist                                                       | `404 project_not_found`      |
| Project belongs to another organization                                      | `404 project_not_found`      |
| Caller is not a member of the project's organization                         | `404 project_not_found`      |
| Caller is a `member`/`viewer` of the organization with no project membership | `404 project_not_found`      |
| Caller has access but lacks the permission                                   | `403 forbidden`              |
| Organization selector (list/create) is not one the caller belongs to         | `404 organization_not_found` |
| A change on an archived project                                              | `409 project_archived`       |

#### Scope construction (approved)

The chain from the authenticated principal to a repository call:

```text
session ──► Principal { userId }                                  identity (global AuthenticationGuard)
   │
   ├─ organization-addressed:  TenantAccess.resolve(principal, organizationId)      → TenantContext   (membership read from PostgreSQL)
   │                           scopeOf(tenant)                                      → OrganizationScope
   │
   └─ project-addressed:       organizationIds = MembershipDirectory.organizationIdsOf(userId)
                               project = repo.findInOrganizations(organizationIds, projectId)    (the single id-only lookup)
                               tenant  = TenantAccess.resolve(principal, project.organizationId)
                               projectRole = repo.findRole(…)  ; permissions = permissionsFor(tenant.role, projectRole)
                               ProjectContext.create(tenant, project, projectRole, permissions)   → ProjectContext   (only ProjectAccess calls this)
                               projectScopeOf(context)                                → ProjectScope   (requires instanceof ProjectContext)
```

- A **raw client-provided id is never evidence.** `organizationId`, `projectId` and a member's `userId` are query keys that are
  validated, then checked against the database (membership, the caller's organizations, the target's membership), and only the
  _result_ of that check becomes a context. Nothing client-supplied is copied into a scope directly.
- `ProjectContext` is a **class** whose instances are created only by `ProjectAccess`; `projectScopeOf` rejects anything else with
  `instanceof`. This is stricter than 2.2's plain `TenantContext` interface and is as strong as TypeScript allows without a runtime
  seal.
- Every project repository method takes the scope as its **first** parameter and calls `requireScope` / `requireProjectScope` before
  building a query; a missing, look-alike or malformed scope throws before the database is touched. Every statement filters by both
  `id` and `organization_id` (members: `project_id` and `organization_id`). The only id-only method is `findInOrganizations`, which
  takes an explicit non-empty list of organization ids and returns nothing for an empty or malformed list.
- **Architecture test (approved).** `apps/api/test/scope-construction.e2e.spec.ts` (runs in `pnpm test`, no infrastructure) scans every
  non-test source file under `apps/api/src` with the TypeScript compiler API (already a dependency of `tools/check-module-boundaries.mjs`)
  and finds every call or `new` of `scopeOf`, `OrganizationScope.of`, `projectScopeOf`, `ProjectScope.of`, `ProjectContext.create` and
  `new ProjectContext`. The set of `(file, function)` pairs must **equal a pinned allowlist**: the definitions themselves, the existing
  2.2 call sites in `organizations/application` (`organization.service.ts`, `membership.service.ts`), and exactly one file in `projects`,
  `application/project-access.ts`. A call in a controller, guard, repository, domain file or another module fails the test and names
  the file and line; adding a legitimate call site means editing the allowlist, which is visible in review. Test files are excluded
  (they must forge scopes to prove the fail-closed behavior). **Limit, stated plainly:** the test pins _where_ scopes are built, not
  _which id_ is passed; the cross-tenant matrix (decision 10) is the control for that.

**What this prevents, and the compensating controls where it does not fully:**

| Threat                                   | Control                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-organization project access / IDOR | The single `IN (caller's organizations)` query; every later query also filters by organization; identical 404 for missing and foreign.                                                                                                                                         |
| Cross-organization project membership    | Composite foreign keys: impossible in the data, not only in code.                                                                                                                                                                                                              |
| Project role escalation                  | Typed catalog; the confinement of decision 4; role changes need `project.member.manage` on that project.                                                                                                                                                                       |
| Manipulated route parameters             | `:projectId` is a lookup key resolved against the caller's organizations; `:userId` is looked up inside `(project, organization)`; the body `organizationId` of `POST /projects` is a selector validated by `TenantAccess`; no contract accepts an `organizationId` on update. |
| Accidental unscoped repository queries   | Required scopes, the "all methods listed" unit test, the construction architecture test, no raw SQL outside repositories, and PostgreSQL privileges.                                                                                                                           |
| Moving a project to another organization | Not in any contract; the application role has no `UPDATE` on `project.organization_id`.                                                                                                                                                                                        |
| Enumeration of projects or members       | Lists contain only what the caller can access; every non-access answer is the same 404; member lists require `project.read`.                                                                                                                                                   |

### 6. API

All under `/api/v1`, errors in the `ApiError` shape, documented with the zod-to-OpenAPI helpers, lists with `paginationQuerySchema` /
`paginatedSchema`. Lists use a fixed stable order (`created_at`, then `id`) like 2.2, so paging never repeats or skips a row.

New contracts (`packages/contracts/src/projects.ts`): `projectSchema` (`id`, `organizationId`, `name`, `slug`, `description` or `null`,
`status`, `archivedAt` or `null`, `createdAt`, `updatedAt`, `projectRole`: the caller's **explicit** role or `null`),
`createProjectRequestSchema` (`organizationId`, `name`, `slug`, optional `description`), `updateProjectRequestSchema` (optional `name`,
optional `description` where `null` clears it; at least one field), `listProjectsQuerySchema` (`organizationId`, `status`: `active`
default | `archived` | `all`, plus pagination), `projectMemberSchema` (`userId`, `email`, `displayName`, `role`, `joinedAt`),
`addProjectMemberRequestSchema` (`userId`, `projectRole`), `updateProjectMemberRequestSchema` (`projectRole`), and `PROJECT_ERROR_CODES`.

| Method and route                              | Permission (scope)                        | Request                                          | Success                             | Errors                                                                                                                      | Audit events                                                           |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /projects?organizationId=…`              | `project.list` (organization, selector)   | query                                            | `200 Paginated<Project>`            | 400, 401, 403, 404 `organization_not_found`                                                                                 | none                                                                   |
| `POST /projects`                              | `project.create` (organization, selector) | `organizationId`, `name`, `slug`, `description?` | `201 Project`                       | 400, 401, 403, 404 `organization_not_found`, 409 `project_slug_taken`                                                       | `project.created`, `project_member.added` (creator, `project_created`) |
| `GET /projects/:projectId`                    | `project.read` (project)                  | -                                                | `200 Project`                       | 401, 404 `project_not_found`                                                                                                | none                                                                   |
| `PATCH /projects/:projectId`                  | `project.update` (project)                | `name?`, `description?`                          | `200 Project`                       | 400, 401, 403, 404, 409 `project_archived`                                                                                  | `project.updated` (only if something changed)                          |
| `POST /projects/:projectId/archive`           | `project.archive` (project)               | -                                                | `200 Project` (idempotent)          | 401, 403, 404                                                                                                               | `project.archived` (only on a real change)                             |
| `POST /projects/:projectId/restore`           | `project.archive` (project)               | -                                                | `200 Project` (idempotent)          | 401, 403, 404                                                                                                               | `project.restored` (only on a real change)                             |
| `GET /projects/:projectId/members`            | `project.read` (project)                  | pagination query                                 | `200 Paginated<ProjectMember>`      | 400, 401, 404                                                                                                               | none                                                                   |
| `POST /projects/:projectId/members`           | `project.member.manage` (project)         | `userId`, `projectRole`                          | `201 ProjectMember`                 | 400, 401, 403, 404 `project_not_found` / `organization_member_not_found`, 409 `already_project_member` / `project_archived` | `project_member.added` (`added`)                                       |
| `PATCH /projects/:projectId/members/:userId`  | `project.member.manage` (project)         | `projectRole`                                    | `200 ProjectMember` (no-op allowed) | 400, 401, 403, 404 `project_member_not_found`, 409 `project_archived`                                                       | `project_member.role_changed` (only if the role changed)               |
| `DELETE /projects/:projectId/members/:userId` | `project.member.manage` (project)         | -                                                | `204`                               | 400, 401, 403, 404 `project_member_not_found`, 409 `project_archived`                                                       | `project_member.removed` (`removed`)                                   |

**Repeated archive and restore (approved).** `POST …/archive` on an active project: `200`, the archived project, one
`project.archived` event. `POST …/archive` on an already archived project: `200`, the **same** body as before, **no event**, nothing
written. `POST …/restore` mirrors it. The status code and body shape never reveal that the call was a no-op; the permission check
happens first in both cases.

#### Listing rules (`project.list`, approved with a restriction)

`project.list` lets a caller **ask**; what they **get** is only the projects they can access. It never means "every project of the
organization".

- **Who may call it.** Any of the four organization roles (the key is held by `owner`, `admin`, `member`, `viewer`). A user who is not a
  member of the selected organization gets `404 organization_not_found` and learns nothing about it.
- **What is returned**, by the caller's organization role (read from `identity.membership` on this request through `TenantAccess`):
  - `owner`, `admin`: **every** project of the organization (implicit administrative access, ADR-0010);
  - `member`, `viewer`: **only** the projects for which the caller has an explicit `project_member` row **in that organization**. An
    ordinary member never sees a project merely because they belong to the organization.
- **How it is built.** The service derives a `ProjectVisibility` value from the `TenantContext` with one pure function: either
  `{ kind: 'organization' }` (owner/admin) or `{ kind: 'explicit', userId }` (member/viewer, `userId` taken from the principal, never
  from the request). The repository method `list(scope, visibility, filter, page)` has no way to run without both. The predicate is
  `organization_id = $scope` always, plus, for `explicit`, `id IN (SELECT project_id FROM projects.project_member WHERE organization_id =
$scope AND user_id = $userId)`; both tables belong to `projects`, so no other module's table is read.
- **Filtering and pagination preserve isolation.** The `status` filter (`active` by default, `archived`, `all`) is **ANDed** with the
  visibility predicate, never replaces it. `limit`/`offset` and the stable order apply to the already-filtered set; `page.total` counts
  only accessible projects (so it discloses nothing about hidden ones). There is no client-supplied user, organization-list or
  "include everything" parameter, and no listing across organizations: each call names one.
- **No leak.** Inaccessible projects are not marked, counted, redacted or hinted at: they are simply absent. A caller with no access
  gets `200` with `items: []` and `total: 0` (not an error, since the organization is theirs); a page past the end is empty in the same
  way. The same project that is absent from a list is `404` by id (decision 5), so list and detail agree.
- **Effect of role changes.** Nothing is cached: demoting an admin to member shrinks their next list to their explicit rows;
  removing a user from the organization makes the organization `404`.
- **Each item carries the caller's explicit `projectRole`** (or `null` for implicit access), which lets a client hide controls.
- **Tests:** for each organization role, with and without explicit rows, in two organizations, on active and archived projects, the
  returned ids equal an independently computed expected set; `total` equals its size; rows of the same user in another organization
  are ignored; paging through a mixed list returns each accessible project exactly once.

### 7. Database and Prisma

New PostgreSQL schema **`projects`** (ADR-0010 decision 7), new Prisma file `projects.prisma`, `schemas = ["identity", "projects",
"security"]` in `base.prisma` (evidence E1).

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

**Why composite foreign keys earn their complexity:** `project_member.organization_id` is a denormalized copy, but the two foreign keys
force it to equal the project's organization **and** to be an organization the user is a member of. Cross-organization membership, an
orphan after an organization membership ends, and a membership for a user who was never in the organization are all impossible in the
data, independent of application bugs. The referenced columns already have a unique constraint in `identity.membership`. Evidence E3
to E5 shows how they behave under concurrency; decision 3 and 9 make them a backstop rather than the normal path.

**Constraints:** `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 48` (lower-case is enforced, so a plain unique
index is case-safe, no `citext`); `char_length(btrim(name)) >= 1 AND char_length(name) <= 100`; `description IS NULL OR
char_length(description) <= 2000`; `(status = 'archived') = (archived_at IS NOT NULL)`. `ON UPDATE CASCADE` (Prisma's default) is
irrelevant because identifiers are never updated; it can be set to `Restrict` in the schema.

**Privileges (least privilege, exact-grants test updated).** `USAGE ON SCHEMA projects`; on `project`: `SELECT`, `INSERT` and
**column-level `UPDATE (name, description, status, archived_at, updated_at)`**; on `project_member`: `SELECT`, `INSERT`, `DELETE` and
`UPDATE (role, updated_at)`. No `DELETE` on `project`. The API role **cannot** change `organization_id`, `slug`, `id` or `created_at`
of a project, or the project/user/organization of a membership, whatever the application code does. Evidence E2 shows `SELECT … FOR
UPDATE` works with column-level `UPDATE`; step S3 confirms Prisma's `update` against the real client and adjusts the column list if
needed (Q6). The cleanup participant needs `DELETE` and `SELECT` on `project_member`, which are granted. No other privilege is added
for `agentos_app`; the existing role separation is unchanged.

**Migration plan.** Two new migration directories (applied migrations are never edited): `projects_tables` (generated: schema, enums,
tables, indexes, foreign keys) and `projects_privileges_and_constraints` (hand-written: the `agentos_app` guard as before, grants, CHECK
constraints). Purely additive: no existing table is altered, so existing data is untouched and no Docker volume needs to be recreated.
The migration role already holds `CREATE` on the database (`roles.sql`), which creating the schema needs; production must grant the same
(documented since 2.1). `organizations.prisma` gains two back-relation fields (additive). The Compose `migrate` service applies it with
`prisma migrate deploy` as the migration role; the system test that asserts table owners must include the `projects` schema.

### 8. Audit

Typed events in `packages/contracts/src/audit.ts`, strict metadata (ids, enum values, field names; never user-entered text such as
names, slugs or descriptions). All are `result: success` and are written with `AuditRecorder.record(event, tx)` **in the same
transaction as the change**: an audit failure rolls the change back (the 2.2 pattern, tested with a failing store).

| Event                         | `resourceType`   | `resourceId`  | Metadata                                                                   | When                                                          |
| ----------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `project.created`             | `project`        | project id    | none                                                                       | the project came into existence                               |
| `project.updated`             | `project`        | project id    | `changedFields`: `name` and/or `description`                               | only if a value changed                                       |
| `project.archived`            | `project`        | project id    | none                                                                       | state actually changed                                        |
| `project.restored`            | `project`        | project id    | none                                                                       | state actually changed                                        |
| `project_member.added`        | `project_member` | membership id | `userId`, `role`, `origin`: `added` \| `project_created`                   | a membership row was created                                  |
| `project_member.role_changed` | `project_member` | membership id | `userId`, `previousRole`, `role`                                           | only if the role changed                                      |
| `project_member.removed`      | `project_member` | membership id | `userId`, `role`, `reason`: `removed` \| `organization_membership_removed` | a membership row was deleted (one per project in the cleanup) |

Every event carries `actorUserId`, `organizationId` and `projectId`. `project_id` and `organization_id` columns already exist on
`audit_log`; no audit migration is needed. Events of one transaction share `occurred_at` and have no defined order (2.2 note 30); they
are related by `correlationId` and `projectId`, never by position.

**Creator semantics (approved, unambiguous).** Creating a project writes **two** events, in the same transaction as the two rows:

1. `project.created`: the project exists (no metadata; the actor is the creator).
2. `project_member.added` with `origin: 'project_created'`, `role: 'project_admin'`, `userId` the creator.

The rule that keeps this unambiguous: **`project_member.added` is written exactly once for every `project_member` row ever created, and
`project.created` exactly once for every project.** The creator's grant is therefore not folded into `project.created` (that would make
the membership history incomplete: a reader could not reconstruct "who had a row, and since when" from `project_member.*` events
alone), and `origin` lets a reader tell the automatic initial grant from an explicit add without inferring it from ordering. If either
insert or either event fails, the whole transaction rolls back: no project without its creator row, no row without its project.

**End of an organization membership.** The cleanup writes one `project_member.removed` (reason `organization_membership_removed`) per
removed row, in the same transaction as the organization's own `membership.removed` (and `organization.owner_revoked`), so the audit
trail shows both the cause and each consequence, all or nothing. If an owner/admin creator later loses that status, nothing is written
for the project: their explicit row stays effective and changes only through an explicit action.

**Rejected authorization attempts are not audited**, preserving the 2.2 policy (note 31): the catalog records successful state changes;
refusals leave the `ApiError` response and the request log. There is no compelling reason to change this in this step.

### 9. Concurrency, lock ordering and security

PostgreSQL constraints and transactions only; **no Redis, no advisory locks, no distributed locks.** Default `READ COMMITTED`: every
statement takes a fresh snapshot, which is why "lock, then read" returns the committed state of the transaction that held the lock
before.

#### PostgreSQL facts the design depends on (all exercised in evidence E3 to E7)

1. Inserting a `project_member` row takes `FOR KEY SHARE` on the referenced `project` row and on the referenced `membership` row (the
   two composite foreign keys).
2. Deleting a `membership` row takes an exclusive row lock that conflicts with `FOR KEY SHARE`, and the `RESTRICT` check fails the
   delete if a referencing row exists, **including one committed after the cleanup statement ran**.
3. Updating only non-key columns (`membership.role`, `project.name`, `project.status`) takes `FOR NO KEY UPDATE`, which does **not**
   conflict with `FOR KEY SHARE`: re-roling a member does not block project-member inserts (E6).
4. An explicit `FOR SHARE` ("hold") conflicts with updates and deletes of that row but not with other `FOR SHARE`/`KEY SHARE` holders.
5. A deadlock needs a cycle of waits. Shared holds never wait on each other, so cycles can only involve exclusive requesters.

#### The lock order (mandatory, both modules)

Locks are acquired in increasing level and a transaction never returns to a lower level:

| Level | Lock                                                                                                                                     | Taken by                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| L1    | The organization's **owner membership rows**, `ORDER BY id FOR UPDATE` (`lockOwners`, existing in 2.2)                                   | **Organization-side** membership changes only: add, re-role, remove/leave.                                                    |
| L2    | The **project row**, `FOR UPDATE` (`lockProject`)                                                                                        | **Project-side** changes only: update, archive, restore, member add/re-role/remove.                                           |
| L3    | **One** organization membership row, the _subject_ of the change: `FOR UPDATE` (organization side) or `FOR SHARE` ("hold", project side) | Removal and re-role (exclusive); adding a project member or creating a project (shared hold of the **target** / **creator**). |
| L4    | `project_member` rows (insert, update, delete)                                                                                           | Project-side changes and the removal participant.                                                                             |

Rules that make this deadlock-free (each is a test, see decision 10):

- **R1.** Increasing level only. The organization side takes L1 → L3 → L4; the project side takes L2 → L3 → L4. The two sides share no
  lock that either takes first, so neither can wait for the other's _entry_ lock.
- **R2.** **Project-side code locks at most one organization-membership row** (the target, or the creator who is also the actor). It does
  _not_ also hold the actor's row. This is the rule evidence E7 forced: the first draft held actor and target, the actor was often an
  owner whose row L1 had locked in another order, and 6 of 5,760 transactions deadlocked (V0).
- **R3.** **The organization side never takes L2.** The removal participant only deletes `project_member` rows (L4) and takes **no**
  project row lock.
- **R4.** Within L1, rows are locked in `id` order (existing). Project-side code never takes L1.
- **R5.** Project-side code takes its L3 lock **before** touching any L4 row, never after.

Why this is acyclic: an organization-side transaction holds L1, then at most one L3 row, then L4 rows of that one user. A project-side
transaction holds L2, then at most one L3 _shared_ row, then L4 rows. A cycle would need an organization-side transaction to wait for
something a project-side transaction holds _while_ that transaction waits for something the organization side holds. The organization
side waits only for an L3 row (held shared, by a transaction that then needs nothing the organization side holds) or for L4 rows
(held by a transaction that already holds all its L3 locks). The project side waits only for L2 (held by another project-side
transaction), an L3 row held exclusively (by an organization-side transaction that already holds everything it will need on that row)
or an L4 row (R5). Evidence E7: V1 (exactly this protocol) ran 5,760 mixed transactions with no error.

#### The three required analyses

**A. Organization membership removal while project-membership cleanup is running.** The removal holds L1, then the subject's row
`FOR UPDATE` (L3), then runs `DELETE … RETURNING` on the user's `project_member` rows (L4), then deletes the membership.

- _Two removals of the same user_ (an admin removes them while they leave): serialized at L1; the second finds no membership
  (`404 member_not_found`) and does nothing; the cleanup runs once.
- _A project-side change to that user's row in flight_ (re-role/remove under L2): row-level wait on L4. If the project change goes
  first, the cleanup deletes the updated row and audits the role it actually had (`RETURNING`); if the cleanup goes first, the project
  change finds no row (`404 project_member_not_found`). No cycle: the project change holds L2 and the row, and needs nothing the removal
  holds.
- _Archive of a project in flight:_ independent (the cleanup deletes child rows only and takes no project lock).

**B. Adding a project member while that user's organization membership is being removed.** The add holds L2, then `holdMember(target)`
(`FOR SHARE`, L3), then inserts (L4).

- _The removal gets the row first_ (E4): the add waits at L3, then `holdMember` returns false → `404 organization_member_not_found`;
  nothing is inserted.
- _The add gets the hold first_ (E3): the removal's `FOR UPDATE` waits for the add to commit, then its cleanup statement (a fresh
  snapshot) **sees the new row**, deletes it, writes `project_member.removed`, and deletes the membership. Both audit events exist.
- Either way, no `project_member` survives and **no foreign-key error occurs on the normal path**. Without the hold the second case
  would fail the removal with `23503` (E5, V3: 50 occurrences in 5,760 transactions); with it, none (V1, V2). The foreign key remains
  as the backstop: if a participant were missing, the removal fails closed (`409 membership_in_use`), it never leaves an orphan.
- Creating a project is the same case with the creator as target: `holdMember(creator)` false → `404 organization_not_found`, and the
  project insert is rolled back.

**C. Changing project membership while an organization role or membership changes.**

- _The target's organization membership ends_: case B above (for an add) or A (for a change/remove of an existing row).
- _The target's organization role changes_ (member → viewer): a role update takes `FOR NO KEY UPDATE` on the membership row; an add's
  hold (`FOR SHARE`) makes it wait a few milliseconds (or the update goes first and the add proceeds). No deadlock (R1/R2), and the
  result is the union rule applied on the next request.
- _The actor's organization role or membership changes_ (an admin demoted or removed while changing a project): the actor's role is
  re-read **inside** the transaction, after L2 and the target hold, from `identity.membership`. A demotion that committed earlier is
  applied. A demotion that commits _after_ that read lets this one request complete: that is the ordinary window of an in-flight
  request, the same one 2.2 accepts for renaming an organization, and it can never create a project membership for a user who is not
  in the organization (the target hold and the foreign keys guarantee that). Closing it entirely needs project-side code to also hold
  the actor's row, which R2 forbids unless the organization-side mutex is moved off the owner rows; that variant (V2) was measured
  clean and is offered as an option in Q13.
- _Implicit owner/admin access after a role change_: derived from the membership row on every request; nothing is cached.

**Guarantee, in one sentence:** a `project_member` row exists only while the matching organization membership row exists, because
(1) the database refuses any other state, (2) every path that ends an organization membership removes the project rows in the same
transaction, and (3) every path that creates a project row first holds the organization membership, so the two can only be ordered, never
interleaved.

#### Sequences (the contract for implementers)

```text
Organization membership REMOVE (leave or remove)         Project-member ADD
  1. lockOwners(org)                      L1               1. lockProject(P)                          L2   (fresh status; archived => 409)
  2. lockMember(org, subject) FOR UPDATE  L3 (excl.)       2. re-resolve actor role (TenantAccess, tx); authorize project.member.manage
  3. authorize; last-owner rule                            3. holdMember(org, target) FOR SHARE       L3   (false => 404 organization_member_not_found)
  4. participants: DELETE project_member ... RETURNING +   4. INSERT project_member                   L4   (unique => 409 already_project_member)
     project_member.removed events          L4             5. audit project_member.added
  5. DELETE membership (FK RESTRICT is the backstop)       Project CREATE
  6. audit membership.removed (+ owner_revoked)              1. re-resolve creator (TenantAccess, tx); authorize project.create
Organization membership RE-ROLE / ADD: L1 then the row     2. holdMember(org, creator) FOR SHARE      L3   (false => 404 organization_not_found)
Project UPDATE / ARCHIVE / RESTORE / member RE-ROLE /      3. INSERT project (slug unique => 409), INSERT project_member (creator)
  REMOVE: L2, re-resolve actor, authorize, apply, audit    4. audit project.created + project_member.added
```

#### Other cases

| Case                                                 | Outcome and mechanism                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two users create the same slug in one organization   | `UNIQUE (organization_id, slug)`: exactly one `201`, the others `409 project_slug_taken` (the constraint, not check-then-insert). The same slug in different organizations always succeeds. A lost race leaves nothing (one transaction).      |
| Concurrent adds of the same member                   | L2 serializes them; the unique constraint backs it: one `201`, the rest `409 already_project_member`.                                                                                                                                          |
| Concurrent role changes / removals of one member     | L2 serializes them; last committed wins for role changes (each audited with the role it replaced); one `204`, the rest `404` for removals.                                                                                                     |
| Archive while another request changes membership     | Serialized by L2. After an archive, add/re-role/remove answer `409 project_archived`; an archive after an add succeeds. A member can never be added to an archived project. Repeated archives: one event.                                      |
| Lock wait longer than the transaction timeout        | Waits are bounded by `TransactionRunner`'s timeout (5 s). A timeout surfaces as the existing `503 database_unavailable` (retryable) through `DatabaseExceptionFilter`; it is not expected, since each holder keeps its locks for milliseconds. |
| Participant takes long for a user with many projects | One set-based `DELETE … RETURNING`, then one audit insert per row. For the expected scale this is milliseconds; a bulk `recordAll` for audit is a possible later optimization, noted as a risk, not built.                                     |

### 10. Testing strategy

Follows the existing conventions: unit tests beside the code; integration tests (`*.int.spec.ts`) against **real PostgreSQL and Redis**
with a throwaway database, the real migrations and the API connecting as the non-superuser role; system tests through the real Compose
stack. Mock-only tests are used only for pure rules; every guarantee is also proven against PostgreSQL.

**Unit**

- Domain rules: slug and name validation, the lifecycle (archive/restore idempotence, archived is read-only), member-change rules.
- `permissionsFor(organizationRole, projectRole | null)`: a table-driven test over **every** organization role × every project role and
  none × every permission against one independently written expected table (decision 4); property tests that (P1) organization-scoped
  decisions equal the organization role's own decision for every combination, (P2) a project role for P grants nothing on a different
  project Q, and (P3) no project role ever yields an organization-scoped permission; a type-level test that a project role cannot be
  given an organization key.
- Scope validation: `ProjectScope`, `OrganizationScope` and `ProjectContext` reject missing, look-alike and malformed values for
  **every** project repository method without touching the database, and the test fails if a scoped method is added without being
  listed.
- **Architecture test** `scope-construction.e2e.spec.ts` (decision 5): the pinned set of scope-construction call sites.
- `ProjectVisibility` derivation per organization role; the guard (no declared permission → refused; no access → 404; lacking
  permission → 403).
- `MembershipLifecycle`: registration, duplicate name, sealing at bootstrap, call order; `MembershipService.remove` with no participant
  (2.2 behavior preserved), with one, and with one that throws (nothing persists).

**Integration (real PostgreSQL)**

- Constraints: slug/name/description/archive-state CHECKs; `UNIQUE (organization_id, slug)` incl. archived; both composite foreign keys
  (cross-organization membership, non-member, orphan after an organization membership delete) and `RESTRICT` everywhere; privileges:
  exact-grants list incl. column privileges, no `DELETE` on `project`, `UPDATE` of `organization_id` or `slug` denied, `FOR UPDATE` and
  `FOR SHARE` allowed.
- Lifecycle: create (creator becomes `project_admin`; two events; one transaction), update, archive/restore (idempotent, one event, same
  body on repeat), member add/re-role/remove, archived-project rules, pagination stability.
- **Listing:** for each organization role, with and without explicit rows, two organizations, active and archived: ids and `total` equal
  the independent expected set; other organizations' rows ignored; status filter ANDed; paging returns each accessible project once.
- **Tenant isolation matrix** (ADR-0010 4.4a): every project route as a member of another organization, as a user in no organization and
  unauthenticated → `404 project_not_found` / `404 organization_not_found` / `401`, no data in the body, no side effect.
- **Access policy** (ADR-0010 5(c)): every route for org owner, admin, member and viewer **with and without** a project row, each project
  role, and a non-member, against the expected statuses; the union cases of decision 4 (a viewer who is `project_admin` of P updates P and
  gets `403` on every organization route, `404` on Q); implicit owner/admin access without a row; demotion and removal taking effect on
  the very next request.
- **Audit:** events and metadata per operation including the creator pair and the cleanup events; **atomicity** with a failing audit
  store for every operation (nothing persists); no secret or user-entered text in the trail.
- **Removal participant:** removing or leaving an organization removes the user's project memberships (archived projects too) with one
  event each in the same transaction; a participant that fails rolls everything back; with no participant the removal fails closed
  `409 membership_in_use` when rows exist.
- **Concurrency on real PostgreSQL** (decision 9; real concurrent HTTP requests, repeated rounds, plus deterministic gated
  interleavings):
  - _Deterministic lock-protocol tests_ (the gated transactions of evidence E3, E4, E6, run through the real repositories): the removal
    blocks behind an in-flight add and then cleans its row; the add blocks behind an in-flight removal and then gets "not a member";
    a role update does not block the insert; both blocking relations are asserted with `lock_timeout`.
  - _B, add versus removal_ (N rounds): allowed outcomes are exactly `{add 201 + removal 204 with a `project_member.removed` event}`
    or `{add 404 organization_member_not_found + removal 204}`; never `500`, never an FK error, never a surviving row.
  - _B, create project versus removal of the creator:_ `{201 + cleanup}` or `{404 organization_not_found, no project row}`.
  - _A, double removal and removal versus project re-role/remove_ of the same user: one winner, no `500`, audit events exactly once
    per row.
  - _C, project changes versus organization re-role/removal of the actor and of the target:_ no `500`, no deadlock, invariants hold;
    a request _started after_ a committed demotion is denied (deterministic).
  - _Stress:_ mixed organization and project operations on 12 connections (the shape of evidence E7) with fixed counts, asserting **zero
    deadlocks (`40P01`)**, zero FK violations on supported paths and zero orphan rows.
  - Same-slug creation (one winner; different organizations both win), duplicate adds, concurrent re-roles, concurrent removals,
    archive versus add (never a member on an archived project), N concurrent archives (exactly one event).
  - **Each mechanism is proven necessary by removing it** (mutation checks, as in 2.2): without the target hold the spurious FK failures
    appear (V3); without the participant the removal fails closed; without `FOR UPDATE` on the subject row the add-first race fails the
    removal; without the project lock the archive race admits a member; with the actor also held (R2 broken) deadlocks appear (V0).
- Route metadata: the existing test is extended so every `/projects` route is permission-gated or on the account-scoped list, and pins
  the permission of each.

**System (Compose stack, API level)**

- The migration role creates the `projects` schema and tables; the API role has exactly the granted privileges (extends the existing
  ownership/privilege system test).
- Workflow: register → create organization → create project → add an organization member to it → archive and restore; unauthorized
  access (a user outside the project, a member with no row); cross-tenant attempts from a second organization; an organization role
  change (admin → member, removal) changing project access on the next request; removing a member from the organization removes their
  project access.

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

| Step | Content                                                                                                                                                                                                                                                                                     | Review focus                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S1   | Contracts: `ProjectRole`, new permission keys and the union-typed catalog, `projects.ts`, project audit events (incl. `origin`/`reason`), `membership_in_use`; matrix and contract tests.                                                                                                   | The matrix and the typing guarantee.                  |
| S2   | `organizations` additive amendment: project-aware `permissionsFor`/`AuthorizationService`, `MembershipLifecycle` + participant types, `holdMember`, `lockMember` and the changed `remove` (participants, FK mapping); unit and integration tests, incl. 2.2 race tests unchanged and green. | That 2.2 behavior is unchanged; the seam is minimal.  |
| S3   | Database: `projects.prisma`, `base.prisma`, back-relations, the two migrations, privileges and constraint tests (incl. column privileges and the composite foreign keys) against real PostgreSQL.                                                                                           | Migration safety, grants, integrity guarantees.       |
| S4   | `projects` module, part 1: domain, repositories with scopes, `ProjectAccess`/`ProjectContext`, guard, project endpoints (list, create, get, update, archive, restore), tests incl. the isolation matrix, listing rules, slug race, and the **scope-construction architecture test**.        | Authorization flow, listing rules, 404/403 semantics. |
| S5   | `projects` module, part 2: member endpoints, `ProjectMembershipCleanup` registration, the lock-protocol, race and stress tests with mutation checks, audit atomicity tests, route-metadata update.                                                                                          | Lock order and the organization-membership seam.      |
| S6   | System test (API level), documentation, ADR implementation notes; this ADR moves to `Accepted` with the notes (as ADR-0010 did).                                                                                                                                                            | Docs and the end-to-end proof.                        |

The steps are internal commits of one pull request; the natural review checkpoints are after S3 (data model) and at the end.

## Amendments to ADR-0010 (additive, exact)

None is applied now; each becomes an ADR-0010 implementation note when step 2.3 is implemented (the way 2.1 and 2.2 recorded theirs).

| #   | ADR-0010 text                                                                                               | Additive amendment                                                                                                                                                                                                                                                                  | Reason                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Decision 1, `organizations` public contract: `TenantAccess`, `AuthorizationService`, `MembershipDirectory`. | Adds `MembershipLifecycle`, `MembershipRemovalParticipant`, `MembershipRemoval`, and `MembershipDirectory.holdMember`.                                                                                                                                                              | Closes finding F1 without a cascade or a dependency cycle; gives the project side a clean way to hold an organization membership. |
| A2  | Decision 1 dependency diagram: `projects → organizations, identity (Principal only), audit`.                | `projects → identity` also covers `UserDirectory.findByIds`.                                                                                                                                                                                                                        | Member lists need email and display name; approved by the review.                                                                 |
| A3  | Decision 5, project access policy (points 1 to 5).                                                          | Adds point 6: **the end of an organization membership ends the user's project memberships in that organization, in the same transaction**; and point 7: the creator's explicit `project_admin` row survives loss of owner/admin status but not loss of the organization membership. | The ADR did not say what happens to project grants when the organization membership ends (F1); the review decided it.             |
| A4  | 2.2 implementation note 25 (every membership change locks the owner rows).                                  | Unchanged mechanism. Adds: the **subject's** membership row is also locked `FOR UPDATE` on removal (`lockMember`), and the project side may hold only **one** membership row (R2).                                                                                                  | Part of the cross-module lock order (decision 9). Evidence E7 showed the deadlock a second held row causes.                       |

## Open questions requiring explicit approval

Questions Q1 to Q3, Q7 to Q9, Q11 and Q12 of revision 1 were settled by the review (see "What revision 2 settles"); Q4, Q5, Q6 and Q10 stay open. New: Q13 and Q14.

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                              | Recommendation                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q13 | **Actor exactness.** Accept that a project change already past its in-transaction role check may complete if the actor's organization role is demoted a moment later (variant V1, the default here), or also hold the actor's membership row for exact serialization (variant V2)? V2 needs the organization-side mutex moved from the owner rows to one lock row per organization (a change to 2.2's lock mechanism, same behavior). | V1: no change to the merged 2.2 mechanism, the window is one in-flight transaction and cannot create a project membership for a non-member. V2 is measured safe (evidence E7) and can be adopted later without a design change. |
| Q4  | Add project members by `userId` (not email)?                                                                                                                                                                                                                                                                                                                                                                                          | Yes: no email-existence oracle; the picker is the organization member list.                                                                                                                                                     |
| Q5  | Can a project member remove themselves from a project in this step?                                                                                                                                                                                                                                                                                                                                                                   | No (deferred): a project admin or an owner/admin removes them.                                                                                                                                                                  |
| Q6  | Column-level `UPDATE` privileges for `agentos_app` so `organization_id`, `slug` and membership identity are immutable at the database?                                                                                                                                                                                                                                                                                                | Yes (evidence E2); S3 confirms Prisma against them and falls back to table-level `UPDATE` plus tests if not.                                                                                                                    |
| Q10 | Include a small API-level system test in 2.3 although ADR-0010 puts the system scenario in 2.4?                                                                                                                                                                                                                                                                                                                                       | Yes: a new PostgreSQL schema and grants are exercised only by the Compose stack. The browser-level scenario stays in 2.4.                                                                                                       |
| Q14 | New error `409 membership_in_use` on the organization removal endpoints (a missing participant or an unexpected dependent row). Acceptable as an additive code in `ORGANIZATION_ERROR_CODES`?                                                                                                                                                                                                                                         | Yes. It is the fail-closed answer and is not expected in the shipped configuration.                                                                                                                                             |

## Risks, accepted trade-offs and deferred items

- **Per-project and per-user serialization.** Project changes take one row lock; removal and adds contend on one membership row.
  Acceptable at this write rate; revisit the granularity only if projects receive heavy concurrent writes.
- **A new seam in `organizations`** (the participant registry, `holdMember`, `lockMember`) is the price of keeping the dependency
  direction and a complete audit trail; the foreign key guarantees correctness even if the seam is misused.
- **The lock order is a discipline, not a compiler check.** R1 to R5 are enforced by the stress test, the mutation checks and review,
  and written in this ADR; a future change that holds a second membership row on the project side would reintroduce the V0 deadlock.
  The stress test is the regression guard.
- **Union privilege:** a person with a low organization role can administer one project; this is the approved rule, made visible in the
  matrix and tested.
- **Application-enforced tenancy** remains (no RLS); a scope is not unforgeable (F4). The cross-tenant matrix, the required scopes, the
  construction architecture test and the database constraints/privileges are the controls.
- **Actor window** (Q13) and **stale reads:** a read in flight can use a role that changed a moment ago; mutations re-check inside
  their transaction.
- **Archived slugs stay reserved forever** (no deletion); consistent with deferred deletion.
- **No quotas:** any member who may create projects can create many; a very large cleanup (many projects per user) writes one audit row
  each inside one transaction.
- **Refusals are not audited** (consistent with 2.2).
- **Deferred:** everything listed in decision 11, plus a project audit reader and the retention policy of ADR-0010.

## Alternatives considered

- **Slug unique globally:** rejected; ADR-0010 states organization scope and a global namespace would leak names across tenants.
- **Mutable slug:** rejected for this step; it needs a redirect/alias and conflict policy.
- **Project role stored on the organization membership:** rejected; a project role is per project and must not touch organization data.
- **A `project_member` without the denormalized `organization_id`:** rejected; without it the database cannot prove that the project and
  the organization membership belong to the same organization.
- **Checking membership only in the application:** rejected for rules 4 and 5; a bug or a race would leave an unrecoverable cross-tenant row.
- **Inert rows, cascade or a blocking foreign key for F1:** see decision 3.
- **Holding the actor's and the target's membership rows on the project side with 2.2's owner-row lock (V0):** rejected; it deadlocks
  (evidence E7).
- **Advisory locks or Redis locks for the cross-module ordering:** rejected; row locks and foreign keys already express exactly this and
  need no extra infrastructure.
- **`organizationId` in the path (`/organizations/:id/projects`):** it would let the 2.2 guard be reused, but it departs from the API of
  ADR-0010 section 8 and the specification's paths; kept as the ADR states, with the selector validated by `TenantAccess`.
- **Free-form `metadata` jsonb on the project:** rejected; no consumer, unvalidated data.

## Implementation status (step 2.3)

**Implemented on branch `phase-2.3-projects-project-members`, pending review. This ADR stays `Proposed` until that review is complete.**
Everything in decisions 1 to 12 was built as designed, with the places below where the implementation settled a detail, found something,
or differs from the wording. The four additive ADR-0010 amendments are recorded as its implementation notes 36 to 39.

| #   | Topic                                                                      | What was built, found or decided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Migrations**                                                             | `20261115170000_projects_tables` (generated: schema `projects`, enums, tables, indexes, the three foreign keys) and `20261115170100_projects_privileges_and_constraints` (hand-written: grants, CHECKs). Purely additive: no `DROP` or `ALTER` of an existing object. Verified on a fresh isolated database (all 7 migrations apply, `prisma migrate diff` reports no drift) and deployed to the existing development database (see S12).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| S2  | **Description CHECK is stricter than the text**                            | `project_description_valid` rejects a blank description (`char_length(btrim(description)) >= 1`) as well as one over 2000 characters, matching the contract (an empty description is not a description; send `null`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S3  | **Project creation is two statements, one transaction**                    | Prisma cannot express a nested create through the composite relation (the organization column belongs to both foreign keys), so `createWithCreator` inserts the project and then the creator's `project_member` row on the same transaction handle. Either failing rolls both back; this is tested with a failing audit store and a creator removed mid-flight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S4  | **The caller's explicit role is always read**                              | Decision 5 step 5 said the explicit project role is read only when the organization role gives no implicit access. The response carries `projectRole` (explicit role or `null`), so `ProjectAccess` always reads it: one indexed lookup. Permissions are unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| S5  | **Scope construction**                                                     | `ProjectContext` and `OrganizationContext` are classes with private constructors created only in `ProjectAccess`; `ProjectScope` is derived inside `domain/project-context.ts`. `test/scope-construction.e2e.spec.ts` scans every non-test source file and requires the call sites to equal a pinned allowlist (and every allowlisted entry to be used). A mutation (a `scopeOf` call in a controller) fails it and names file and line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S6  | **A finding by mutation: the add-side hold is not independently provable** | Removing `holdMember` from "add a project member" changes no observable outcome: the removal-side `lockMember` (`FOR UPDATE` before the cleanup) already orders the two requests, and a foreign-key refusal of the add is mapped to the same `404 organization_member_not_found`. Removing the **removal-side** lock IS detected (two tests fail). The hold is kept because the approved V1 protocol specifies it (it makes the order explicit and avoids an aborted statement), but no test proves it necessary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S7  | **Race tests**                                                             | Real concurrent requests against PostgreSQL, plus deterministic interleavings: an add held inside its transaction makes the removal wait and then clean the row; a removal held inside its transaction makes the add wait and then answer "not a member". Mutation checks: removing the cleanup (3 tests fail), the removal-side lock (2 fail), the project lock (the "exactly one archive event" test fails). The archive-versus-add race is probabilistic and did not by itself detect the missing project lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S8  | **The V0 regression guard**                                                | `projects-database.int.spec.ts` runs the protocol on 12 connections for 3,000 mixed transactions and requires zero failures. With the project side also holding the actor's row (the V0 pattern) it fails every time (15 to 24 deadlocks in each of 3 runs). With the protocol as designed it passed in each run made.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| S9  | **The accepted V1 in-flight actor window**                                 | **By design (code):** a project change authorizes its actor inside its transaction, after the project lock, and takes no lock the organization side needs (the actor's own membership row is not held). So a change already past that check can complete while its actor is demoted or removed, and every request that starts after the change is visible is evaluated afresh. **Directly tested**, each time with the update held after its authorization and before its commit: (a) an organization admin **with no explicit project membership** is demoted to member: the update completes with `200` and the next request answers `404` (the original test; it exercises that demotion only, not an explicit role and not a removal); (b) an organization admin **with an explicit `project_admin` membership** is demoted to viewer (Test 1): the update completes with `200`, the next project requests are still `200` with `projectRole: project_admin` (the explicit membership stands), and creating a project, renaming the organization and adding organization members are `403`, so the project role restored no organization privilege; (c) an organization member **with explicit project memberships** is removed from the organization (Test 2): the removal did **not** wait for the update in flight (it finished in 31 to 52 ms in five runs while the update was held: the update holds only the project row, which the removal's membership lock and its deletes of `project_member` rows do not conflict with), the update then completed with `200`, the cleanup removed every project membership of the actor (one on an archived project included) with one `project_member.removed` event each, no orphan remained, there was no deadlock or foreign-key error, and every new request answered `404 project_not_found` (the organization selector `404 organization_not_found`). Before Test 2 existed, the window for a **removal** was inferred from the code only. Test 3 (no window involved) shows that removing an explicit project membership recalculates access from the organization role alone. **Inferred from code, not tested with a held request:** that member changes, archive and restore have the same window (they use the same `ProjectAccess.begin`), and that an in-flight request whose explicit project membership (not its organization membership) is removed completes too. **Not a consequence of the window:** the actor check never creates a project membership for a non-member; that is the target hold plus the composite foreign keys. **Why V2 was deferred:** closing the window means project-side code must also hold the actor's membership row, which deadlocks with 2.2's owner-row lock unless that mutex moves to one lock row per organization. That would change a merged, tested 2.2 mechanism for a window of one in-flight transaction. V2 was measured safe (ADR-0011 evidence E7) and can be adopted later without a design change (Q13). |
| S10 | **The membership removal participant and startup**                         | `ProjectMembershipCleanup` registers with `MembershipLifecycle` in `onModuleInit` and, in `onApplicationBootstrap`, throws a named error if it is not registered ("the projects module is enabled but its membership removal participant … is not registered … the application refuses to start"); the registry is sealed at bootstrap (a later registration throws). A test starts the application with a lifecycle whose registration does not take and requires the start to fail. With no participant and dependent rows the removal fails closed `409 membership_in_use` (tested; nothing changes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S11 | **Guard and routes**                                                       | `ProjectAccessGuard` reads the route's declared access (`@RequireProjectPermission`, or `@RequireOrganizationPermission` with the selector's place). The guard runs before the validation pipe, so an absent organization selector is `400` and a present but foreign or malformed one is `404`, before the rest of the body is validated. `route-metadata.e2e.spec.ts` now pins the permission and the way each `/projects` route reaches its tenant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| S12 | **Development database**                                                   | `pnpm db:deploy` applied four migrations to the existing development database (it was still at the Phase 2.1 schema, so the two Phase 2.2 migrations went with them). **Established by inspecting the SQL of the migrations:** all four are additive. They contain no `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `INSERT` or `REVOKE` on existing objects, no `ALTER` of an existing table and no data statement, so they cannot delete, rewrite or rebuild an existing row; their grants concern only the objects they create; their CHECK constraints and foreign keys apply to new, empty tables, so data that already existed cannot make them fail. The only effect on existing tables is metadata (the referential-integrity triggers of the new foreign keys). Each migration file applies atomically: a deliberately failing copy of each project migration, applied once to throwaway databases (an investigation, not a repository test), left nothing of the failed file behind. **Not established:** whether the development database held any data before the deployment. No before-snapshot of row counts exists (the counting script failed because the Phase 2.2 tables did not exist yet). The counts taken afterwards were all zero, and PostgreSQL's cumulative insert counters for those tables also read zero, but those counters are lost after a crash or unclean restart of the server, so they are supporting evidence at most. The conclusion that the migrations are non-destructive rests on their SQL, not on those counts. No volume or database was reset or recreated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Limitations and deferred work (genuine, not aspirations)

- **Refusals are not audited** (consistent with 2.2): a `403` or a refused ownership attempt leaves the response and the request log only.
- **The V1 actor window** (S9) is real: one in-flight project change can complete after its actor was demoted or removed. Both are directly tested (a demotion with and without an explicit project role, and a removal).
- **No quotas:** any member who may create projects can create many. A very large cleanup (one user in many projects) writes one audit row
  per project, sequentially, inside one transaction bounded by the 5 s transaction timeout; a bulk audit write is a possible later optimization.
- **Archived slugs stay reserved forever** (no deletion exists).
- **The lock order is a discipline, not a compiler check.** Its guards are the stress test, the deterministic interleavings and review.
- **Application-enforced tenancy** remains (no RLS); a scope is not unforgeable. The cross-tenant matrices, the required scopes, the
  construction test and the database constraints and privileges are the controls.
- **Deferred as designed:** tasks, agent execution, repository connections, MCP, project API keys, invitations, billing, templates,
  project transfer, permanent deletion, organization deletion, a project member leaving by themselves, free-form project metadata, the
  web slice and the browser-level scenario (Phase 2.4).
