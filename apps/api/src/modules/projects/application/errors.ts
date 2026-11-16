import { ORGANIZATION_ERROR_CODES, PROJECT_ERROR_CODES } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';

/** Nonexistent, belonging to another organization, and "you have no access" are one answer: the caller learns nothing. */
export const projectNotFound = () =>
  new AppError('not_found', PROJECT_ERROR_CODES.projectNotFound, 'Project not found');

export const projectSlugTaken = () =>
  new AppError(
    'conflict',
    PROJECT_ERROR_CODES.projectSlugTaken,
    'A project with this slug already exists in the organization',
  );

/** A change on an archived project. Archive and restore themselves are idempotent and never raise this. */
export const projectArchived = () =>
  new AppError(
    'conflict',
    PROJECT_ERROR_CODES.projectArchived,
    'The project is archived. Restore it to change it.',
  );

/** The user does not exist or is not a member of the project's organization: the same answer for both. */
export const organizationMemberNotFound = () =>
  new AppError(
    'not_found',
    PROJECT_ERROR_CODES.organizationMemberNotFound,
    'No member of the organization with this id exists',
  );

export const alreadyProjectMember = () =>
  new AppError(
    'conflict',
    PROJECT_ERROR_CODES.alreadyProjectMember,
    'This user is already a member of the project',
  );

export const projectMemberNotFound = () =>
  new AppError('not_found', PROJECT_ERROR_CODES.projectMemberNotFound, 'Project member not found');

/** The caller's organization membership ended while their request was running (or was never there): same answer as for a stranger. */
export const organizationNotFound = () =>
  new AppError('not_found', ORGANIZATION_ERROR_CODES.organizationNotFound, 'Organization not found');
