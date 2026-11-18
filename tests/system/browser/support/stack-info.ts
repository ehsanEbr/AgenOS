/*
 * What the browser tests need to know about the throwaway stack that `global-setup.ts` booted. The runner's workers are separate
 * processes, so the setup hands this over through an environment variable (set before the workers start). Everything in it is
 * generated for the run and belongs to a stack that is destroyed afterwards: nothing real, no developer value.
 */

export const STACK_INFO_ENV = 'AGENTOS_BROWSER_STACK';

export interface Person {
  /** Display name, unique within the run. */
  name: string;
  email: string;
  password: string;
  id: string;
  /** A bearer token for API setup calls. The browser never sees it: it signs in with a cookie. */
  token: string;
}

export const PERSON_KEYS = ['ada', 'bob', 'cara'] as const;
export type PersonKey = (typeof PERSON_KEYS)[number];

export interface StackInfo {
  /** The Compose project name (`agentos-systest-<id>`). */
  project: string;
  /** `http://localhost:<port>`: the API accepts only the configured origin, so the browser must not use 127.0.0.1 (ADR-0012 V11). */
  webOrigin: string;
  /** Throwaway password of the migration role, to run a statement the API has no endpoint for (see `database.ts`). */
  migratePassword: string;
  /** The people registered once for the run (the registration limit is 5 per hour per address, so tests share them). */
  people: Record<PersonKey, Person>;
}

export function readStackInfo(): StackInfo {
  const raw = process.env[STACK_INFO_ENV];
  if (!raw) throw new Error('the browser stack is not running: global-setup.ts did not publish it');
  return JSON.parse(raw) as StackInfo;
}
