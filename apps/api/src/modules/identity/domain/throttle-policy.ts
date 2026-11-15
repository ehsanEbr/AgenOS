/**
 * Rate limits for the authentication endpoints. They live in code (like the queue retry policy), not in the environment, so a
 * deployment cannot loosen them by accident. Counters are kept in Redis (ephemeral state) keyed by a hash of the subject.
 */
export type ThrottleScope = 'signin-account' | 'signin-address' | 'register-address' | 'password-account';

export interface ThrottleRule {
  /** Events allowed within the window. */
  readonly max: number;
  readonly windowSeconds: number;
}

export const THROTTLE_RULES: Readonly<Record<ThrottleScope, ThrottleRule>> = {
  // Failed sign-ins for one account, counted even when the account does not exist so the limiter reveals nothing.
  'signin-account': { max: 10, windowSeconds: 15 * 60 },
  // Failed sign-ins from one client address.
  'signin-address': { max: 30, windowSeconds: 15 * 60 },
  // Registration attempts (every attempt counts) from one client address.
  'register-address': { max: 5, windowSeconds: 60 * 60 },
  // Wrong "current password" when changing a password, per user.
  'password-account': { max: 10, windowSeconds: 15 * 60 },
};
