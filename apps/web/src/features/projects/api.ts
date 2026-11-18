import {
  memberSchema,
  organizationWithRoleSchema,
  paginatedSchema,
  projectMemberSchema,
  projectSchema,
  type AddProjectMemberRequest,
  type CreateProjectRequest,
  type ListProjectsQuery,
  type PaginationQuery,
  type UpdateProjectMemberRequest,
  type UpdateProjectRequest,
} from '@agentos/contracts';
import { z } from 'zod';
import { apiRequest } from '../../shared/api/client';

/*
 * The endpoints of the projects API (backend: apps/api projects module). Responses are validated by the shared contracts.
 * A project the caller cannot see is `404 project_not_found` (never 403): nonexistent, foreign and "no access" are indistinguishable.
 * The list and the members accept `limit` and `offset` only: the API cannot sort or search, so neither is offered here.
 */

/** The page size of the lists: the API's default, so the paging controls match what the server pages by. */
export const PROJECT_PAGE_SIZE = 20;

const projectPageSchema = paginatedSchema(projectSchema);
const memberPageSchema = paginatedSchema(projectMemberSchema);
const organizationMemberPageSchema = paginatedSchema(memberSchema);

/** The page size of the member picker and of the project's member list it checks against: the API's maximum, so a normal organization needs one request. */
export const PICKER_PAGE_SIZE = 100;

/**
 * `GET /projects`: the projects of one organization that the caller can access, with the real `status` filter and paging.
 * `organizationId` is a selector the server validates against the caller's memberships.
 */
export const listProjects = (
  query: Pick<ListProjectsQuery, 'organizationId' | 'status' | 'limit' | 'offset'>,
  signal?: AbortSignal,
) => apiRequest('/projects', projectPageSchema, { query, signal });

/** `GET /projects/:projectId`: one project, with the caller's explicit role on it (`null` when access comes from the organization role). */
export const getProject = (projectId: string, signal?: AbortSignal) =>
  apiRequest(`/projects/${encodeURIComponent(projectId)}`, projectSchema, { signal });

/**
 * `GET /projects/:projectId/members`: the EXPLICIT project members only (an organization owner or admin appears only if they also hold
 * a project role). It works on an archived project.
 */
export const listProjectMembers = (projectId: string, page: PaginationQuery, signal?: AbortSignal) =>
  apiRequest(`/projects/${encodeURIComponent(projectId)}/members`, memberPageSchema, { query: page, signal });

/**
 * `GET /organizations/:organizationId`: the caller's role in the organization. The projects feature reads it through its own query
 * (ADR-0012 D5) to decide which controls to show; the server re-evaluates every request regardless.
 */
export const getOrganizationRole = (organizationId: string, signal?: AbortSignal) =>
  apiRequest(`/organizations/${encodeURIComponent(organizationId)}`, organizationWithRoleSchema, { signal });

/**
 * `POST /projects`: creates a project; the caller becomes its `project_admin`. `organizationId` is a selector the server validates
 * (`404` for a malformed or foreign id, `403` without `project.create`); the slug is unique per organization (`409 project_slug_taken`).
 */
export const createProject = (request: CreateProjectRequest) =>
  apiRequest('/projects', projectSchema, { method: 'POST', body: request });

/**
 * `PATCH /projects/:projectId`: the name and the description only (the slug and the organization are immutable and are not sendable).
 * `description: null` removes it. An archived project answers `409 project_archived`.
 */
export const updateProject = (projectId: string, request: UpdateProjectRequest) =>
  apiRequest(`/projects/${encodeURIComponent(projectId)}`, projectSchema, { method: 'PATCH', body: request });

/** `POST /projects/:projectId/archive`: idempotent (`200` with the same project when it is already archived). */
export const archiveProject = (projectId: string) =>
  apiRequest(`/projects/${encodeURIComponent(projectId)}/archive`, projectSchema, { method: 'POST' });

/** `POST /projects/:projectId/restore`: idempotent (`200` with the same project when it is already active). */
export const restoreProject = (projectId: string) =>
  apiRequest(`/projects/${encodeURIComponent(projectId)}/restore`, projectSchema, { method: 'POST' });

/**
 * `GET /organizations/:organizationId/members`: the members of the organization (the picker's source). Needs `member.read`, which every
 * organization role holds. `limit` and `offset` only: the API has no search, no filter and no sorting.
 */
export const listOrganizationMembers = (
  organizationId: string,
  page: PaginationQuery,
  signal?: AbortSignal,
) =>
  apiRequest(`/organizations/${encodeURIComponent(organizationId)}/members`, organizationMemberPageSchema, {
    query: page,
    signal,
  });

/**
 * `POST /projects/:projectId/members`: adds an EXISTING member of the project's organization, by user id. `404 organization_member_not_found`
 * for an unknown user and for one outside the organization alike; `409 already_project_member`; `409 project_archived`.
 */
export const addProjectMember = (projectId: string, request: AddProjectMemberRequest) =>
  apiRequest(`/projects/${encodeURIComponent(projectId)}/members`, projectMemberSchema, {
    method: 'POST',
    body: request,
  });

/** `PATCH /projects/:projectId/members/:userId`: changes a member's project role. `404 project_member_not_found`; `409 project_archived`. */
export const changeProjectMemberRole = (
  projectId: string,
  userId: string,
  request: UpdateProjectMemberRequest,
) =>
  apiRequest(
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    projectMemberSchema,
    {
      method: 'PATCH',
      body: request,
    },
  );

/** `DELETE /projects/:projectId/members/:userId`: `204`. The organization membership is unaffected. `404 project_member_not_found`; `409 project_archived`. */
export const removeProjectMember = (projectId: string, userId: string) =>
  apiRequest(
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    z.undefined(),
    {
      method: 'DELETE',
    },
  );
