import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './primitives';

/*
 * Identity contracts (ADR-0010): local email/password authentication with server-side sessions.
 * These schemas validate requests on the API and type the responses in the web app; they contain no framework code.
 */

/** Passwords are bounded in BYTES (UTF-8) so the work an attacker can force on the hash function is bounded. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 1024;

/** UTF-8 length of a string without needing TextEncoder (these contracts run in Node and in browsers, with no ambient types). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Normalized (trimmed, lower-cased) so that one address is one account. An email is an identifier here, not verified proof. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const displayNameSchema = z.string().trim().min(1).max(100);

/** A NEW password (registration, password change): the strength rule applies. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES, {
    message: `Use at most ${PASSWORD_MAX_BYTES} bytes`,
  });

/**
 * A password being CHECKED (sign-in, current password): only the size bound applies. The minimum length is not enforced here, so a
 * sign-in response never reveals the password policy and an account created under an older policy can still sign in.
 */
export const presentedPasswordSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES, {
    message: `Use at most ${PASSWORD_MAX_BYTES} bytes`,
  });

export const userStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Public representation of a user. Never contains credentials. */
export const userSchema = z.object({
  id: idSchema,
  email: z.string(),
  displayName: z.string(),
  status: userStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type User = z.infer<typeof userSchema>;

/** How a client carries its session token. The session itself (server-side row, expiry, revocation) is identical for both. */
export const sessionDeliverySchema = z.enum(['cookie', 'token']);
export type SessionDelivery = z.infer<typeof sessionDeliverySchema>;

/** What a client may learn about its own session. No token, no hash, no internal id. */
export const sessionInfoSchema = z.object({
  createdAt: isoDateTimeSchema,
  /** The session ends at this time even if it is used continuously. */
  expiresAt: isoDateTimeSchema,
  /** The session ends at this time unless it is used again; using it moves this time forward. */
  idleExpiresAt: isoDateTimeSchema,
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const registerRequestSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  password: newPasswordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = z.object({ user: userSchema });
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: presentedPasswordSchema,
  /** `cookie` (default): the token is set as an HttpOnly cookie. `token`: it is returned once in the body and no cookie is set. */
  delivery: sessionDeliverySchema.default('cookie'),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  user: userSchema,
  session: sessionInfoSchema,
  /** Present only when `delivery` was `token`. It is shown once and cannot be retrieved again. */
  token: z.string().optional(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const meResponseSchema = z.object({ user: userSchema, session: sessionInfoSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: presentedPasswordSchema,
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** The session is rotated by a password change: bearer clients receive the new token here, cookie clients a new cookie. */
export const changePasswordResponseSchema = z.object({
  session: sessionInfoSchema,
  token: z.string().optional(),
});
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

/** Stable error codes the identity API uses, so clients can switch on them. */
export const IDENTITY_ERROR_CODES = {
  invalidCredentials: 'invalid_credentials',
  unauthenticated: 'unauthenticated',
  registrationClosed: 'registration_closed',
  emailTaken: 'email_taken',
  tooManyAttempts: 'too_many_attempts',
  serviceUnavailable: 'authentication_unavailable',
  originNotAllowed: 'origin_not_allowed',
} as const;
