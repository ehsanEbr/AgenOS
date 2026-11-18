import {
  loginResponseSchema,
  meResponseSchema,
  registerResponseSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@agentos/contracts';
import { z } from 'zod';
import { apiRequest } from '../../shared/api/client';

/*
 * The endpoints of the identity API (backend: apps/api identity module). Responses are validated by the shared contracts.
 * Cookie delivery is the default of `/auth/login`, so the browser never sees a token: the session cookie is HttpOnly.
 */

/** `GET /me`: the signed-in user and the state of the session. A missing or expired session answers `401 unauthenticated`. */
export const getMe = (signal?: AbortSignal) => apiRequest('/me', meResponseSchema, { signal });

/** `POST /auth/login`. A wrong email or password answers `401 invalid_credentials`. */
export const login = (credentials: Pick<LoginRequest, 'email' | 'password'>) =>
  apiRequest('/auth/login', loginResponseSchema, { method: 'POST', body: credentials });

/**
 * `POST /auth/register`: creates the account and answers `{ user }`. It does NOT sign the user in. Allowed for the first user of an
 * empty instance and afterwards only when the operator enabled registration (`403 registration_closed` otherwise).
 */
export const register = (account: RegisterRequest) =>
  apiRequest('/auth/register', registerResponseSchema, { method: 'POST', body: account });

/** `POST /auth/logout`: `204` with no body. A session that is already over answers `401 unauthenticated`. */
export const logout = () => apiRequest('/auth/logout', z.undefined(), { method: 'POST' });
