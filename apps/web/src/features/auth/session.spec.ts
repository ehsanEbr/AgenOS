import { describe, expect, it } from 'vitest';
import { healthKeys } from '../health';
import { PUBLIC_QUERY_ROOTS, SESSION_KEY, isPrivateQueryKey } from './session';

describe('which query keys are private (ADR-0012 D4 rule 1)', () => {
  it('treats exactly the session and health roots as public', () => {
    expect([...PUBLIC_QUERY_ROOTS].sort()).toEqual(['health', 'session']);
    expect(isPrivateQueryKey(SESSION_KEY)).toBe(false);
    expect(isPrivateQueryKey(['health', 'liveness'])).toBe(false);
  });

  it('is fail-closed: any other root, an unknown one included, is private', () => {
    for (const key of [
      ['projects'],
      ['organizations', 'list'],
      ['something-new'],
      ['Session'],
      ['session-owner'],
    ])
      expect(isPrivateQueryKey(key), JSON.stringify(key)).toBe(true);
  });

  it('is fail-closed for keys that do not start with a string root', () => {
    for (const key of [[], [undefined], [null], [{ session: true }], [42]])
      expect(isPrivateQueryKey(key), JSON.stringify(key)).toBe(true);
  });

  it('is decided by the root alone, never by the rest of the key', () => {
    expect(isPrivateQueryKey(['projects', 'session'])).toBe(true);
    expect(isPrivateQueryKey(['health', 'projects', 'p1'])).toBe(false);
  });

  it('holds for every existing key factory: its keys begin with its own, correctly classified root', () => {
    // A new feature adds its factory here when it lands; a factory whose root is not its own name would be a design error.
    expect(healthKeys.all[0]).toBe('health');
    expect(isPrivateQueryKey(healthKeys.liveness())).toBe(false);
  });
});
