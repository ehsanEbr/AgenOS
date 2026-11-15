import { IDENTITY_ERROR_CODES } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';

/** Unknown email, wrong password, disabled account and unusable stored hash all produce exactly this: the same status, code and text. */
export const invalidCredentials = () =>
  new AppError('unauthenticated', IDENTITY_ERROR_CODES.invalidCredentials, 'Invalid email or password');

/** The caller has no valid session. Missing, malformed, unknown, revoked and expired credentials are indistinguishable. */
export const notAuthenticated = () =>
  new AppError('unauthenticated', IDENTITY_ERROR_CODES.unauthenticated, 'Authentication is required');

export const registrationClosed = () =>
  new AppError('forbidden', IDENTITY_ERROR_CODES.registrationClosed, 'Registration is closed');

export const emailTaken = () =>
  new AppError('conflict', IDENTITY_ERROR_CODES.emailTaken, 'An account with this email already exists');

export const tooManyAttempts = (retryAfterSeconds: number) =>
  new AppError('rate_limited', IDENTITY_ERROR_CODES.tooManyAttempts, 'Too many attempts. Try again later.', {
    retryAfterSeconds,
  });

/** A required dependency of authentication (the rate limiter, or the hashing capacity) is not available. Safe to retry. */
export const authenticationUnavailable = (retryAfterSeconds = 30) =>
  new AppError(
    'unavailable',
    IDENTITY_ERROR_CODES.serviceUnavailable,
    'Authentication is temporarily unavailable',
    { retryAfterSeconds },
  );

export const invalidCurrentPassword = () =>
  new AppError(
    'unprocessable',
    IDENTITY_ERROR_CODES.invalidCurrentPassword,
    'The current password is incorrect',
  );
