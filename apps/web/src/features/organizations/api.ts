import {
  organizationWithRoleSchema,
  paginatedSchema,
  type CreateOrganizationRequest,
  type PaginationQuery,
} from '@agentos/contracts';
import { apiRequest } from '../../shared/api/client';

/*
 * The endpoints of the organizations API (backend: apps/api organizations module). Responses are validated by the shared contracts.
 * Both list and detail are the caller's own view: an organization the caller does not belong to is `404 organization_not_found`,
 * indistinguishable from one that does not exist.
 */

/** The page size of the lists: the API's maximum, so a normal account needs one request (ADR-0012 D5, "load more"). */
export const ORGANIZATION_PAGE_SIZE = 100;

const organizationPageSchema = paginatedSchema(organizationWithRoleSchema);

/** `GET /organizations`: the caller's organizations, each with their role, paginated with the real `limit` and `offset`. */
export const listOrganizations = (page: PaginationQuery, signal?: AbortSignal) =>
  apiRequest('/organizations', organizationPageSchema, { query: page, signal });

/** `GET /organizations/:organizationId`: one organization with the caller's role. */
export const getOrganization = (organizationId: string, signal?: AbortSignal) =>
  apiRequest(`/organizations/${encodeURIComponent(organizationId)}`, organizationWithRoleSchema, { signal });

/** `POST /organizations`: creates an organization; the caller becomes its owner. */
export const createOrganization = (request: CreateOrganizationRequest) =>
  apiRequest('/organizations', organizationWithRoleSchema, { method: 'POST', body: request });
