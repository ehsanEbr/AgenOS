import { projectDescriptionSchema, projectNameSchema, projectSlugSchema } from '@agentos/contracts';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../shared/api/errors';
import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  classifyWriteFailure,
  descriptionProblem,
  nameProblem,
  slugProblem,
} from './form-rules';
import { SLUG_MAX_LENGTH } from './slug';

describe("the limits are the contract's", () => {
  it('name, slug and description bounds match the schemas the API validates with', () => {
    expect(projectNameSchema.safeParse('n'.repeat(NAME_MAX_LENGTH)).success).toBe(true);
    expect(projectNameSchema.safeParse('n'.repeat(NAME_MAX_LENGTH + 1)).success).toBe(false);
    expect(projectSlugSchema.safeParse('s'.repeat(SLUG_MIN_LENGTH)).success).toBe(true);
    expect(projectSlugSchema.safeParse('s'.repeat(SLUG_MIN_LENGTH - 1)).success).toBe(false);
    expect(projectSlugSchema.safeParse('s'.repeat(SLUG_MAX_LENGTH)).success).toBe(true);
    expect(projectSlugSchema.safeParse('s'.repeat(SLUG_MAX_LENGTH + 1)).success).toBe(false);
    expect(projectDescriptionSchema.safeParse('d'.repeat(DESCRIPTION_MAX_LENGTH)).success).toBe(true);
    expect(projectDescriptionSchema.safeParse('d'.repeat(DESCRIPTION_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('nameProblem', () => {
  it.each([
    ['', 'nameRequired'],
    ['   ', 'nameRequired'],
    [undefined, 'nameRequired'],
    [42, 'nameRequired'],
    ['x'.repeat(NAME_MAX_LENGTH + 1), 'nameTooLong'],
    ['x'.repeat(NAME_MAX_LENGTH), null],
    ['  Platform  ', null],
  ])('%j -> %j', (value, expected) => {
    expect(nameProblem(value)).toBe(expected);
  });

  it('measures the name after trimming, as the contract does', () => {
    expect(nameProblem(' '.repeat(5) + 'x'.repeat(NAME_MAX_LENGTH) + ' '.repeat(5))).toBeNull();
  });
});

describe('slugProblem', () => {
  it.each([
    ['', 'slugRequired'],
    ['a', 'slugTooShort'],
    ['x'.repeat(SLUG_MAX_LENGTH + 1), 'slugTooLong'],
    ['Has-Capitals', 'slugInvalid'],
    ['has space', 'slugInvalid'],
    ['has_underscore', 'slugInvalid'],
    ['-leading', 'slugInvalid'],
    ['trailing-', 'slugInvalid'],
    ['double--hyphen', 'slugInvalid'],
    ['ok', null],
    ['platform-rewrite', null],
    ['2026-plan', null],
    ['x'.repeat(SLUG_MAX_LENGTH), null],
  ])('%j -> %j', (value, expected) => {
    expect(slugProblem(value)).toBe(expected);
  });
});

describe('descriptionProblem', () => {
  it('is optional: empty and blank are fine', () => {
    expect(descriptionProblem('')).toBeNull();
    expect(descriptionProblem('   ')).toBeNull();
    expect(descriptionProblem(undefined)).toBeNull();
  });

  it('has a maximum', () => {
    expect(descriptionProblem('d'.repeat(DESCRIPTION_MAX_LENGTH))).toBeNull();
    expect(descriptionProblem('d'.repeat(DESCRIPTION_MAX_LENGTH + 1))).toBe('descriptionTooLong');
  });
});

describe('classifyWriteFailure', () => {
  const http = (status: number, code = 'x', details?: unknown) =>
    new ApiClientError({ kind: 'http', message: 'server text', status, code, details });
  const transport = (kind: 'network' | 'timeout') =>
    new ApiClientError({ kind, message: 'x', code: kind === 'network' ? 'network_error' : 'timeout' });

  it('a network error, a timeout and any 5xx are UNCERTAIN: the write may or may not have happened', () => {
    expect(classifyWriteFailure(transport('network'))).toEqual({ kind: 'uncertain' });
    expect(classifyWriteFailure(transport('timeout'))).toEqual({ kind: 'uncertain' });
    for (const status of [500, 502, 503, 504, 599])
      expect(classifyWriteFailure(http(status))).toEqual({ kind: 'uncertain' });
  });

  it("401 is the session's business, whatever its code", () => {
    expect(classifyWriteFailure(http(401, 'unauthenticated'))).toEqual({ kind: 'unauthenticated' });
  });

  it('403 and 404 mean "your access changed"', () => {
    expect(classifyWriteFailure(http(403, 'forbidden'))).toEqual({ kind: 'access_changed' });
    expect(classifyWriteFailure(http(404, 'project_not_found'))).toEqual({ kind: 'access_changed' });
    expect(classifyWriteFailure(http(404, 'organization_not_found'))).toEqual({ kind: 'access_changed' });
  });

  it('409 is told apart by its code: a taken slug, an archived project, anything else', () => {
    expect(classifyWriteFailure(http(409, 'project_slug_taken'))).toEqual({ kind: 'slug_taken' });
    expect(classifyWriteFailure(http(409, 'project_archived'))).toEqual({ kind: 'archived' });
    expect(classifyWriteFailure(http(409, 'something_else'))).toEqual({ kind: 'other' });
  });

  it("a validation failure names the fields by path only; the server's text is not used", () => {
    const failure = classifyWriteFailure(
      http(400, 'validation_error', [
        { path: 'slug', message: 'Use lower-case letters' },
        { path: 'name', message: 'Too long' },
        { path: 'organizationId', message: 'ignored: not a field of the form' },
        'garbage',
      ]),
    );
    expect(failure).toEqual({ kind: 'validation', fields: ['name', 'slug'] });
  });

  it('a validation failure without usable details names no field', () => {
    expect(classifyWriteFailure(http(400, 'validation_error'))).toEqual({ kind: 'validation', fields: [] });
    expect(classifyWriteFailure(http(400, 'validation_error', 'nope'))).toEqual({
      kind: 'validation',
      fields: [],
    });
  });

  describe('"your access changed" is told by the backend\'s codes, not by the status alone (S1)', () => {
    it('is exactly 403 forbidden, 404 project_not_found and 404 organization_not_found', () => {
      expect(classifyWriteFailure(http(403, 'forbidden'))).toEqual({ kind: 'access_changed' });
      expect(classifyWriteFailure(http(404, 'project_not_found'))).toEqual({ kind: 'access_changed' });
      expect(classifyWriteFailure(http(404, 'organization_not_found'))).toEqual({ kind: 'access_changed' });
    });

    it.each([
      ['a CSRF refusal (a deployment problem, not a change of access)', 403, 'origin_not_allowed'],
      ['an unrelated 403 code', 403, 'registration_closed'],
      ['an unexpected 403 code', 403, 'something_new'],
      ["the framework's or a gateway's generic 404", 404, 'not_found'],
      ["a 404 whose body could not be read (the client's own code)", 404, 'unknown_error'],
      ['an unexpected 404 code', 404, 'something_new'],
      [
        'a member-target 404 reached through another route is still not about the caller',
        404,
        'member_not_found',
      ],
    ])('%s is "other", not "access changed"', (_, status, code) => {
      expect(classifyWriteFailure(http(status, code))).toEqual({ kind: 'other' });
    });

    it('the right code on the wrong status is not "access changed" either', () => {
      expect(classifyWriteFailure(http(404, 'forbidden'))).toEqual({ kind: 'other' });
      expect(classifyWriteFailure(http(403, 'project_not_found'))).toEqual({ kind: 'other' });
      expect(classifyWriteFailure(http(400, 'project_not_found'))).toEqual({ kind: 'other' });
      expect(classifyWriteFailure(http(409, 'forbidden'))).toEqual({ kind: 'other' });
    });

    it('does not change what the other known codes mean', () => {
      expect(classifyWriteFailure(http(404, 'organization_member_not_found'))).toEqual({
        kind: 'member_unavailable',
      });
      expect(classifyWriteFailure(http(404, 'project_member_not_found'))).toEqual({ kind: 'member_gone' });
      expect(classifyWriteFailure(http(409, 'already_project_member'))).toEqual({ kind: 'already_member' });
      expect(classifyWriteFailure(http(409, 'project_archived'))).toEqual({ kind: 'archived' });
      expect(classifyWriteFailure(http(409, 'project_slug_taken'))).toEqual({ kind: 'slug_taken' });
      expect(classifyWriteFailure(http(401, 'unauthenticated'))).toEqual({ kind: 'unauthenticated' });
      expect(classifyWriteFailure(http(503, 'x'))).toEqual({ kind: 'uncertain' });
    });
  });

  it("the outcomes of a MEMBER change are told apart from a change of the caller's access", () => {
    // A 404 about the TARGET of the change is not "your access changed".
    expect(classifyWriteFailure(http(404, 'organization_member_not_found'))).toEqual({
      kind: 'member_unavailable',
    });
    expect(classifyWriteFailure(http(404, 'project_member_not_found'))).toEqual({ kind: 'member_gone' });
    expect(classifyWriteFailure(http(409, 'already_project_member'))).toEqual({ kind: 'already_member' });
    // The same status with another code is still the caller's access.
    expect(classifyWriteFailure(http(404, 'project_not_found'))).toEqual({ kind: 'access_changed' });
    expect(classifyWriteFailure(http(404, 'organization_not_found'))).toEqual({ kind: 'access_changed' });
    expect(classifyWriteFailure(http(403, 'forbidden'))).toEqual({ kind: 'access_changed' });
    // Transport and server failures stay uncertain whatever the operation.
    expect(classifyWriteFailure(http(500, 'already_project_member'))).toEqual({ kind: 'uncertain' });
  });

  it('anything that is not an API failure, or an invalid response, is "other"', () => {
    expect(classifyWriteFailure(new Error('boom'))).toEqual({ kind: 'other' });
    expect(classifyWriteFailure(undefined)).toEqual({ kind: 'other' });
    expect(
      classifyWriteFailure(
        new ApiClientError({ kind: 'invalid_response', message: 'x', code: 'invalid_response' }),
      ),
    ).toEqual({ kind: 'other' });
    expect(classifyWriteFailure(http(400, 'some_other_400'))).toEqual({ kind: 'other' });
  });
});
