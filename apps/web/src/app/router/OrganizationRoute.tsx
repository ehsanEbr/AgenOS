import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Outlet, useParams } from 'react-router';
import { OrganizationNotFound, organizationKeys, useOrganization } from '../../features/organizations';
import { isApiClientError } from '../../shared/api/errors';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { useUiPreferences } from '../state/ui-preferences.store';
import { PROJECTS_ENTRY_PATH } from './paths';

/**
 * The layout of every organization-scoped page: `/organizations/:organizationId/...` (ADR-0012 D2). The id in the path is URL context,
 * not authorization; this route asks the API whether the caller may open it (`GET /organizations/:id`) before any page below renders.
 *   - the organization opens      -> it becomes the last-used organization (the URL wins; the preference follows it, never the reverse);
 *   - 404 or an id that is no id  -> one not-found state with a link to the chooser; a stored id that is this one is discarded, and
 *                                    the cached lists are refetched so a stale row is not offered again;
 *   - any other failure           -> an error with Retry; nothing is stored.
 */
export function OrganizationRoute() {
  const { organizationId } = useParams();
  const client = useQueryClient();
  const organization = useOrganization(organizationId);
  const lastOrganizationId = useUiPreferences((s) => s.lastOrganizationId);
  const setLastOrganizationId = useUiPreferences((s) => s.setLastOrganizationId);
  const clearLastOrganization = useUiPreferences((s) => s.clearLastOrganization);

  const notFound =
    !organization.valid ||
    (organization.isError && isApiClientError(organization.error) && organization.error.status === 404);
  const opened = organization.data;
  const openedId = opened !== undefined && opened.id === organizationId ? opened.id : undefined;

  useEffect(() => {
    if (openedId !== undefined && lastOrganizationId !== openedId) setLastOrganizationId(openedId);
  }, [openedId, lastOrganizationId, setLastOrganizationId]);

  useEffect(() => {
    if (!notFound) return;
    if (lastOrganizationId !== null && lastOrganizationId === organizationId) clearLastOrganization();
    void client.invalidateQueries({ queryKey: organizationKeys.lists() });
  }, [notFound, organizationId, lastOrganizationId, clearLastOrganization, client]);

  if (notFound) return <OrganizationNotFound chooserPath={PROJECTS_ENTRY_PATH} />;
  if (organization.isPending) return <LoadingState />;
  if (organization.isError)
    return <ErrorState error={organization.error} onRetry={() => void organization.refetch()} />;
  return <Outlet />;
}
