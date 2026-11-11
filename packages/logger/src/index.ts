import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  /** Service name attached to every log line, e.g. "api" or "agent-worker". */
  service: string;
  level?: string;
  /** Human-readable output for local development. Never use in production. */
  pretty?: boolean;
}

/** Paths redacted from every log line (spec section 12.3: never log credentials). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.apiKey',
  '*.secret',
  '*.token',
];

export function buildLoggerOptions({
  service,
  level = 'info',
  pretty = false,
}: CreateLoggerOptions): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(buildLoggerOptions(options));
}
