import { idSchema, type ProjectStatus } from '@agentos/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  PICKER_PAGE_SIZE,
  PROJECT_PAGE_SIZE,
  getOrganizationRole,
  getProject,
  listOrganizationMembers,
  listProjectMembers,
  listProjects,
} from './api';

/** The `status` filter values of `GET /projects`, as the real parameter. */
export type ProjectListStatus = ProjectStatus | 'all';

/**
 * Query keys of this feature, in one place. The root `projects` is a PRIVATE root (ADR-0012 D4 rule 1): the session lifecycle removes
 * every entry under it when the session ends or the user changes. A key that depends on an organization contains its id, so switching
 * organization can never show another organization's cached rows. Paging and filters are part of the key, so a page is never shown
 * for another page's request.
 */
export const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  /** Every list (any filter, any page) of one organization: what a change to one of its projects must refetch. */
  listsOf: (organizationId: string) => [...projectKeys.lists(), organizationId] as const,
  list: (organizationId: string, status: ProjectListStatus, offset: number) =>
    [...projectKeys.lists(), organizationId, status, offset] as const,
  /** The caller's role in an organization, as this feature reads it to choose the controls it shows. */
  organization: (organizationId: string) => [...projectKeys.all, 'organization', organizationId] as const,
  details: () => [...projectKeys.all, 'detail'] as const,
  detail: (projectId: string) => [...projectKeys.details(), projectId] as const,
  /** Every page of one project's members (the member list shown on screen). */
  membersOf: (projectId: string) => [...projectKeys.all, 'members', projectId] as const,
  members: (projectId: string, offset: number) => [...projectKeys.membersOf(projectId), offset] as const,
  /** All the user ids of one project's members, loaded for the picker so it can disable the people who are already members. */
  memberIds: (projectId: string) => [...projectKeys.all, 'member-ids', projectId] as const,
  /** The organization's members, as the picker lists them. */
  organizationMembers: (organizationId: string) =>
    [...projectKeys.all, 'organization-members', organizationId] as const,
};

/** Whether a value taken from the URL can be an id at all. Anything else is the same not-found a foreign id would be, with no request. */
const isId = (value: string | undefined): value is string => idSchema.safeParse(value).success;

/** One page of the projects of an organization that the caller can access (the real `status`, `limit` and `offset`). */
export function useProjectList(organizationId: string, status: ProjectListStatus, offset: number) {
  return useQuery({
    queryKey: projectKeys.list(organizationId, status, offset),
    queryFn: ({ signal }) =>
      listProjects({ organizationId, status, limit: PROJECT_PAGE_SIZE, offset }, signal),
  });
}

/** One project. A value that is not an id is not requested (`valid` is false): it is the same not-found as a foreign id. */
export function useProject(projectId: string | undefined) {
  const valid = isId(projectId);
  const query = useQuery({
    queryKey: projectKeys.detail(projectId ?? ''),
    queryFn: ({ signal }) => getProject(projectId!, signal),
    enabled: valid,
  });
  return { ...query, valid };
}

/** One page of the explicit members of a project. */
export function useProjectMembers(projectId: string, offset: number) {
  return useQuery({
    queryKey: projectKeys.members(projectId, offset),
    queryFn: ({ signal }) => listProjectMembers(projectId, { limit: PROJECT_PAGE_SIZE, offset }, signal),
  });
}

/**
 * The caller's role in the organization of the page (`GET /organizations/:id`, ADR-0012 D3, D5), through this feature's own query so
 * `projects` does not import `organizations`. Controls are chosen from it; until it is known, none is offered.
 */
export function useOrganizationRole(organizationId: string | undefined) {
  const valid = isId(organizationId);
  return useQuery({
    queryKey: projectKeys.organization(organizationId ?? ''),
    queryFn: ({ signal }) => getOrganizationRole(organizationId!, signal),
    enabled: valid,
  });
}

const nextOffset = (last: { items: unknown[]; page: { offset: number; total: number } }) => {
  const next = last.page.offset + last.items.length;
  return last.items.length > 0 && next < last.page.total ? next : undefined;
};

/**
 * The organization's members for the picker, 100 per request, with "load more" (ADR-0012 D5). The endpoint has no search: the picker
 * filters only the rows loaded so far and says so. Read through this feature's own query, so `projects` does not import `organizations`.
 */
export function useOrganizationMembers(organizationId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: projectKeys.organizationMembers(organizationId),
    queryFn: ({ pageParam, signal }) =>
      listOrganizationMembers(organizationId, { limit: PICKER_PAGE_SIZE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    enabled,
  });
}

/**
 * The user ids of ALL the members of a project, loaded page after page (100 per request) while the picker is open. `ids` is `null` until
 * every page has arrived: a person is shown as "already a member" only when this is known (ADR-0012 D5), and the server stays the
 * authority (`409 already_project_member`).
 */
export function useProjectMemberIds(projectId: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: projectKeys.memberIds(projectId),
    queryFn: ({ pageParam, signal }) =>
      listProjectMembers(projectId, { limit: PICKER_PAGE_SIZE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    enabled,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [enabled, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const complete = query.isSuccess && !hasNextPage;
  return {
    ids: complete
      ? new Set(query.data.pages.flatMap((page) => page.items.map((member) => member.userId)))
      : null,
  };
}
