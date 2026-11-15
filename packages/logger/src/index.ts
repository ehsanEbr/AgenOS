import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Paths redacted from every log line (spec section 12.3: never log credentials).
 * Redaction is a safety net for accidents, not a license to log secrets: request bodies, headers and job payloads are
 * never logged in the first place.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.apiKey',
  '*.secret',
  '*.token',
  // Authentication (ADR-0010). pino's `*.x` matches ONE level only, so list the names a credential can travel under.
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.sessionToken',
  '*.credential',
];

export interface LoggerConfig {
  /** Process name attached to every line, e.g. "api" or "worker". */
  service: string;
  level: string;
  /** Human-readable output for local development (requires `pino-pretty` in the process). Never use in production. */
  pretty?: boolean;
}

/**
 * Options shared by every process: JSON lines with a `service` field, epoch `time`, and the common redaction.
 * The API feeds these (plus HTTP specifics) to pino-http; the worker uses them directly through `createLogger`.
 */
export function baseLoggerOptions({ service, level, pretty = false }: LoggerConfig): LoggerOptions {
  return {
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(baseLoggerOptions(config));
}
