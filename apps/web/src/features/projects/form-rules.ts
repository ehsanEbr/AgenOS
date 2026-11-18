import {
  ORGANIZATION_ERROR_CODES,
  PROJECT_ERROR_CODES,
  PROJECT_SLUG_PATTERN,
  projectDescriptionSchema,
  projectNameSchema,
  projectSlugSchema,
} from '@agentos/contracts';
import { isApiClientError } from '../../shared/api/errors';
import { SLUG_MAX_LENGTH } from './slug';

/*
 * Client-side checks for the project forms, and the reading of a failed write. The checks reuse the contract's own schemas (so client and
 * server cannot diverge) but return a KEY into the `projects:fields` messages instead of the schema's English text: every string the
 * user sees is translated.
 */

export const NAME_MAX_LENGTH = 100;
export const SLUG_MIN_LENGTH = 2;
export const DESCRIPTION_MAX_LENGTH = 2000;

export type FieldProblem =
  | 'nameRequired'
  | 'nameTooLong'
  | 'slugRequired'
  | 'slugTooShort'
  | 'slugTooLong'
  | 'slugInvalid'
  | 'descriptionTooLong';

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function nameProblem(value: unknown): FieldProblem | null {
  if (text(value).trim() === '') return 'nameRequired';
  return projectNameSchema.safeParse(text(value)).success ? null : 'nameTooLong';
}

export function slugProblem(value: unknown): FieldProblem | null {
  const slug = text(value);
  if (slug === '') return 'slugRequired';
  if (projectSlugSchema.safeParse(slug).success) return null;
  if (slug.length < SLUG_MIN_LENGTH) return 'slugTooShort';
  if (slug.length > SLUG_MAX_LENGTH) return 'slugTooLong';
  return PROJECT_SLUG_PATTERN.test(slug) ? null : 'slugInvalid';
}

/** The description is optional: an empty (or blank) one means "none". */
export function descriptionProblem(value: unknown): FieldProblem | null {
  if (text(value).trim() === '') return null;
  return projectDescriptionSchema.safeParse(text(value)).success ? null : 'descriptionTooLong';
}

/** What went wrong with a write (create, edit, archive, restore), in the terms the UI reacts to. */
export type WriteFailure =
  | { kind: 'unauthenticated' }
  | { kind: 'validation'; fields: readonly ('name' | 'slug' | 'description')[] }
  | { kind: 'slug_taken' }
  /** `409 already_project_member`: the person is a member already (someone else added them). */
  | { kind: 'already_member' }
  /** `404 organization_member_not_found`: no such person in the organization (they left, or never were there). */
  | { kind: 'member_unavailable' }
  /** `404 project_member_not_found`: the member was already removed. */
  | { kind: 'member_gone' }
  /** `409 project_archived`: the project was archived since the page was drawn. */
  | { kind: 'archived' }
  /**
   * An answer that says the caller no longer has what the UI offered (ADR-0012 D3): `403 forbidden`, `404 project_not_found` or
   * `404 organization_not_found`. Any other 403 or 404 (a CSRF `origin_not_allowed`, a gateway's or the framework's generic `not_found`)
   * is NOT a change of access and is `other`.
   */
  | { kind: 'access_changed' }
  /** A network error, a timeout or a `5xx`: the write may or may not have happened. */
  | { kind: 'uncertain' }
  | { kind: 'other' };

const FIELD_NAMES = ['name', 'slug', 'description'] as const;

/**
 * The codes the backend uses when the caller's access to what the UI offered is gone: `ORGANIZATION_ERROR_CODES.forbidden` (a member
 * without the permission; also the framework's default code for a 403), `PROJECT_ERROR_CODES.projectNotFound` (a project the caller cannot
 * see: nonexistent, foreign and "no access" are one answer) and `ORGANIZATION_ERROR_CODES.organizationNotFound` (malformed, foreign or
 * not a member). Derived from apps/api `organizations/application/errors.ts` and `projects/application/errors.ts`.
 */
const ACCESS_CHANGED_CODES: Readonly<Record<number, readonly string[]>> = {
  403: [ORGANIZATION_ERROR_CODES.forbidden],
  404: [PROJECT_ERROR_CODES.projectNotFound, ORGANIZATION_ERROR_CODES.organizationNotFound],
};

export function classifyWriteFailure(error: unknown): WriteFailure {
  if (!isApiClientError(error)) return { kind: 'other' };
  if (error.kind === 'network' || error.kind === 'timeout') return { kind: 'uncertain' };
  if (error.kind !== 'http') return { kind: 'other' };
  if (error.status === 401) return { kind: 'unauthenticated' };
  // A 404 about the TARGET of a member change is not a change of the caller's access.
  if (error.status === 404 && error.code === PROJECT_ERROR_CODES.organizationMemberNotFound)
    return { kind: 'member_unavailable' };
  if (error.status === 404 && error.code === PROJECT_ERROR_CODES.projectMemberNotFound)
    return { kind: 'member_gone' };
  if (ACCESS_CHANGED_CODES[error.status]?.includes(error.code)) return { kind: 'access_changed' };
  if (error.status >= 500) return { kind: 'uncertain' };
  switch (error.code) {
    case PROJECT_ERROR_CODES.projectSlugTaken:
      return { kind: 'slug_taken' };
    case PROJECT_ERROR_CODES.projectArchived:
      return { kind: 'archived' };
    case PROJECT_ERROR_CODES.alreadyProjectMember:
      return { kind: 'already_member' };
    case 'validation_error': {
      // The API reports `details: [{ path, message }]`. Only the path is used: the server's English text is never shown.
      const paths = Array.isArray(error.details)
        ? error.details.map((issue: unknown) =>
            typeof issue === 'object' && issue !== null ? (issue as { path?: unknown }).path : undefined,
          )
        : [];
      return { kind: 'validation', fields: FIELD_NAMES.filter((name) => paths.includes(name)) };
    }
    default:
      return { kind: 'other' };
  }
}
