import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';
import { getCorrelationId } from './correlation-id.middleware';

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

/** pino-http options: JSON logs with redaction, correlation id as request id, pretty output in development. */
export function buildPinoHttpOptions(config: { LOG_LEVEL: string; NODE_ENV: string }): Options {
  return {
    level: config.LOG_LEVEL,
    base: { service: 'api' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId: (req) => getCorrelationId(req) ?? randomUUID(),
    customProps: (req) => ({ correlationId: getCorrelationId(req) }),
    // Health probes are frequent and uninteresting.
    autoLogging: { ignore: (req) => req.url?.includes('/health') ?? false },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  };
}
