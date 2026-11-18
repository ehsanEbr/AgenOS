import { useEffect } from 'react';
import { Flex } from 'antd';
import { Navigate, useNavigate } from 'react-router';
import {
  CreateFirstOrganization,
  OrganizationChooser,
  loadedOrganizations,
  useOrganizationList,
} from '../../features/organizations';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { useUiPreferences } from '../state/ui-preferences.store';
import { organizationProjectsPath } from './paths';

/**
 * `/projects`: only a redirect (ADR-0012 D2). Where it leads depends on the caller's real organization list:
 *   - the last-used organization is in the list      -> its project page (replacing this entry in the history);
 *   - it is not (absent, stale, no longer a member)  -> the stored id is discarded, then the cases below;
 *   - the caller has no organization                 -> "create your first organization";
 *   - otherwise                                      -> the chooser.
 * The stored id is never trusted on its own. If it is not among the rows loaded so far and the list has more pages, the next page is
 * fetched until the id is found or the list is exhausted, so a long list cannot make a valid id look stale.
 */
export function ProjectsEntryPage() {
  const navigate = useNavigate();
  const lastOrganizationId = useUiPreferences((s) => s.lastOrganizationId);
  const clearLastOrganization = useUiPreferences((s) => s.clearLastOrganization);
  const list = useOrganizationList();
  const { organizations, total } = loadedOrganizations(list.data);

  const remembered = lastOrganizationId !== null && organizations.some((o) => o.id === lastOrganizationId);
  const searching = lastOrganizationId !== null && !remembered && list.hasNextPage;
  const { isFetchingNextPage, fetchNextPage } = list;
  const stale = lastOrganizationId !== null && list.isSuccess && !remembered && !list.hasNextPage;

  useEffect(() => {
    if (searching && !isFetchingNextPage) void fetchNextPage();
  }, [searching, isFetchingNextPage, fetchNextPage]);

  useEffect(() => {
    if (stale) clearLastOrganization();
  }, [stale, clearLastOrganization]);

  if (list.isPending) return <LoadingState />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (remembered) return <Navigate to={organizationProjectsPath(lastOrganizationId)} replace />;
  if (searching) return <LoadingState />;

  return (
    <Flex justify="center">
      {total === 0 && organizations.length === 0 ? (
        <CreateFirstOrganization
          onCreated={(organization) =>
            void navigate(organizationProjectsPath(organization.id), { replace: true })
          }
        />
      ) : (
        <OrganizationChooser
          organizations={organizations}
          total={total}
          hasMore={list.hasNextPage}
          loadingMore={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
          pathFor={organizationProjectsPath}
        />
      )}
    </Flex>
  );
}
