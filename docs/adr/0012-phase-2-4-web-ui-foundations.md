# ADR-0012: Web UI foundations for projects (Phase 2.4): browser E2E, organization context, permission helper, session handling

**Status:** Proposed (design only; nothing is implemented, no code, test, dependency, manifest, lockfile or workflow was changed).
**Date:** 2026-11-16
**Revisions:** 1 = the first proposal. 2 = the review's corrections: the session and cache lifecycle of D4 is specified exactly (the session
entry is never removed by cleanup), the nested routes of D2 are recorded as approved, and the open items are separated into accepted
decisions, implementation-time questions and release criteria. 3 = the session transition contract (an ordered synchronous block,
a generation, an owner) replaces the earlier prose of D4. 4 = two corrections to D4 after review: an uncertain sign-out moves the
session to **unknown** (revision 3 had kept the user signed in with private data, which is unsafe), and the generation stamp covers
**queries as well as mutations**, with an execution gate. 5 = the last three D4 findings: the backend does not
order a probe after a timed-out logout, so an uncertain sign-out is **completed by repeating the logout** and never settled by a `GET /me`
probe; imperative private fetches are prohibited by a lint rule; the multi-tab limitation is recorded. **No decision of revision 1 was
changed; D1, D2, D3, D5, the routes and the scope are untouched by revisions 2 to 5.**
**Reading guide:** this ADR keeps three kinds of statement apart. **Accepted architectural decisions** are D1 to D5 (approved in principle
by the review; the ADR itself stays Proposed until it is accepted). **Implementation-time questions** are facts that cannot be settled
without the implementation and are listed in "Open implementation questions"; they are not decisions. **Release and acceptance criteria**
are conditions that must hold before the UI ships and are listed in "Release and acceptance criteria"; they are not architecture.
**Context:** [ADR-0010](0010-identity-organizations-projects.md) (Accepted) delivers Phase 2 in four reviewed steps; [ADR-0011](0011-projects-and-project-members.md)
(Accepted, revision 3) delivered step 2.3 (the projects API). Step 2.4 is the web UI for projects and project members and the
browser-level end-to-end scenario that ADR-0010 and ADR-0011 assign to it. The investigation behind this ADR found that the web app is
still a shell: it has two features (`health`, `home`), **no authentication, no organization concept, and no form, table, dialog or
confirmation component**, and the repository contains **no browser test tooling**, which an earlier decision excluded on purpose. Four
decisions cannot be left to the implementation because they cross existing decisions or shape every later screen. They were reviewed
and approved in principle on 2026-11-16 (D1 to D3 by name; D4 and D5 are the corrections the review required). This ADR records them,
the evidence they rest on and the design that follows. It is the only deliverable of this step.

Guides: [frontend.md](../architecture/frontend.md), [ci.md](../architecture/ci.md), [docker-compose.md](../architecture/docker-compose.md),
[backend.md](../architecture/backend.md).

## Summary of decisions

| #   | Decision                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Playwright (`@playwright/test`, Chromium only) for real-browser E2E**, inside the existing `tests/system` project, as its own runner entry and its own Linux CI job. Never on Windows.                                                                         |
| D2  | **The organization id in the URL is the source of truth** for every organization-scoped page, with nested project routes under `/organizations/:organizationId/projects`. The last-used organization is a persisted preference used only for the first redirect. |
| D3  | **A small frontend-only pure permission helper** built from the existing contract definitions. `packages/contracts` does not change. The backend stays authoritative.                                                                                            |
| D4  | **Session expiry is handled once, in both the `QueryCache` and the `MutationCache`**, driven by state (never by navigation from the handler). The session entry is preserved and updated; every other non-public entry is removed.                               |
| D5  | **Scope and routes are fixed**: what the UI does with organizations, the real pagination contracts it must respect, and a feature graph that passes the existing boundary checks.                                                                                |

## Verified facts (the evidence)

Every row was read in the repository on 2026-11-16 (`main` at `81c23cc`); none comes from memory or from an earlier summary.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| V1  | **Pagination is `limit` (1 to 100, default 20) and `offset` (>= 0); the answer is `{ items, page: { limit, offset, total } }`.** Anything outside the bounds is `400 validation_error`.                                                                                                                                                               | `contracts/src/pagination.ts`                                                                                 |
| V2  | **`GET /projects/:projectId/members` takes `limit` and `offset` only.** No filter, no search, no sort. Explicit members only (an organization owner or admin appears only if they also hold a project role). Ordered by join time, then id. Needs `project.read`. It works on an archived project.                                                    | `project-members.controller.ts`, `prisma-project-member.repository.ts`                                        |
| V3  | **`GET /organizations/:organizationId/members` takes `limit` and `offset` only**, ordered by join time then id, with `userId`, `email`, `displayName`, `role`, `joinedAt`. Needs `member.read`, which **every** organization role holds.                                                                                                              | `members.controller.ts`, `organizations.ts`, `permissions.ts`                                                 |
| V4  | **`GET /projects`** takes `organizationId` (required, a selector), `status` (`active` default, `archived`, `all`), `limit`, `offset`. Visibility is applied inside the query, so `total` counts only what the caller may see. Ordered by creation time then id.                                                                                       | `contracts/src/projects.ts`, `prisma-project.repository.ts`                                                   |
| V5  | **No endpoint of Phase 2 accepts `sort` or a search term.** `sortQuerySchema` exists in contracts but only a convention test uses it. There is no user-search endpoint.                                                                                                                                                                               | search of `apps/` for `sortQuerySchema`                                                                       |
| V6  | **`GET /organizations`** (the caller's organizations, each with their role, paginated) and **`GET /organizations/:organizationId`** (one organization with the caller's role; `404` for a non-member) both exist.                                                                                                                                     | `organizations.controller.ts`                                                                                 |
| V7  | The permission catalog is code. Organization keys list `roles`; project keys list `roles` (implicit access: owner, admin) and `projectRoles` (access on that one project). **A union type makes a project role on an organization key a compile error.** `roleHasPermission` and `projectRoleHasPermission` are exported from the contracts package.  | `contracts/src/permissions.ts`                                                                                |
| V8  | The API's effective permissions are `permissionsFor(role, projectRole)`: the organization role's keys plus the project role's project-scoped keys **on that one project**. Tests pin the whole table and the properties P1 (organization decisions never change), P2 (one project), P3 (a project role adds only project-scoped keys).                | `organizations/domain/membership-policy.ts`, `permissions-union.spec.ts`, `contracts/src/permissions.spec.ts` |
| V9  | A project the caller cannot see is `404 project_not_found`, never 403. A visible project the caller may not act on is `403`. **An archived project can be read; updating it or changing its members is `409 project_archived`; archive and restore are idempotent `200`.**                                                                            | `project-access.ts`, `project.service.ts`, `project-member.service.ts`                                        |
| V10 | A failed sign-in is **`401 invalid_credentials`**; a missing or expired session is **`401 unauthenticated`**. A wrong current password on a password change is `422 invalid_current_password`. Validation failures are `400 validation_error` with `details: [{ path, message }]`. Logout is `204`.                                                   | `identity/application/errors.ts`, `auth.controller.ts`, `zod-validation.pipe.ts`                              |
| V11 | The session cookie is `HttpOnly`, `SameSite=Lax` and `Secure` only when the configured origin is HTTPS. The API checks `Origin == WEB_ORIGIN` on state-changing requests. Compose sets `WEB_ORIGIN=http://localhost:${WEB_PORT}`, and the web container proxies `/api`.                                                                               | `session-cookie.ts`, `csrf.ts`, `docker-compose.yml`                                                          |
| V12 | `tests/system` owns the throwaway-stack harness (`Stack`: random project name `agentos-systest-<id>`, own volumes, network, ports and credentials, a guard that aborts if the developer's environment leaks in, image-provenance check). It is tagged `type:app`, `scope:backend` and has no `test` target, so `pnpm test` and `pnpm verify` skip it. | `tests/system/src/stack.ts`, `global-setup.ts`, `package.json`                                                |
| V13 | CI has `verify`, `integration` and `system` jobs plus the single required `CI result`. Windows CI runs format, lint, architecture, typecheck, test and build and **cannot run Linux containers**. `ci.md` lists browser/E2E tests as "not included (by decision)".                                                                                    | `.github/workflows/ci.yml`, `windows.yml`, `ci.md`                                                            |
| V14 | ADR-0005 decision 8 says "No browser end-to-end framework", with the reason that Testing Library covers behavior and one manual browser check covered layout.                                                                                                                                                                                         | `0005-frontend-architecture.md`                                                                               |
| V15 | ADR-0010 decision 9 says "the active organization/project is a browser preference, sent explicitly on every request and never trusted by the server".                                                                                                                                                                                                 | `0010-identity-organizations-projects.md`                                                                     |
| V16 | Web boundaries: `shared` imports no feature or app; features import no `app/`; `app/` reaches a feature only through its `index.ts`. **`tools/check-module-boundaries.mjs src/features` forbids imports into another feature's internals and cycles between features. It does not forbid one feature importing another's public `index.ts`.**         | `eslint.config.mjs`, `tools/check-module-boundaries.mjs`, `apps/web/package.json`                             |
| V17 | `createQueryClient()` sets no `QueryCache` or `MutationCache`; queries retry only network, timeout and 502/503/504; mutations never retry. There is no global handling of `401`.                                                                                                                                                                      | `apps/web/src/app/providers/query-client.ts`, `shared/api/errors.ts`                                          |

## Decisions

### D1. Real-browser E2E with Playwright, Linux only, inside `tests/system`

**Decision.** Browser-level end-to-end tests use Playwright's test runner (`@playwright/test`) with **Chromium only**.

**Where it lives (chosen from the repository, not for convenience).** The valuable and dangerous part of a system test in this
repository is not the runner but the **stack harness** (V12): the isolation guard that strips the developer's environment, the random
project names and ports, the generated credentials, the image-provenance check and the rule that nothing can delete another project's
volumes. A second project would have to either copy that code (two copies of a safety mechanism that exists so that tests can never
touch a developer's data) or move it into a new shared package (a new abstraction for one consumer, and a `type:lib` that would carry
Docker and Redis dependencies). Therefore:

- The browser tests live **in `tests/system`** (`browser/*.browser.ts`) and import `src/stack.ts` directly.
- They are **a separate runner entry, not part of the Vitest run**: their own config (`playwright.config.ts`), their own script
  (`test:browser`, exposed as a root `pnpm test:browser` like every other CI step), their own file suffix so neither runner can pick up
  the other's files. The Vitest system tests, their timeouts and their `include` are unchanged.
- Why not drive the `playwright` library from Vitest: the web-first assertions, locator auto-waiting, traces and failure artifacts of
  the Playwright runner are exactly what stabilizes asynchronous UI tests (the repository has already seen a timing flake in a web
  test on Windows), and re-creating them by hand would be more code than the second runner.

**CI isolation.**

- A **new Linux job `browser`** in `ci.yml`. It installs Chromium (`playwright install --with-deps chromium`, with the browser cache keyed
  on the Playwright version) and runs `pnpm test:browser`. **The existing `system` job is not modified and never installs a browser.**
- `browser` is added to `ci-result.needs`, so the single required status still fails unless it succeeded. No `continue-on-error`.
- **`windows.yml` is not touched**: no browser installation, no browser execution, no Docker. A developer on Windows may run
  `pnpm test:browser` locally after installing Chromium once; CI never does.
- The job uploads Playwright traces and screenshots **on failure only**, with a short retention. They come from a throwaway stack with
  generated credentials and contain nothing real.
- The same leftover-project safety net as the `system` job (limited to the `agentos-systest-` prefix) runs `if: always()`.
- The existing API-level system tests stay as they are and stay in the `system` job.

**Test isolation rules.** One throwaway `Stack` per browser run (booted once, destroyed at the end) with `AUTH_ALLOW_REGISTRATION=true`;
a fresh browser context per test (no shared storage state, so cookies never cross tests); the browser opens `http://localhost:<webPort>`,
**not** `127.0.0.1`, because the API accepts only `WEB_ORIGIN` (V11); a test fails on any request to a host other than that origin
(hermetic: the suite must never depend on the internet, and an accidental third-party asset is a finding); a context with
`locale: 'fa-IR'` drives the Persian/RTL check (the browser's language list decides the first language, per `frontend.md`); Chromium
only, one worker, no retries (a retry would hide the flake it should expose; revisit with evidence). Setup that is not under test
(extra users, a second organization) goes through the API; the behavior under test goes through the UI.

**How this supersedes ADR-0005 (a scoped narrowing; ADR-0005 is not edited).** ADR-0005 decision 8 reads "No browser end-to-end
framework: component and routing tests with Testing Library cover the behavior". This ADR supersedes **only the prohibition** and
only for **system-level browser tests in `tests/system`**. Everything else in ADR-0005 stands: `apps/web` gets no browser framework and
no Playwright dependency; Testing Library with jsdom remains the unit, component and routing layer and is not replaced; there is no
visual-regression or screenshot-comparison testing; the ADR-0005 statement that a real browser verified layout once is a historical
fact, not a policy, and browser E2E now checks the behavior that jsdom cannot (a real cookie session across a reload, real navigation,
real direction). The "not included (by decision)" list in `ci.md` is superseded for browser tests in the same way and is updated when
this ADR is accepted, together with `frontend.md` sections 9 and 12 which repeat the old statement.

**Dependency (CLAUDE.md rule 4).** One new development dependency, `@playwright/test`, in `tests/system` only, pinned to an exact version
chosen at implementation (an established release, not the newest). Why: there is no equivalent in the repository, and the alternatives
(Cypress, Selenium/WebDriver, Puppeteer) were rejected below. It is installed on every OS by `pnpm install` as a package; **the browser
binary is downloaded only by the explicit `playwright install` step in the `browser` job** (to be confirmed when the dependency is
added; if the package turns out to download browsers or to need an `allowBuilds` entry, that is reported before merging, not worked
around). Chromium is the only browser exercised; Firefox and WebKit are not, and the documentation must say so.

### D2. The organization id in the URL is the source of truth

**Decision.** Every organization-scoped page is addressed by `:organizationId` in the path. The shell, the page and every query take the
organization from the route and from nowhere else.

**Routes.**

| Route                                                        | Page                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `/sign-in`, `/sign-up`                                       | Public, outside the shell.                            |
| `/projects`                                                  | **Only a redirect**: see below.                       |
| `/organizations/:organizationId/projects`                    | The project list (and creation).                      |
| `/organizations/:organizationId/projects/:projectId`         | A project's details, as the layout of the tabs below. |
| `/organizations/:organizationId/projects/:projectId/members` | A project's members (second tab).                     |

**Route decision (approved).** The project pages are the three **nested organization-scoped routes** above, exactly:
`/organizations/:organizationId/projects`, `/organizations/:organizationId/projects/:projectId` and
`/organizations/:organizationId/projects/:projectId/members`. The alternative `/projects/:projectId` is not used.

- **The organization id in the path is URL context, not authorization.** It exists so that a refresh, a shared link and the browser's
  back button always show the organization the page belongs to, and so that the shell's organization switcher knows the current
  organization on every page. It grants nothing and hides nothing.
- **The backend still validates access on every request.** The organization id is sent as a selector where an endpoint takes one
  (`GET /projects?organizationId=`, `POST /projects`) and the server checks it against the caller's memberships (404/403, ADR-0010
  decision 4.1, ADR-0011 decision 5). A forged, stale or foreign id yields the same not-found, never data.
- **The API continues to address projects by project id.** Every project request is `/api/v1/projects/:projectId[...]`; the API never
  reads the organization of the web route.
- **A project/organization mismatch is the same not-found.** If the loaded project's `organizationId` differs from `:organizationId`
  in the path, the page renders the same "not found or no access" state as `404 project_not_found`: the same text, no project field
  (name, status, description) on screen or in the document title, and no message that says the project exists elsewhere. The check is a
  guard against showing a project under the wrong organization, not a security control.

**The persisted preference.** The last-used organization id is a browser preference (the existing Zustand store in `app/state`). It is
used **only** by the `/projects` redirect and by nothing else. Rules:

- It is validated against the caller's real organization list before use. An id that is absent, stale or not in the list is discarded
  and the user sees the organization chooser (or "create your first organization"). It is also cleared on sign-out.
- It never replaces the id in the URL, never decides what a request carries, and never decides what is shown as allowed.
- It is updated when the user opens an organization page (the URL wins; the preference follows the URL, never the reverse).

**Organization switching** is a navigation to `/organizations/:id/projects` (a project page of the old organization is not reinterpreted
under the new one). Every query key that depends on an organization contains its id, so switching can never show the previous
organization's cached rows under the new one. `404 organization_not_found` (malformed, foreign, or not a member: indistinguishable by
design) renders one not-found state with a link to the chooser.

**Refinement of ADR-0010, stated without rewriting it.** ADR-0010 decision 9 says the active organization is "a browser preference, sent
explicitly on every request and never trusted by the server". That historical decision is **kept**: the server still treats the
organization id as a selector and validates it (ADR-0010 decision 4.1; ADR-0011 decision 5), and every request still carries it
explicitly. What this ADR refines is the **client**: the preference is no longer the active organization; the URL is, and the preference
survives only as the starting point of a redirect. An implementation note to this effect is proposed for ADR-0010 (see "Documentation
that follows"), and is added when this ADR is accepted.

### D3. A frontend-only pure permission helper

**Decision.** The web app gets one small pure module that answers "may this person see this control" from two facts the API already
returns: the caller's organization role (`GET /organizations/:id`, V6) and, on a project, the caller's explicit `projectRole` (a field of
the project response). It is built from `PERMISSIONS`, `roleHasPermission` and `projectRoleHasPermission`, which are already exported by
`@agentos/contracts` (V7). **`packages/contracts` is not modified, no package is created, and the API is not modified.**

**Shape (indicative).** `can(subject, key)` with `subject = { organizationRole, projectRole? }`:

- an organization role holds the key if `roleHasPermission(organizationRole, key)` (for a project-scoped key this is the implicit access of
  owners and admins on every project);
- a project role is consulted **only when the key's scope is `project`** and then through `projectRoleHasPermission`;
- therefore **a project role can never add an organization-level permission**: `project.create`, `project.list`, `member.manage`,
  `organization.update` and the rest answer from the organization role alone, whatever project role is passed.

A second pure function derives the actions of one project page (read, edit, archive or restore, manage members) and applies the
**archived** rule that the server enforces (V9): an archived project is read-only; update and member changes are shown disabled with the
reason; Restore is offered to holders of `project.archive`; Archive is offered only while active.

**Placement.** `features/projects/permissions.ts`: the only consumer is the projects feature, and `frontend.md` moves code to `shared/`
when a second feature needs it. It imports `@agentos/contracts` and nothing else.

**Backend authority.** The helper only chooses what to **show**. It is never a reason to skip a request or to trust an answer: the server
re-evaluates every call, a project the caller cannot see stays an indistinguishable `404`, and any `403` or `404` returned for an action
the UI offered is treated as "your access changed": the page refetches the organization role and the project and re-renders. A role the
UI got wrong is therefore a harmless refusal, not an escalation.

**Testing against the approved matrix.** The web cannot import the API (a boundary) and must not import another package's spec files.
The web test therefore carries **an independently written table** with the same content as the two tables that already pin the backend:
`contracts/src/permissions.spec.ts` (`EXPECTED`, `EXPECTED_PROJECT_ROLES`) and `organizations/domain/permissions-union.spec.ts`
(`ORGANIZATION_KEYS`, `IMPLICIT`, `EXPLICIT`). It asserts, for **every organization role x every project role (and none) x every key**,
the helper's answer, plus: the exact set of keys (a new key fails the test until a row is added on purpose), P1 (a project role never
changes an organization-scoped answer), P3 (it only ever adds project-scoped keys), the union example of an organization `viewer` with
`project_admin` (administers that project, still cannot create a project), and every archived-project combination. This duplicates a
table on purpose; the cost is that a deliberate matrix change touches three tests, and the guard is that none of them can pass if they
disagree with the catalog. The browser suite adds one end-to-end agreement check on representative roles: the control the UI hides is also
refused by the API (a direct request answers 403/404).

### D4. Session expiry and cache lifecycle (the corrected `401` design)

The first version of this design had one handler on the `QueryCache` that set the session to `null` and then removed "every private
query", with privacy decided by query `meta`. That had two defects, both corrected here: (a) a failed **mutation** can also return `401`,
so both caches must handle it; (b) **the session entry could be removed by the cleanup that follows its own update**, because
classification by `meta` fails closed: an entry that has no `meta` is private, and a query created by `setQueryData` (as the sign-in
success does when no probe ran before) has none. The cleanup must never be able to touch the entry that holds the authentication state.

**Rule 1: privacy is decided by the first element of the query key, from one explicit list, never by `meta`.** `features/auth` exports one
constant, the **public key roots**: `session` and `health`. A query is **private unless its key root is in that list**, so a query with an
unknown or new root is private (fail-closed), and no query can opt itself out by metadata. Every feature's key factory begins with its own
root (`['projects', ...]`, `['organizations', ...]`); a test enforces it for every factory.

**Rule 2: exactly one session entry, `['session']`, that is never removed.** Its value is one of three explicit states:
`{ status: 'authenticated', user }`, `{ status: 'anonymous' }` or `{ status: 'unknown' }`. An entry with no value yet (before the first
probe answer) is read as unknown.

| State             | Cache entry                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **unknown**       | no value yet, or `{ status: 'unknown' }`               | The app does not know who is signed in: before the first probe answer, or after a sign-out whose outcome is uncertain (Rule 6, "unresolved"). **No private UI is mounted, no private query executes, no private data is in the cache.** `RequireAuth` shows "checking your session" while the first probe is in flight and an error with **Retry** when it failed; after an uncertain sign-out it shows "sign-out is not complete" with **Retry sign-out**. It never redirects here and **never claims the user is signed out**. |
| **authenticated** | `{ status: 'authenticated', user }` (id, e-mail, name) | Private queries may run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **anonymous**     | `{ status: 'anonymous' }`                              | Signed out or expired. **A stable terminal state**: nothing refetches it into a user and nothing removes it.                                                                                                                                                                                                                                                                                                                                                                                                                     |

The probe's query function maps `401 unauthenticated` to anonymous instead of throwing; the sign-in and sign-up pages are public routes
and read the same entry. The session entry is **changed** only by `features/auth`, and only through the transition contract of Rule 5; it
is never removed, invalidated or cleared. The auth module keeps two small values next to the client (module state, not queries): the
**generation**, an integer increased by every transition, and the **owner**, the id of the user whose data the private cache holds (or
none). `RequireAuth` renders its `<Outlet />` **only** in the authenticated state, so every other state unmounts the private UI.

**Rule 3: one purge, one function.** `purgePrivateData(client)` calls `cancelQueries` with the private predicate and then
`removeQueries` with the **same** predicate. Cancellation is requested synchronously; the promise `cancelQueries` returns is **not
awaited**, and nothing depends on it (see Rule 5, completion). It never touches `['session']` or `['health']`. A request that was in
flight when the purge ran has its query destroyed by `removeQueries`, so its late response cannot write into the cache. The purge is
idempotent. `queryClient.clear()` and an unfiltered `invalidateQueries()` are never used, anywhere.

**Rule 4: both caches call the same function.** `createQueryClient` installs `QueryCache.onError` and `MutationCache.onError`; both call
`handleUnauthenticated(error, origin)`. It acts only on an `ApiClientError` with **status 401 and code `unauthenticated`**
(V10). Not covered: `invalid_credentials` (a failed sign-in) and `invalid_current_password` are different codes; mutations marked
`meta: { auth: true }` (sign-in, sign-up, sign-out) are skipped, because their own transition below handles their outcome. `meta` is used
only for this skip, never for privacy.

**Rule 5: the session transition contract.** A _transition_ is any change of the published session value to a different one. Every
transition, whatever starts it (sign-in, sign-out, a `401` accepted by Rule 4, a session-probe result, the completion of an unresolved sign-out in Rule 6),
runs the following **ordered block synchronously, with no `await` inside it**, for `next`, a session value:

1. Increase the **generation**.
2. If `next` is not authenticated, or `next.user.id` differs from the **owner**: run the purge (Rule 3). Sign-in always purges.
3. **Publish** `next` (`setQueryData` on `['session']`) and set the owner to `next.user.id` if authenticated, otherwise to none.
4. If `next` is **anonymous**: call the application's session-ended callback (it clears the stored last-used organization; `features/`
   cannot import `app/`, so `createQueryClient` receives the callback). Unknown does not clear it: nothing is known yet, and the value is
   validated on use anyway.

Publishing a value equal to the published one is not a transition: no block runs and the generation does not change. The purge (step 2)
comes **before** the publication (step 3), so a new identity is never visible while the previous identity's data is still in the cache.

- **When the claim is taken, and the lock.** There is no separate lock. Because the block has no `await`, JavaScript cannot run another
  callback inside it: a second `401`, from the same cache or from the other one, runs either before the block (and then performs it) or
  after it (and then finds the state already changed and does nothing). The state change is therefore taken before the first
  asynchronous operation of the transition, because the block contains none.
- **While the `cancelQueries` promise is pending.** Nothing waits for it. By then the block has returned, the session is already
  published and the private entries are already removed; a second `401` is handled under the acceptance rule below.
- **Complete** means the block has returned. Cancellation was requested, the private entries were removed, the session was published
  and the callback (if any) ran. A response that arrives later lands in a destroyed query and writes nothing.
- **Generation capture: queries and mutations alike.** Every private request records the generation current **when it starts**, in a
  `WeakMap` keyed by the request object. Queries: the auth module subscribes to the `QueryCache` and records it when a fetch of a
  private query starts (the `updated` event whose action is `fetch`); a refetch records again. Mutations: the `MutationCache` start
  callback (`onMutate`) records it. Public queries (`session`, `health`) and auth mutations are not stamped. A request that starts while
  the session is not authenticated records nothing and (execution gate, below) does not run.
- **Acceptance rule for a `401` (Rule 4).** The handler starts a transition to anonymous only if (a) the session is **authenticated**,
  and (b) the request has a recorded generation **equal to the current generation**. Otherwise it does nothing: no purge, no navigation,
  no message. This holds for **queries and mutations identically**. Session isolation therefore does **not** rest on cancellation: the
  purge still cancels and destroys private queries (so late data cannot be written), but whether a `401` may end a session is decided by
  the generation alone. A `401` for user A's request that arrives after user B signed in, or while the session is unknown or anonymous,
  or from a request with no stamp, is ignored.
- **Execution gate: private requests do not run unless authenticated.** Queries: the client's default `enabled` option is a function
  that is true for the public roots and otherwise true only while the session is authenticated. Mutations: the `MutationCache` start
  callback rejects a non-auth mutation with a local error, **before it is sent**, when the session is not authenticated. The gate is a
  second layer: the private UI is not mounted outside the authenticated state in the first place.
- **Private data is fetched only through the gated path (enforced).** The approved path is the observer path: a feature's hook in
  `queries.ts` built on `useQuery`/`useInfiniteQuery`, which the `enabled` gate covers. The imperative client methods ignore the gate, so
  they are **prohibited outside `features/auth`**: `fetchQuery`, `prefetchQuery`, `ensureQueryData`, `fetchInfiniteQuery`,
  `prefetchInfiniteQuery`, `ensureInfiniteQueryData` and `refetchQueries`; and, because a late callback must not repopulate purged
  data, `setQueryData` and `setQueriesData` on private entries. Inside `features/auth` they may be used only for the public roots
  (`['session']`, `['health']`), which is the session probe and the transition block. A route `loader` that prefetches is covered by the
  same ban. A `refetch()` returned by a mounted query hook is allowed: it exists only while the private subtree is mounted, and that
  exists only while authenticated. **Enforcement:** these calls are added to the web `no-restricted-syntax` rule (the list that already
  forbids `import.meta.env`), applied to `apps/web/src` except `features/auth` and test files, so `pnpm lint` fails on a violation; a
  planted violation is used to show it fails, as was done for the boundary rules (V16). Reviews of `features/auth` check the keys.
- **Stale answers: the session probe.** The probe captures the generation when it starts. When its response arrives it compares: if the
  generation changed (a sign-in, a sign-out or another transition finished meanwhile) the result is **discarded**, the
  function returns the value currently in the cache and runs no transition. A probe that fails (network, timeout, 5xx) runs no
  transition and leaves the published value unchanged. A sign-in that finishes while a probe is in flight therefore cannot be overwritten
  by it.
- **The probe publishes through the same block.** The probe's query function runs the block itself after the response arrives (the hook
  that defines the query closes over the client). Step 3 is a `setQueryData` on `['session']` **inside the block**, not the value the
  function returns: TanStack Query stores a returned value only after the function returns, which would leave a gap in which the old
  identity is still published but its data is already gone. The function then returns the same `next`, so the later automatic store
  changes nothing. A test pins that a `setQueryData` made inside a running probe behaves this way. When the probe returns the same user
  as the owner there is no change of identity: it refreshes the value and does not transition.

**Rule 6: sign-out, uncertain outcomes, and completing the sign-out.** When a sign-out request ends without a definite answer, the
interface can neither keep showing private data nor claim that the user is signed out. This rule was first written to settle the doubt
with a `GET /me` probe. The backend does not allow that, so the rule completes the sign-out instead.

_What the backend does (read in the repository on 2026-11-16)._

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| B1  | A logout is one transaction at the PostgreSQL default isolation (READ COMMITTED): `UPDATE session SET revoked_at … WHERE id = … AND revoked_at IS NULL`, then an audit insert. The transaction may wait up to 2 s for a connection and run up to 5 s. **The revocation is invisible to every other connection until the transaction commits.**                                                                                                     | `session.service.ts` `logout`, `prisma-session.repository.ts` `revoke`, `database/transaction.ts` |
| B2  | Every authenticated request, `GET /me` included, is checked by `SessionService.resolve`, which reads PostgreSQL only (no cache) and accepts a session whose `revoked_at` is still null.                                                                                                                                                                                                                                                            | `authentication.guard.ts`, `session.service.ts` `resolve`                                         |
| B3  | The API has no handling that cancels a request when the client disconnects (a search of `apps/api/src` for close, abort and `AbortSignal` finds none). A logout the client gave up on can still commit afterwards, or may never have arrived.                                                                                                                                                                                                      | search of `apps/api/src`                                                                          |
| B4  | The integration test checks that `GET /me` answers `401` **after a completed logout**. No test pins the answer to a probe sent while a logout is unresolved.                                                                                                                                                                                                                                                                                       | `apps/api/test/identity.int.spec.ts` ("logout ends only the current session…")                    |
| B5  | `revoke` returns whether it changed a row, and the audit event is written only when it did. A second logout either passes the guard and answers `204` (its `UPDATE` waits for the row lock of a concurrent revocation and then matches nothing, or revokes itself if the first rolled back; PostgreSQL's documented READ COMMITTED behaviour), or is refused by the guard with `401 unauthenticated` because the revocation has already committed. | `session.service.ts`, `prisma-session.repository.ts`, `authentication.guard.ts`                   |

_Conclusion._ **The backend does not guarantee that a `GET /me` sent after a timed-out logout observes its final result** (B1, B2, B3):
before the commit the probe answers `200` with the user, after it `401`. A probe must therefore never be what restores private UI after an
unresolved logout. **Repeating the logout is conclusive** (B5): `204` or `401 unauthenticated` both mean the session is revoked and
committed when the answer arrives, whichever request did it. B5 is confirmed against real PostgreSQL before the implementation relies on it
(Q5).

| `POST /auth/logout` outcome                                                                        | Meaning                       | Transition                                                 |
| -------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `204`                                                                                              | confirmed                     | block(**anonymous**); the user lands on `/sign-in`         |
| `401` with code `unauthenticated`                                                                  | the session was already ended | block(**anonymous**); the same                             |
| network error, timeout, `5xx`, **or any other outcome** (including a `4xx` that is not that `401`) | uncertain                     | block(**unknown**) with the sign-out marked **unresolved** |

- **Entering unknown.** The block increases the generation, **purges** (private queries cancelled and removed), publishes unknown and
  sets the owner to none. The auth module sets a flag, **sign-out unresolved**. From the next render `RequireAuth` does not render the
  `<Outlet />`, so the private UI is unmounted; the execution gate stops any private query or mutation from running. The stored last-used
  organization is not touched. The user sees "sign-out is not complete", never "signed out" and never private data.
- **Completing the sign-out.** Right after the block the auth module sends the logout request **again, once** (a new request under the
  new generation). `204` or `401 unauthenticated` ends the sign-out: block(**anonymous**), flag cleared, the stored last-used organization
  cleared, `RequireAuth` redirects to `/sign-in`. If the repeat is uncertain too, the value stays unknown and the screen offers
  **Retry sign-out**, which sends the request again. There is no timer and no automatic loop: one automatic repeat, then only the user's
  action.
- **No probe can restore the session while the sign-out is unresolved.** While the flag is set the session probe does not run (its
  `enabled` is false, so a window-focus refetch does nothing), and a probe result that still arrives is discarded (its generation is
  older, Rule 5). The only ways out of an unresolved sign-out are the two definite outcomes above, or a sign-in (below). The interface
  never returns to the authenticated state from an unresolved sign-out by checking the server.
- **A sign-in supersedes.** A sign-in that succeeds while the sign-out is unresolved runs its block (generation increased, flag cleared).
  The sign-out request captured the generation when it started, so an outcome that arrives after the sign-in is ignored and cannot end
  the new session.
- **Deduplication.** Repeated clicks: the sign-out and Retry controls are disabled while a logout request is pending, and the auth module
  returns the in-flight promise to a second call, so one request is sent. A transition to unknown while already unknown is not a
  transition (Rule 5), so a second uncertain outcome cannot change the generation.
- **Known limit after a reload or in another tab.** The flag is memory only. If the page is reloaded, or the app is opened in a new tab,
  before the server-side logout has been committed, the first probe can still find the session valid and previously authenticated UI may
  temporarily appear. It can stay until the logout is committed and that tab learns of the unauthenticated state: its next private
  request answers `401` and Rule 4 signs the user out, or its next session probe answers `401`. **No upper bound on that time is
  claimed.** The 2 s (waiting for a connection) and 5 s (running) limits of B1 describe backend processing only once the request has
  entered the transaction. They do not bound the time until a timed-out request reaches the server or starts being processed: a browser
  timeout does not prove that the request arrived, network delay can postpone its arrival, and it may never arrive. This is recorded
  under limitations; it is not closed by persisting the flag, and cross-tab synchronization is out of scope for Phase 2.4. The tab that
  started the sign-out is not affected: it stays fail-closed as described above (unknown, private UI unmounted, no probe).

**Transitions (the complete list).** `S` is the session value; "private" is Rule 1; the stored last-used organization is the preference
of D2. "Block" is the ordered block of Rule 5, so "purged" always means "purged before the new value is published".

| Event                                                                       | Session value `S`                                   | Private queries                     | Last-used organization | Navigation and what the user sees                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| App start, probe returns a user                                             | unknown -> **authenticated**                        | none exist yet                      | kept, validated on use | none                                                                                                                   |
| App start, probe returns `401`                                              | unknown -> **anonymous**                            | none exist yet                      | cleared if present     | `RequireAuth` redirects to `/sign-in` with `from`                                                                      |
| App start, probe fails (network, timeout, 5xx)                              | stays unknown                                       | none exist                          | untouched              | no redirect; error state with Retry                                                                                    |
| Sign-in succeeds (user `u`)                                                 | -> **authenticated** (`u`), block                   | **purged first**, then published    | kept, validated on use | the sign-in page navigates to `from`, else `/projects` (the page, not a cache callback); clears an unresolved sign-out |
| Sign-in fails (`401 invalid_credentials`, `429`, ...)                       | unchanged                                           | unchanged                           | unchanged              | the form shows the translated error                                                                                    |
| Sign-out answers `204`                                                      | -> **anonymous**, block                             | **purged**                          | **cleared**            | `RequireAuth` redirects to `/sign-in`                                                                                  |
| Sign-out answers `401 unauthenticated`                                      | -> **anonymous**, block                             | **purged**                          | **cleared**            | the same                                                                                                               |
| Sign-out: network error, timeout, 5xx or any other outcome                  | authenticated -> **unknown**, block, **unresolved** | **cancelled and removed**           | untouched              | private UI unmounts at once; "sign-out is not complete"; **not** presented as signed out; one automatic repeat sent    |
| The repeated sign-out answers `204` or `401 unauthenticated`                | unknown -> **anonymous**, block, flag cleared       | none                                | **cleared**            | `RequireAuth` redirects to `/sign-in`                                                                                  |
| The repeated sign-out is uncertain again                                    | stays unknown (unresolved)                          | none                                | untouched              | "sign-out is not complete" with **Retry sign-out**; no probe; no redirect                                              |
| A session probe is due (window focus, Retry) while a sign-out is unresolved | stays unknown                                       | none                                | untouched              | the probe does not run; a result that still arrives is discarded; the session is never restored by checking the server |
| A private query or mutation answers `401 unauthenticated`, current stamp    | authenticated -> **anonymous**, block               | **purged**                          | **cleared**            | `RequireAuth` redirects to `/sign-in` with `from`; "your session ended" once                                           |
| A `401` while unknown or anonymous, with an older stamp, or with no stamp   | unchanged                                           | unchanged                           | unchanged              | ignored (user B stays signed in after user A's late answer)                                                            |
| Later probe returns a **different** user `B` while the owner is `A`         | -> **authenticated** (`B`), block                   | **purged first** (A's rows removed) | validated on use       | `RequireAuth` renders `<Outlet key={user.id} />`: A's subtree unmounts and B's mounts after the purge; sequence below  |
| Later probe returns the same user as the owner                              | refreshed, no block                                 | untouched                           | untouched              | none                                                                                                                   |
| Later probe returns `401` while authenticated                               | authenticated -> **anonymous**, block               | **purged**                          | **cleared**            | `RequireAuth` redirects                                                                                                |
| Later probe fails while authenticated                                       | unchanged                                           | untouched                           | untouched              | none (a failed check is not a session event)                                                                           |
| Probe answers after another transition finished (generation changed)        | unchanged (result discarded)                        | unchanged                           | unchanged              | none                                                                                                                   |

**Identity change discovered by the probe: the exact order** (user `B` found while the owner is `A`; user `A`'s routes are mounted):

1. The probe started in generation `g` and A's private routes are mounted and showing A's data.
2. The response (user `B`) arrives; the generation is still `g`, so it is accepted.
3. Inside the probe's query function, before it returns, the block runs: generation becomes `g + 1`; B differs from the owner A, so the
   purge runs: cancellation of A's in-flight private queries is requested and **every private entry is removed**.
4. The session is published as `B` and the owner becomes `B` (the function returns `B` and TanStack Query stores it).
5. Only now can React render, because steps 3 and 4 (the purge, and the `setQueryData` publication) had no `await`. The first render sees
   `B` and `RequireAuth` gives its `<Outlet />` the key `B`'s id, so **A's subtree is unmounted without being re-rendered** and B's
   subtree is mounted; its new observers create new queries, which execute for the first time here. These are the first private queries
   that run under B.

_Private queries are blocked_ from step 3 until step 5: creating one needs a render, and no render happens between them. _A's data is
never rendered under B_: it is removed from the cache at step 3, and the only subtree whose observers could still hold it is unmounted
by the key change before it could render again. Both claims are acceptance tests (Testing strategy).

**What is preserved, updated and removed, by key.**

| Query key root                                                | Preserved | Updated                                          | Removed on purge |
| ------------------------------------------------------------- | --------- | ------------------------------------------------ | ---------------- |
| `['session']`                                                 | always    | by `features/auth`, through the transition block | **never**        |
| `['health']` (public, unrelated to the user)                  | always    | by its own query                                 | never            |
| `['organizations', ...]`, `['projects', ...]`, any other root | no        | by their features while authenticated            | **always**       |

**Loop-proofing, restated against this lifecycle.**

- Navigation is a function of the session state only: `RequireAuth` redirects to `/sign-in` when and only when the state is anonymous;
  the sign-in page redirects away when and only when it is authenticated. The two conditions are mutually exclusive, and **unknown
  triggers neither**: it shows a loading or error state, so a failed or uncertain check cannot oscillate between the two routes.
- No cache callback navigates. Auth mutations are skipped by the handler, never invalidate each other, and their transitions are the
  table above. The probe cannot raise the handler (it maps `401` to the anonymous state), and the handler never refetches the session entry: it
  reads it, then runs the transition of the table.
- Private queries are unmounted whenever the state is not authenticated (the private routes are inside `RequireAuth`), the execution
  gate stops any that remain, and `401` is already never retried (V17), so nothing refetches into the handler. The only request
  that repeats is the sign-out itself: once automatically after an uncertain outcome, then only on the user's Retry. There is no timer
  and no probe loop.
- Late callbacks cannot repopulate purged data: in this step, feature mutations update caches by **invalidating their own keys**, never
  by writing with `setQueryData` into private entries, and an invalidation only touches queries that still exist.

A user whose `401` arrives while a form is open loses the form content; after sign-in the router returns to `from`. This is accepted and
listed under limitations.

### D5. Scope, pagination and the feature graph

**Scope.** The UI includes: sign-in and sign-up (registration is closed after the first user, `403 registration_closed`, shown as such);
the signed-out and signed-in shell (user menu, sign-out); **listing the caller's organizations, creating an organization (the
"first organization" flow), selecting one, and reading its members for the project-member picker**; the projects list, create, details,
edit, archive and restore; project members list, add, change role and remove. **Out of scope and deferred:** organization member
management (add, change role, remove), organization settings, ownership transfer, password change, session management screens, project
deletion (there is none), audit views.

**Pagination, exactly as the API has it (V1 to V6).**

- Lists send the real `limit` and `offset` and show the real `total`; page controls are server-driven. No client-side sorting and no
  sortable column headers (the API cannot sort, V5). The default order shown is the API's: oldest first.
- The project filter is the real `status` parameter (`active`, `archived`, `all`).
- **Project members are paginated** (V2): the members tab pages with `limit`/`offset`. It does not assume everything fits on one page.
- **The member picker** reads the organization members (V3), which is paginated and has **no search endpoint**. The picker pages
  through the real endpoint ("load more", 100 per request) and filters **only the rows already loaded**, saying so ("Showing 100 of 240;
  load more to search the rest"). It never claims a search it did not do. Members already in the project are shown disabled **when the
  project's member pages are loaded**; the server remains the authority and answers `409 already_project_member`, which the UI turns into
  a message and a refetch.
- The organization switcher pages `GET /organizations` the same way. The organization role of the page comes from
  `GET /organizations/:id` (V6), not from scanning the list.

**Feature graph (checked against V16).** Features: `auth`, `organizations`, `projects`, plus the existing `health` and `home`.

- `organizations` and `auth` import no other feature.
- `projects` imports **one** other feature, `auth`, through its `index.ts`, for the signed-in user's id (to mark "you" and warn on
  self-removal). `frontend.md` allows this ("a feature's public export") and the checker does not forbid it; it is one-way, so no cycle.
- `projects` reads **organization data through its own queries** (the role from `GET /organizations/:id` and the members from
  `GET /organizations/:id/members`), with its own key factory and the contract schemas. That is the documented preferred form of
  cross-feature communication ("through server state") and avoids an import of `organizations`.
- `organizations` does not know the project routes: its switcher and its "created" flow take the target path from the caller. The
  composition (`/projects` redirect, the shell's switcher, the path builders) lives in `app/`, which may import every feature's `index.ts`.
- `shared/` gains nothing feature-specific. `app/` never imports a feature's internals. `apps/web` imports `@agentos/contracts` only.
- `RequireAuth` and `useCurrentUser` are small exports of `features/auth/index.ts`; the feature's page code stays lazy and out of the
  eager index, as `frontend.md` requires.
- The graph is `app -> {auth, organizations, projects, health, home}` and `projects -> auth`: acyclic. It passes the ESLint zones and
  `check-module-boundaries.mjs` as written; the implementation re-runs both and a planted violation is used to show they still bite.

## Testing strategy

| Layer                       | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Runs in                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Unit (pure)                 | The permission helper against the written-out table (D3); slug suggestion; error-code to message mapping; the `401` rule (only `unauthenticated`, skipped for auth mutations, idempotent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `pnpm test` (Linux, Windows) |
| Component and route (jsdom) | Loading, empty, error and success states; role-aware controls; archived read-only behavior; destructive confirmations; field errors from `validation_error` details; both languages and RTL; guard redirect and `from`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `pnpm test` (Linux, Windows) |
| Cache behavior              | Both caches react to a `401`; the `['session']` entry survives every purge and ends anonymous (also when created by `setQueryData` with no `meta`); `['health']` survives; every other root is removed, a new unknown root included; the block's order (generation, purge, publish, owner, callback) holds with no `await`; a burst of simultaneous `401`s from both caches purges once, including a second `401` while `cancelQueries` is still pending; a `401` while unknown or anonymous is ignored; **a query and a mutation each stamped with an older generation (or not stamped) are ignored, with cancellation disabled in the test so the result rests on the generation alone**; a private query or mutation started while not authenticated does not execute; a probe that answers after a sign-in is discarded; a `setQueryData` made inside a running probe publishes at once and the probe's returned value changes nothing; **identity change: with user A's rows on screen a probe returning B never renders an A row (render spy), no private query runs between the purge and the remount, and the old subtree is unmounted by the key**; sign-in as another user leaves none of the previous user's rows; sign-out `204`/`401` ends anonymous; **a network error, a timeout, a 5xx and another outcome each go to unknown (private UI unmounted, private queries removed, none running) with the sign-out unresolved; one automatic repeat of the logout ends anonymous on `204` or `401` (organization cleared, redirect) and otherwise leaves "sign-out is not complete" with Retry sign-out; while unresolved a window-focus event starts no probe, a probe result that arrives (even a `200` with the user, as in the backend race of B1) is discarded and the UI never returns to authenticated except by a sign-in, which also makes a late sign-out outcome ignored**; a double click sends one logout; an unknown state never redirects; no redirect loop; `invalid_credentials` changes nothing; no `clear()` or unfiltered `invalidateQueries()` is used. | `pnpm test`                  |
| Lint (architecture check)   | **A planted `fetchQuery`/`prefetchQuery`/`ensureQueryData`/`refetchQueries`/`setQueryData` call in a feature outside `features/auth` fails `pnpm lint`; the same call in `features/auth` and in a spec file passes; the session probe and `health` keep working.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `pnpm lint`                  |
| API-level system            | Unchanged (`tests/system/test/*.system.spec.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `system` job                 |
| **Browser E2E**             | Register the first user, sign in, create an organization and a project, add a second user (through the API) as project member, change and remove the role, archive and restore, a viewer who cannot see a hidden control and is refused by the API, a cross-organization `404`, a refresh and a deep link that keep the organization, an expired session that returns to sign-in, Persian/RTL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `browser` job (Linux only)   |

Async waits: component tests use `findBy*`/`waitFor` with a larger default timeout set once in the test setup (the Windows flake seen in
PR #5 was a one-second default under load), never fixed sleeps, and lazy routes are awaited by role/name, not by time.

## Security considerations

- **The URL is not authority.** The organization and project ids in the path are selectors; the API resolves them against the caller's
  memberships on every request (404/403 as in ADR-0010/0011). A forged or stale id yields a not-found state, never data.
- **The UI never decides access.** The helper hides controls; the server refuses. Hidden controls are not a security boundary, and the
  browser suite proves the pair agree for representative roles.
- **No cross-user residue.** Fail-closed private-query removal on sign-out, session expiry and sign-in (D4); the persisted preference holds
  an id only, is validated before use and is cleared on sign-out. Nothing secret (token, password, cookie) is ever stored by the app: the
  session cookie is `HttpOnly` (V11).
- **Private data has one gated path.** Imperative fetches and cache writes of private data are banned by lint outside `features/auth`
  (D4 Rule 5), so the session gate and the generation check cannot be bypassed by a new call site.
- **Several tabs.** A sign-out in one tab does not guarantee the immediate removal of private UI or cache in another tab; see the known
  limitation under Consequences. Nothing in this ADR claims immediate cross-tab sign-out.
- **The sign-in form** sends the password only to the API through `apiRequest`; it is never logged, put in a URL, stored, or placed in a
  query key. Error text comes from translated categories and domain codes, never from raw server messages.
- **User enumeration.** The picker lists only the members of an organization the caller already belongs to (the API shows e-mail addresses
  to members only, ADR-0010 decision 8); the web adds no lookup by e-mail.
- **CSRF.** Same-origin by construction (the web container proxies `/api`); the `Origin` check (V11) is why the browser tests and the
  developer must use the configured origin. A development server on another port fails sign-in with `origin_not_allowed`, and the UI
  turns that code into a message that names the cause.
- **Test infrastructure.** The browser suite runs only against a throwaway stack with generated credentials and fails on any request to a
  third-party host. Traces are uploaded on failure only, with short retention, from stacks that contain nothing real. The Chromium
  download is the one new supply-chain surface: it happens only in the `browser` job, from the Playwright package's own installer, with the
  package pinned.

## Consequences

**Good**

- The behavior that jsdom cannot show (a real cookie session across a reload, real navigation, direction) is covered by a test that runs
  in CI on every pull request, using the same isolation machinery as the other system tests.
- A refresh, a shared link and the back button keep their context; the shell can always show the right organization.
- One session rule for queries and mutations, fail-closed, with no navigation from a cache callback.
- No change to `packages/contracts`, to the API or to the accepted ADRs' decisions.

**Costs and limits (accepted)**

- A second test runner and an additional CI job (its duration is not measured yet; how it obtains the images is an open implementation
  question); one development dependency; a Chromium download in CI.
- Browser tests do not run on Windows CI, and only Chromium is exercised.
- The permission table exists in three tests on purpose (D3).
- A project route path repeats the organization id the API does not need (D2); a path whose organization does not match is a not-found
  state even though the project is reachable by id alone.
- The member picker cannot search beyond the loaded pages and the tables cannot be sorted (V5): limitations of the API, shown honestly.
- The UI-computed permissions can be briefly stale after a role change; the server refuses and the page refetches (D3).
- The Persian text depends on a native review, which is a release criterion (see "Release and acceptance criteria"), not an architecture
  item.
- A user whose session expires loses unsaved form content.
- A sign-out whose outcome is uncertain (network, timeout, 5xx) unmounts the private UI and completes the sign-out by repeating it; the
  user is never returned to the signed-in UI by checking the server. If the repeats keep failing the user sees "sign-out is not complete"
  and Retry, and the server session may still be valid.
- **Known security limitation, after a reload or in another tab:** the unresolved-sign-out flag is memory only, so a reload or a new tab
  opened before the server-side logout is committed can temporarily show previously authenticated UI, until the logout is committed and
  that tab learns of the unauthenticated state (its next private request answers `401`, or its next session probe). No upper bound on
  that time is claimed: the backend's 2 s and 5 s limits (B1) apply only once the request has entered the transaction, not to a timed-out
  request that has not yet reached or been processed by the server (Rule 6). The tab that started the sign-out remains fail-closed.
- **Known security limitation, several tabs:** a sign-out in one tab does **not** immediately remove the private UI or cache of the
  other tabs of the same browser. Each other tab discovers the ended session only on its next private request (a `401`, Rule 4) or its
  next session probe (for example a window-focus refetch when the probe data is stale); until then it can keep displaying data it
  already loaded. Cross-tab session synchronization (for example a `BroadcastChannel` or `storage` event) is **not** part of Phase 2.4
  and is recorded as a future consideration, not a requirement.

## Alternatives considered (and rejected)

| Option                                                                                                                            | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep "no browser E2E" and rely on Testing Library                                                                                 | It cannot show a real cookie session, a reload or a deep link, which are the points of this step and of the `Origin`/cookie design. ADR-0010 and ADR-0011 already promised a browser-level scenario.                                                                                                                                                                                                                                                                                                                   |
| Playwright in a new `tests/e2e` project                                                                                           | It would duplicate or extract the stack harness and its isolation guard (V12); either is worse than reusing the one that exists.                                                                                                                                                                                                                                                                                                                                                                                       |
| `playwright` library driven from Vitest in the same runner                                                                        | One runner, but the assertions and failure artifacts of the Playwright runner are what make asynchronous UI tests dependable; rebuilding them is more code than a second entry point.                                                                                                                                                                                                                                                                                                                                  |
| Install Chromium in the existing `system` job                                                                                     | Couples two failure modes, makes every system run pay for a browser, and contradicts the approved isolation (browser only in its own Linux job).                                                                                                                                                                                                                                                                                                                                                                       |
| Cypress, Selenium/WebDriver, Puppeteer                                                                                            | Cypress and WebDriver bring their own runner and process model next to the Compose harness; Puppeteer has no test runner or auto-waiting assertions. Playwright has all three in one dependency.                                                                                                                                                                                                                                                                                                                       |
| Run browser E2E on Windows CI                                                                                                     | Windows runners cannot run Linux containers (V13), so the stack cannot exist there.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The last-used organization preference as the active organization                                                                  | A refresh, a shared link or a second tab would show another organization than the address says; the preference could outlive the membership. It would also repeat the stale-context risk the URL removes.                                                                                                                                                                                                                                                                                                              |
| `organizationId` as a query parameter (`/projects?organizationId=...`)                                                            | Works, but makes the organization optional and easy to drop in a link; a path segment is mandatory and the shell can match it.                                                                                                                                                                                                                                                                                                                                                                                         |
| Put the helper in `packages/contracts` (a `permissionsFor` shared with the API)                                                   | Not approved: it changes accepted code for a convenience, and contracts already export the two primitives the helper needs.                                                                                                                                                                                                                                                                                                                                                                                            |
| A new shared package for permissions                                                                                              | An abstraction for one consumer (CLAUDE.md rule 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A server endpoint returning effective permissions                                                                                 | An API change outside this step; it would also make the UI wait for a round trip per page. Revisit only if the client rules prove error-prone.                                                                                                                                                                                                                                                                                                                                                                         |
| Handle `401` only in `QueryCache`                                                                                                 | A mutation that returns `401` would leave the UI signed in locally while the server forgot the session.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Navigate to sign-in from inside the cache callback                                                                                | A callback outside React cannot know the current location, races the router, and is the usual source of redirect loops. State-driven `RequireAuth` has none of these.                                                                                                                                                                                                                                                                                                                                                  |
| `queryClient.clear()` or `invalidateQueries()` on sign-out                                                                        | `clear()` drops the session query under mounted observers; an unfiltered invalidation refetches everything, including the session, and re-enters the handler.                                                                                                                                                                                                                                                                                                                                                          |
| Treat an uncertain sign-out as signed out locally, keep the user signed in with private data, or settle it with a `GET /me` probe | The server may or may not have ended the `HttpOnly` session. Anonymous locally while the cookie is valid sends the user back in on the next load; staying authenticated while the server session is gone keeps showing private data the server would refuse; and a probe can answer `200` while the earlier logout is still running, because the revocation is invisible until its transaction commits and nothing cancels it when the client gives up (B1 to B3). Repeating the idempotent logout is conclusive (B5). |
| Optimistic updates for role changes and removals                                                                                  | A refused write would flash a state the server never had; the lists are short and a refetch is cheap. Revisit with evidence.                                                                                                                                                                                                                                                                                                                                                                                           |
| Fake sorting or client-side pagination over a full download                                                                       | The API does not sort or search (V5). Pretending would hide a limitation and break at the first organization with more than 100 members.                                                                                                                                                                                                                                                                                                                                                                               |

## Conflicts with the existing architecture and documents

| Item                                                                                     | Status                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ADR-0005 decision 8: "No browser end-to-end framework"                                   | **Narrowed by D1** (scoped supersession; ADR-0005 text unchanged). `apps/web` still has no browser framework.      |
| `ci.md` "Not included (by decision): browser/E2E tests"; `frontend.md` sections 9 and 12 | Out of date once this ADR is accepted; updated then (not now, so the documents describe what exists).              |
| ADR-0010 decision 9: "the active organization is a browser preference"                   | **Refined by D2** for the client only; the server-side meaning is untouched.                                       |
| ADR-0010 and ADR-0011: "system scenario / browser-level scenario in step 2.4"            | **Fulfilled by D1**, with the extra tool, runner and job recorded here.                                            |
| `routes.spec.ts` pins the navigation order and has no Projects entry                     | The implementation adds the entry and updates the test deliberately.                                               |
| `frontend.md` "conventions only" for auth, guards, forms and tables                      | The implementation is their first real use; the guide is updated with what was learned (as the earlier steps did). |

No conflict with the layer rules, the tenancy rules (CLAUDE.md "Tenancy and authorization", "Projects"), or the API contracts. No Phase 2.3
backend contract needs to change.

## Proposed implementation sequence (indicative; each step is reviewed before the next, none is approved yet)

| Step | Scope                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | This ADR reviewed and accepted; documentation updates listed below.                                                                            |
| 1    | Foundations: the two cache handlers and their tests, the Projects navigation entry and its test, a larger async default in the web test setup. |
| 2    | `features/auth`: session query, `RequireAuth`, sign-in/sign-up, user menu, sign-out.                                                           |
| 3    | `features/organizations`: list, create the first organization, switcher, the `/projects` redirect and the preference.                          |
| 4    | `features/projects`, read side: permission helper and its matrix test, list, details, members tab (paginated), states in both languages.       |
| 5    | Project create, edit, archive, restore.                                                                                                        |
| 6    | Members: add (picker), change role, remove, self-removal warning.                                                                              |
| 7    | The Playwright dependency, `browser` runner and CI job, the scenario above, and the documentation updates.                                     |

Each step ends with `pnpm verify`; the browser step also runs `pnpm test:browser` on Linux and `pnpm test:integration` is unaffected.

## Open implementation questions

These are **not architectural decisions** and nothing above assumes their answer. None blocks acceptance of the ADR. Each is settled
during the implementation step named, reported with its evidence, and, if the answer changes a decision, brought back as an ADR change.

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Settled in |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Q1  | **Exact `@playwright/test` version and compatibility**: which established release, whether it supports the pinned Node and TypeScript versions and Chromium on `ubuntu-latest`, whether installing the package downloads anything or needs an `allowBuilds` entry, and whether the pnpm 11 install policy accepts it.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Step 7     |
| Q2  | **Content-Security-Policy**: none is set today (`nginx.conf` adds only cache headers). The implementation inspects what the built app, Ant Design and the browser suite actually load and then decides whether to introduce a policy now or leave it to a later phase; if a policy is introduced it is its own reviewed change.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Step 7     |
| Q3  | **Image-build reuse versus a separate browser-test image or job**: whether the `browser` job builds the images itself through the shared global setup (isolation, duplicated build time) or reuses an artifact of the `system` job (faster, couples the two jobs), with the measured cost of each. D1 requires only a separate job.                                                                                                                                                                                                                                                                                                                                                                                                                             | Step 7     |
| Q4  | **Exact stamping and gating points.** D4 fixes the contract (record the generation when a private query or mutation starts, compare at `401`, do not run private requests unless authenticated). The installed `@tanstack/query-core` is 5.107.1; its sources show that `MutationCache` `onMutate` is awaited before the request starts (a rejection there skips the request), that a `QueryCache` subscriber receives `updated` events with a `fetch` action (listeners are called synchronously inside the dispatch, so the stamp is taken at the start of the fetch), that `enabled` accepts a function and that `refetch` takes `cancelRefetch`. The implementation confirms each by a test and uses an equivalent single point if one behaves differently. | Step 1/2   |
| Q5  | **Concurrent and repeated logout against real PostgreSQL** (B5): two logouts of one session at the same time both answer `204` and write one audit event; a logout after a completed logout answers `401 unauthenticated`; a logout whose first transaction rolls back is completed by the second. An integration test in the API suite (no API change) confirms it before step 2 relies on it.                                                                                                                                                                                                                                                                                                                                                                 | Step 2     |

## Release and acceptance criteria

Conditions that must hold before the Phase 2.4 UI is released or step 7 is accepted. They are not architecture and not open questions.

- **Persian (fa) text and RTL layout have had a native-speaker review**, covering every string the step adds, plural and number forms, and
  the mirrored layout. The implementation provides complete English and Persian dictionaries (a missing key does not compile); the review
  is a human acceptance task and its result is recorded in the step's report.
- The Playwright scenario of the testing strategy passes in the `browser` job on Linux, and `pnpm verify` passes, on the commit that is
  proposed for merging.

## Documentation that follows (not done in this step)

- On acceptance: `ci.md` (new job, browser tests no longer "not included"), `frontend.md` (E2E, routes, session handling, permission helper),
  `development.md` (running `pnpm test:browser` locally), the README phase line.
- **ADR-0010 implementation note (proposed text, to be added when this ADR is accepted):** "Note 40. Decision 9, _the active
  organization is a browser preference_: refined for the client by [ADR-0012](0012-phase-2-4-web-ui-foundations.md) D2. The web app
  addresses organization-scoped pages by `/organizations/:organizationId/...`; the last-used organization is kept only to choose the
  first redirect and is validated before use. The server is unchanged: the organization id remains a selector validated on every request."
- ADR-0005 is not edited; ADR-0012 D1 is the record of the scoped supersession.
