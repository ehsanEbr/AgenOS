import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  displayNameSchema,
  emailSchema,
  utf8ByteLength,
} from '@agentos/contracts';
import { isApiClientError } from '../../shared/api/errors';
import { CredentialOperationInProgressError } from './credential-mutation';

/*
 * Client-side checks for the sign-in and sign-up forms. They reuse the contract's own rules (the same email canonicalization, the
 * same password bounds, the same name limit) so client and server cannot diverge, but they return a KEY into the `auth:fields`
 * messages instead of the schema's English text: every string the user sees is translated.
 */

export const NAME_MAX_LENGTH = 100;
export { PASSWORD_MIN_LENGTH };

export type FieldProblem =
  | 'emailRequired'
  | 'emailInvalid'
  | 'passwordRequired'
  | 'passwordTooShort'
  | 'passwordTooLong'
  | 'nameRequired'
  | 'nameTooLong';

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function emailProblem(value: unknown): FieldProblem | null {
  if (text(value).trim() === '') return 'emailRequired';
  return emailSchema.safeParse(text(value)).success ? null : 'emailInvalid';
}

/** A password being CHECKED (sign-in): only presence and the size bound; the sign-in form never reveals the password policy. */
export function presentedPasswordProblem(value: unknown): FieldProblem | null {
  if (text(value) === '') return 'passwordRequired';
  return utf8ByteLength(text(value)) > PASSWORD_MAX_BYTES ? 'passwordTooLong' : null;
}

/** A NEW password (sign-up): the strength rule applies. */
export function newPasswordProblem(value: unknown): FieldProblem | null {
  if (text(value) === '') return 'passwordRequired';
  if (text(value).length < PASSWORD_MIN_LENGTH) return 'passwordTooShort';
  return utf8ByteLength(text(value)) > PASSWORD_MAX_BYTES ? 'passwordTooLong' : null;
}

export function displayNameProblem(value: unknown): FieldProblem | null {
  if (text(value).trim() === '') return 'nameRequired';
  return displayNameSchema.safeParse(text(value)).success ? null : 'nameTooLong';
}

/** What went wrong with an authentication request, in the terms the forms react to. */
export type AuthFailure =
  | { kind: 'invalid_credentials' }
  | { kind: 'too_many_attempts' }
  | { kind: 'unavailable' }
  | { kind: 'origin_not_allowed' }
  | { kind: 'registration_closed' }
  | { kind: 'email_taken' }
  | { kind: 'in_progress' }
  | { kind: 'validation'; fields: readonly ('email' | 'password' | 'displayName')[] }
  | { kind: 'other'; error: unknown };

const FIELD_NAMES = ['email', 'password', 'displayName'] as const;

/** Maps an API failure to a form reaction using the documented error codes only (identity contracts). */
export function classifyAuthFailure(error: unknown): AuthFailure {
  if (error instanceof CredentialOperationInProgressError) return { kind: 'in_progress' };
  if (!isApiClientError(error) || error.kind !== 'http') return { kind: 'other', error };
  switch (error.code) {
    case 'invalid_credentials':
      return { kind: 'invalid_credentials' };
    case 'too_many_attempts':
      return { kind: 'too_many_attempts' };
    case 'authentication_unavailable':
      return { kind: 'unavailable' };
    case 'origin_not_allowed':
      return { kind: 'origin_not_allowed' };
    case 'registration_closed':
      return { kind: 'registration_closed' };
    case 'email_taken':
      return { kind: 'email_taken' };
    case 'validation_error': {
      // The API reports `details: [{ path, message }]`. Only the path is used: the server's English text is never shown.
      const paths = Array.isArray(error.details)
        ? error.details.map((issue: unknown) =>
            typeof issue === 'object' && issue !== null ? (issue as { path?: unknown }).path : undefined,
          )
        : [];
      const fields = FIELD_NAMES.filter((name) => paths.includes(name));
      return { kind: 'validation', fields };
    }
    default:
      return { kind: 'other', error };
  }
}
