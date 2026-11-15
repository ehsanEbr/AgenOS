import { ORGANIZATION_ERROR_CODES } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';

/** Nonexistent, malformed and "you are not a member" are the same answer: the caller learns nothing about other organizations. */
export const organizationNotFound = () =>
  new AppError('not_found', ORGANIZATION_ERROR_CODES.organizationNotFound, 'Organization not found');

/** A member of the organization lacks the permission the action needs. */
export const forbidden = () =>
  new AppError('forbidden', ORGANIZATION_ERROR_CODES.forbidden, 'You do not have permission to do this');

export const memberNotFound = () =>
  new AppError('not_found', ORGANIZATION_ERROR_CODES.memberNotFound, 'Member not found');

/** No (active) account has this email. Only callers allowed to manage members ever see it. */
export const userNotFound = () =>
  new AppError('not_found', ORGANIZATION_ERROR_CODES.userNotFound, 'No user with this email exists');

export const alreadyMember = () =>
  new AppError('conflict', ORGANIZATION_ERROR_CODES.alreadyMember, 'This user is already a member');

/** Fails closed: dependents of the membership (project memberships) remain and no participant removed them. Nothing was changed. */
export const membershipInUse = () =>
  new AppError(
    'conflict',
    ORGANIZATION_ERROR_CODES.membershipInUse,
    'The membership still has dependent records and cannot be removed',
  );

export const lastOwner = () =>
  new AppError(
    'conflict',
    ORGANIZATION_ERROR_CODES.lastOwner,
    'An organization must keep at least one owner. Make someone else an owner first.',
  );
