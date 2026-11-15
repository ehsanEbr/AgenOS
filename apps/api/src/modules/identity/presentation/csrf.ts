import { IDENTITY_ERROR_CODES } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';
import { type HttpRequest, header } from './http';

/*
 * CSRF defense for cookie-authenticated requests (ADR-0010, decision 2). SameSite=Lax on the cookie is the first layer; these checks
 * are the second. Bearer-token requests are not exposed to CSRF (a browser never attaches that header by itself) and skip them.
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const isUnsafeMethod = (method: string): boolean => UNSAFE_METHODS.has(method.toUpperCase());

const originNotAllowed = () =>
  new AppError(
    'forbidden',
    IDENTITY_ERROR_CODES.originNotAllowed,
    'This request did not come from an allowed origin',
  );

/**
 * The request must come from the configured web origin. An `Origin` header, when present, must equal it exactly (the string "null" of
 * sandboxed contexts does not). With no `Origin`, `required` decides: a cookie-authenticated state-changing request must then at least
 * carry `Sec-Fetch-Site: same-origin`; the public sign-in and registration endpoints only check when the header is there.
 */
export function assertAllowedOrigin(
  request: HttpRequest,
  webOrigin: string,
  options: { required: boolean },
): void {
  const origin = header(request, 'origin');
  if (origin !== undefined) {
    if (origin !== webOrigin) throw originNotAllowed();
    return;
  }
  if (!options.required) return;
  if (header(request, 'sec-fetch-site') === 'same-origin') return;
  throw originNotAllowed();
}

/**
 * A cookie-authenticated request that carries a body must declare it JSON. Browsers cannot send `application/json` cross-site without
 * a CORS preflight, which makes the check meaningful. (A request with no body, such as logout, has no content type to check.)
 */
export function assertJsonWhenBodyPresent(request: HttpRequest): void {
  const length = header(request, 'content-length');
  const hasBody =
    (length !== undefined && Number(length) > 0) || header(request, 'transfer-encoding') !== undefined;
  if (!hasBody) return;
  if (!/^application\/json(\s*;|$)/i.test(header(request, 'content-type') ?? '')) {
    throw new AppError('validation', 'json_required', 'The request body must be application/json');
  }
}
