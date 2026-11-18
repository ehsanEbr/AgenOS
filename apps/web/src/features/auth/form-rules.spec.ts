import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../shared/api/errors';
import {
  PASSWORD_MIN_LENGTH,
  classifyAuthFailure,
  displayNameProblem,
  emailProblem,
  newPasswordProblem,
  presentedPasswordProblem,
} from './form-rules';
import { DEFAULT_AFTER_SIGN_IN, afterSignInTarget, readAuthNavigationState } from './navigation-state';

const http = (status: number, code: string, details?: unknown) =>
  new ApiClientError({ kind: 'http', message: 'x', status, code, details });

describe('field checks reuse the contract rules', () => {
  it('email: required, and the contract decides what is valid (canonicalized first)', () => {
    expect(emailProblem('')).toBe('emailRequired');
    expect(emailProblem('   ')).toBe('emailRequired');
    expect(emailProblem(undefined)).toBe('emailRequired');
    expect(emailProblem('not-an-email')).toBe('emailInvalid');
    expect(emailProblem('a@b')).toBe('emailInvalid');
    expect(emailProblem('  Ada@Example.COM ')).toBeNull();
  });

  it('a password being CHECKED has no minimum length (sign-in never reveals the policy), only presence and the byte bound', () => {
    expect(presentedPasswordProblem('')).toBe('passwordRequired');
    expect(presentedPasswordProblem('x')).toBeNull();
    expect(presentedPasswordProblem('é'.repeat(600))).toBe('passwordTooLong'); // 1200 bytes
  });

  it('a NEW password follows the strength rule: the minimum length and the byte bound', () => {
    expect(newPasswordProblem('')).toBe('passwordRequired');
    expect(newPasswordProblem('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('passwordTooShort');
    expect(newPasswordProblem('x'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(newPasswordProblem('é'.repeat(600))).toBe('passwordTooLong');
  });

  it('display name: required after trimming, at most 100 characters', () => {
    expect(displayNameProblem('  ')).toBe('nameRequired');
    expect(displayNameProblem('Ada')).toBeNull();
    expect(displayNameProblem('x'.repeat(100))).toBeNull();
    expect(displayNameProblem('x'.repeat(101))).toBe('nameTooLong');
  });
});

describe('classifyAuthFailure uses only the documented error codes', () => {
  it.each([
    [401, 'invalid_credentials', 'invalid_credentials'],
    [429, 'too_many_attempts', 'too_many_attempts'],
    [503, 'authentication_unavailable', 'unavailable'],
    [403, 'origin_not_allowed', 'origin_not_allowed'],
    [403, 'registration_closed', 'registration_closed'],
    [409, 'email_taken', 'email_taken'],
  ])('%i %s -> %s', (status, code, kind) => {
    expect(classifyAuthFailure(http(status, code))).toEqual({ kind });
  });

  it('reads the field names of a validation failure from the details paths and ignores everything else', () => {
    const details = [
      { path: 'email', message: 'server english' },
      { path: 'password', message: 'x' },
      { path: 'unknown', message: 'x' },
      'garbage',
      null,
    ];
    expect(classifyAuthFailure(http(400, 'validation_error', details))).toEqual({
      kind: 'validation',
      fields: ['email', 'password'],
    });
    expect(classifyAuthFailure(http(400, 'validation_error', 'not a list'))).toEqual({
      kind: 'validation',
      fields: [],
    });
  });

  it('anything else, a network failure included, is "other" and keeps the error for the shared messages', () => {
    const network = new ApiClientError({ kind: 'network', message: 'x', code: 'network_error' });
    expect(classifyAuthFailure(network)).toEqual({ kind: 'other', error: network });
    expect(classifyAuthFailure(http(500, 'internal_error')).kind).toBe('other');
    expect(classifyAuthFailure(new Error('boom')).kind).toBe('other');
  });
});

describe('the "return to where I was" hint is validated before it is trusted', () => {
  const from = (pathname: string, search = '', hash = '') => ({ from: { pathname, search, hash } });

  it('accepts an in-app path with its query and hash', () => {
    expect(afterSignInTarget(readAuthNavigationState(from('/agents/1', '?tab=2', '#top')).from)).toBe(
      '/agents/1?tab=2#top',
    );
  });

  it.each([
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash trick', '/\\evil.example'],
    ['a relative path', 'agents'],
    ['the sign-in page itself', '/sign-in'],
    ['the sign-up page', '/sign-up'],
  ])('falls back to the default for %s', (_name, pathname) => {
    expect(afterSignInTarget(readAuthNavigationState(from(pathname)).from)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('reads malformed navigation state as empty, and keeps only the known fields', () => {
    expect(readAuthNavigationState(undefined)).toEqual({});
    expect(readAuthNavigationState('x')).toEqual({});
    expect(readAuthNavigationState({ from: { pathname: 1 }, ended: 'yes', registered: false })).toEqual({});
    expect(readAuthNavigationState({ ended: true, registered: true, email: 'a@b.c', extra: 1 })).toEqual({
      ended: true,
      registered: true,
      email: 'a@b.c',
    });
    expect(afterSignInTarget(undefined)).toBe(DEFAULT_AFTER_SIGN_IN);
  });
});
