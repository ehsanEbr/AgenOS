import { vi } from 'vitest';
import type {
  ApiError,
  HealthResponse,
  LoginResponse,
  MeResponse,
  OrganizationWithRole,
  Project,
  ProjectMember,
  User,
} from '@agentos/contracts';

/*
 * Realistic API payloads. They are typed with the shared contracts, so a contract change breaks the fixture at compile time
 * instead of leaving tests that quietly pass on obsolete shapes.
 */

export const healthOk = {
  status: 'ok',
  service: 'api',
  uptimeSeconds: 3_721,
} satisfies HealthResponse;

export const testUser = {
  id: '0f8e4c3a-6b1d-4e7a-9a52-3c1d2b7e5a10',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  status: 'active',
  createdAt: '2026-01-05T09:30:00.000Z',
} satisfies User;

const sessionInfo = {
  createdAt: '2026-11-16T08:00:00.000Z',
  expiresAt: '2026-11-17T08:00:00.000Z',
  idleExpiresAt: '2026-11-16T12:00:00.000Z',
};

/** `GET /me` for a signed-in user. */
export const meOk = { user: testUser, session: sessionInfo } satisfies MeResponse;

/** `POST /auth/login` (cookie delivery: no token in the body). */
export const loginOk = { user: testUser, session: sessionInfo } satisfies LoginResponse;

/** The API's error for a missing or expired session, and for a failed sign-in. */
export const unauthenticatedError = {
  code: 'unauthenticated',
  message: 'Authentication is required',
  correlationId: 'srv-0a11b2',
} satisfies ApiError;
export const invalidCredentialsError = {
  code: 'invalid_credentials',
  message: 'Invalid email or password',
  correlationId: 'srv-9c77d1',
} satisfies ApiError;

/** An organization of the signed-in test user, with their role in it. */
export const testOrganization = {
  id: '5b0c9a7e-2d4f-4f6a-8d1e-7c3b9a2e4f10',
  name: 'Acme Labs',
  createdAt: '2026-02-01T10:00:00.000Z',
  updatedAt: '2026-02-01T10:00:00.000Z',
  role: 'owner',
} satisfies OrganizationWithRole;

/** `GET /organizations` answer: the rows of one page, with the real page info (`total` defaults to the rows given). */
export const organizationPage = (
  items: OrganizationWithRole[],
  page: { offset?: number; total?: number } = {},
) => ({ items, page: { limit: 100, offset: page.offset ?? 0, total: page.total ?? items.length } });

/** An active project of the test organization that the test user reaches through their organization role (no explicit project role). */
export const testProject = {
  id: '9d4e1b2c-3a5f-4c7d-8e6a-1b2c3d4e5f60',
  organizationId: testOrganization.id,
  name: 'Platform Rewrite',
  slug: 'platform-rewrite',
  description: 'Move the platform to the new runtime.',
  status: 'active',
  archivedAt: null,
  createdAt: '2026-03-02T09:00:00.000Z',
  updatedAt: '2026-03-05T14:30:00.000Z',
  projectRole: null,
} satisfies Project;

/** An explicit member of {@link testProject}. */
export const testProjectMember = {
  userId: testUser.id,
  email: testUser.email,
  displayName: testUser.displayName,
  role: 'project_admin',
  joinedAt: '2026-03-02T09:05:00.000Z',
} satisfies ProjectMember;

/** The API's answer for an organization that does not exist or the caller does not belong to (indistinguishable by design). */
export const organizationNotFoundError = {
  code: 'organization_not_found',
  message: 'Organization was not found',
  correlationId: 'srv-5d03e8',
} satisfies ApiError;

export const notFoundError = {
  code: 'agent_not_found',
  message: 'Agent 5f0d6c1e was not found',
  correlationId: 'srv-8b1f2c',
} satisfies ApiError;

export const validationError = {
  code: 'validation_error',
  message: 'Request validation failed',
  details: [{ path: 'limit', message: 'Too big: expected number to be <=100' }],
  correlationId: 'srv-41aa09',
} satisfies ApiError;

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const htmlResponse = (status: number) =>
  new Response('<html><body>Bad gateway</body></html>', { status, headers: { 'content-type': 'text/html' } });

type Handler = (request: { url: URL; init: RequestInit }) => Response | Promise<Response>;

/**
 * Replaces `fetch` with a controllable fake and returns the spy for assertions. The handler receives the parsed URL
 * (relative URLs resolve against http://localhost), so tests can route by pathname.
 */
export function mockFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    handler({ url: new URL(String(input), 'http://localhost'), init }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The health endpoint answers OK and everything else is a 404 in the API's standard error format. */
export const healthyApi = () =>
  mockFetch(({ url }) =>
    url.pathname.endsWith('/health') ? jsonResponse(healthOk) : jsonResponse(notFoundError, 404),
  );
