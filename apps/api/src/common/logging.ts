import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';
import { getCorrelationId } from './correlation-id.middleware';
import { currentCorrelationId } from './request-context';

/**
 * Paths redacted from every log line (spec section 12.3: never log credentials).
 * Redaction is a safety net for accidents, not a license to log secrets: request/response bodies and headers are
 * never logged in the first place (see the serializers below).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.apiKey',
  '*.secret',
  '*.token',
];

/**
 * Structured logging contract for the API. Every line is JSON with:
 *   level, time, service ("api"), msg
 *   correlationId   present on every line written while handling a request (AsyncLocalStorage mixin)
 *   req             { id, method, path }  - no headers, no query string, no body
 *   res             { statusCode }
 * Application code logs through Nest's `Logger`; it must never log request bodies or credentials.
 */
export function buildPinoHttpOptions(config: { LOG_LEVEL: string; NODE_ENV: string }): Options {
  return {
    level: config.LOG_LEVEL,
    base: { service: 'api' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId: (req) => getCorrelationId(req) ?? randomUUID(),
    // Applies to every log line, including the request-completion line and lines written by services deep inside a
    // request. (Do not also add customProps: that would emit the key twice.)
    mixin: () => {
      const correlationId = currentCorrelationId();
      return correlationId ? { correlationId } : {};
    },
    serializers: {
      // Allowlist, not blocklist: query strings can carry tokens and headers carry credentials.
      req: (req: { id?: unknown; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        path: (req.url ?? '').split('?')[0],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    // Health probes are frequent and uninteresting.
    // Inside Nest's middleware `req.url` can be relative to the mount point; `originalUrl` is always the full path.
    autoLogging: {
      ignore: (req) => ((req as { originalUrl?: string }).originalUrl ?? req.url ?? '').includes('/health'),
    },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  };
}
