import { idSchema, type OrganizationWithRole } from '@agentos/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORGANIZATION_PAGE_SIZE, createOrganization, getOrganization, listOrganizations } from './api';

/**
 * Query keys of this feature, in one place. The root `organizations` is a PRIVATE root (ADR-0012 D4 rule 1): the session lifecycle
 * removes every entry under it when the session ends or the user changes. Every key that depends on an organization contains its id,
 * so switching organization can never show another organization's cached rows.
 */
export const organizationKeys = {
  all: ['organizations'] as const,
  lists: () => [...organizationKeys.all, 'list'] as const,
  detail: (organizationId: string) => [...organizationKeys.all, 'detail', organizationId] as const,
};

/**
 * The caller's organizations, 100 per request, with "load more" (`fetchNextPage`). The list is paged by the real `offset`, and
 * `hasNextPage` is true only while the loaded rows are fewer than the server's `total`.
 */
export function useOrganizationList(options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: organizationKeys.lists(),
    queryFn: ({ pageParam, signal }) =>
      listOrganizations({ limit: ORGANIZATION_PAGE_SIZE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.page.offset + last.items.length;
      return last.items.length > 0 && next < last.page.total ? next : undefined;
    },
    // An explicit `enabled: undefined` would replace the client's default (the quiet session layer): only pass it when given.
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

/** Every organization loaded so far, in the API's order (oldest first), and the server's total. */
export function loadedOrganizations(
  data: { pages: { items: OrganizationWithRole[]; page: { total: number } }[] } | undefined,
): {
  organizations: OrganizationWithRole[];
  total: number;
} {
  return {
    organizations: data?.pages.flatMap((page) => page.items) ?? [],
    total: data?.pages.at(-1)?.page.total ?? 0,
  };
}

/**
 * One organization the caller belongs to (with their role). A value that is not an id never reaches the network: it is the same
 * not-found as a foreign id would be, which the API answers with `404 organization_not_found` (malformed, foreign and non-member
 * are indistinguishable by design).
 */
export function useOrganization(organizationId: string | undefined) {
  const valid = organizationId !== undefined && idSchema.safeParse(organizationId).success;
  const query = useQuery({
    queryKey: organizationKeys.detail(organizationId ?? ''),
    queryFn: ({ signal }) => getOrganization(organizationId!, signal),
    enabled: valid,
  });
  return { ...query, valid };
}

/** Creates an organization. On success the organization queries are invalidated (never written to), so lists refetch. */
export function useCreateOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createOrganization,
    onSuccess: () => client.invalidateQueries({ queryKey: organizationKeys.all }),
  });
}
