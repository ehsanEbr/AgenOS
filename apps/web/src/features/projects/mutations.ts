import type { CreateProjectRequest, Project, ProjectRole, UpdateProjectRequest } from '@agentos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/ui/useNotify';
import {
  addProjectMember,
  archiveProject,
  changeProjectMemberRole,
  createProject,
  removeProjectMember,
  restoreProject,
  updateProject,
} from './api';
import { classifyWriteFailure, type WriteFailure } from './form-rules';
import { projectKeys } from './queries';

/*
 * The write side of the projects UI (ADR-0012 D4: "feature mutations update caches by invalidating their own keys, never by writing with
 * setQueryData into private entries"). These are ordinary private mutations: they do not run unless the session is authenticated, and a
 * genuine `401` ends the session for them like for any query.
 *
 * What a success refetches, and nothing more:
 *   - create:                         the project lists of THAT organization (any filter, any page);
 *   - edit, archive, restore:         the project itself (awaited, so the page is never drawn from the old value after the success is
 *                                     announced) and the lists of its organization (a status change moves a row between filters);
 *   - add, change role, remove member: the member lists of THAT project (awaited), and, when the person changed is the caller, also the
 *                                     project and the lists of its organization, because `projectRole` (the caller's own explicit role)
 *                                     is part of both.
 */

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateProjectRequest) => createProject(request),
    onSuccess: (project) => {
      void client.invalidateQueries({ queryKey: projectKeys.listsOf(project.organizationId) });
    },
  });
}

function useChange<TVariables>(call: (projectId: string, variables: TVariables) => Promise<Project>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, variables }: { projectId: string; variables: TVariables }) =>
      call(projectId, variables),
    onSuccess: (project) => {
      void client.invalidateQueries({ queryKey: projectKeys.listsOf(project.organizationId) });
      return client.invalidateQueries({ queryKey: projectKeys.detail(project.id) });
    },
  });
}

export const useUpdateProject = () => useChange<UpdateProjectRequest>(updateProject);
export const useArchiveProject = () => useChange<void>((projectId) => archiveProject(projectId));
export const useRestoreProject = () => useChange<void>((projectId) => restoreProject(projectId));

/** Which project a member change is on, and whether it concerns the caller's OWN membership. */
export interface MemberChangeScope {
  organizationId: string;
  projectId: string;
  affectsCaller: boolean;
}

function useMemberChange<TVariables extends MemberChangeScope, TResult>(
  call: (variables: TVariables) => Promise<TResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (_, variables) => {
      void client.invalidateQueries({ queryKey: projectKeys.memberIds(variables.projectId) });
      if (variables.affectsCaller) {
        void client.invalidateQueries({ queryKey: projectKeys.listsOf(variables.organizationId) });
        void client.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
      }
      return client.invalidateQueries({ queryKey: projectKeys.membersOf(variables.projectId) });
    },
  });
}

export const useAddProjectMember = () =>
  useMemberChange((variables: MemberChangeScope & { userId: string; projectRole: ProjectRole }) =>
    addProjectMember(variables.projectId, { userId: variables.userId, projectRole: variables.projectRole }),
  );

export const useChangeProjectMemberRole = () =>
  useMemberChange((variables: MemberChangeScope & { userId: string; projectRole: ProjectRole }) =>
    changeProjectMemberRole(variables.projectId, variables.userId, { projectRole: variables.projectRole }),
  );

export const useRemoveProjectMember = () =>
  useMemberChange((variables: MemberChangeScope & { userId: string }) =>
    removeProjectMember(variables.projectId, variables.userId),
  );

/** Where a failed write happened, so the right queries are refetched. */
export interface WriteScope {
  organizationId: string;
  /** Absent when creating. */
  projectId?: string;
}

/**
 * Handles the part of a failed write that does not depend on the form, and tells the caller what happened (`WriteFailure`) so a form
 * can show a field error or an inline notice. The server's own text is never shown: messages are translated, with the support reference.
 *   - `403` / `404`  "your access changed" (D3): the organization role, the project and the lists are refetched, so the page redraws with
 *                    the controls the person now has;
 *   - `409 archived` the project was archived meanwhile: it is refetched, so the page shows it read-only;
 *   - uncertain      (network, timeout, `5xx`) the write may or may not have happened: the project and the lists are refetched, so the page
 *                    shows the truth;
 *   - the member outcomes: a member who was already removed (`404 project_member_not_found`) is announced and the members are refetched;
 *                    a person who is a member already (`409`) or no longer in the organization (`404 organization_member_not_found`) is
 *                    left to the picker, after the lists it was built from are refetched;
 *   - validation and a taken slug are left to the form; `401` is the session's business (the guard returns the user to sign-in).
 */
export function useWriteFailureHandler(scope: WriteScope) {
  const client = useQueryClient();
  const notify = useNotify();
  const { t } = useTranslation('projects');
  const { organizationId, projectId } = scope;

  return useCallback(
    (error: unknown): WriteFailure => {
      const failure = classifyWriteFailure(error);
      const refetch = () => {
        void client.invalidateQueries({ queryKey: projectKeys.listsOf(organizationId) });
        if (projectId) {
          void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
          void client.invalidateQueries({ queryKey: projectKeys.membersOf(projectId) });
          void client.invalidateQueries({ queryKey: projectKeys.memberIds(projectId) });
        }
      };
      const refetchMembers = () => {
        if (!projectId) return;
        void client.invalidateQueries({ queryKey: projectKeys.membersOf(projectId) });
        void client.invalidateQueries({ queryKey: projectKeys.memberIds(projectId) });
      };
      switch (failure.kind) {
        case 'access_changed':
          void client.invalidateQueries({ queryKey: projectKeys.organization(organizationId) });
          refetch();
          notify.error(error, t('write.accessChanged'));
          break;
        case 'archived':
          refetch();
          notify.error(error, t('write.archivedNow'));
          break;
        case 'uncertain':
          refetch();
          notify.error(error, t('write.uncertain'));
          break;
        case 'member_gone':
          refetchMembers();
          notify.error(error, t('write.memberGone'));
          break;
        case 'member_unavailable':
          void client.invalidateQueries({ queryKey: projectKeys.organizationMembers(organizationId) });
          refetchMembers();
          break;
        case 'already_member':
          refetchMembers();
          break;
        case 'other':
          notify.error(error);
          break;
        case 'validation':
        case 'slug_taken':
        case 'unauthenticated':
          break;
      }
      return failure;
    },
    [client, notify, t, organizationId, projectId],
  );
}
