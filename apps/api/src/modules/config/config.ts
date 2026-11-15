import {
  ConfigError,
  booleanSchema,
  csvSchema,
  logLevelSchema,
  nodeEnvSchema,
  parseConfig,
  postgresUrlSchema,
  redisUrlSchema,
} from '@agentos/config';
import { z } from 'zod';

export { ConfigError };

const apiEnvObject = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated list of allowed browser origins. Empty means no cross-origin access. */
  CORS_ORIGINS: csvSchema.default([]),
  /**
   * The origin browsers use to reach the web app (`scheme://host[:port]`, no path). It decides the session cookie's `Secure` flag
   * and is the only origin a cookie-authenticated state-changing request may come from (CSRF defense).
   */
  WEB_ORIGIN: z
    .url()
    .transform((value) => new URL(value).origin)
    .default('http://localhost:5173'),
  /**
   * PostgreSQL connection string, including credentials: the API's own role (agentos_api), never the superuser and never the
   * migration role. Required: PostgreSQL is the source of truth.
   */
  DATABASE_URL: postgresUrlSchema,
  /** Redis connection string (redis:// or rediss://), including credentials. Required. */
  REDIS_URL: redisUrlSchema,
  /**
   * Whether `POST /auth/register` accepts new accounts once the first user exists. Off by default: with it on, anyone who can
   * reach the API can create an account. Read at startup, so changing it needs a restart. The very first registration on an empty
   * instance is always allowed (bootstrap).
   */
  AUTH_ALLOW_REGISTRATION: booleanSchema.default(false),
  /** Permits a non-HTTPS WEB_ORIGIN on a non-loopback host (cookies are then sent without `Secure`). Development only. */
  AUTH_ALLOW_INSECURE_ORIGIN: booleanSchema.default(false),
  /** A session ends after this many minutes without use. */
  SESSION_IDLE_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30)
    .default(1440),
  /** A session ends this many hours after sign-in, however often it is used. */
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .default(336),
  /** How many reverse proxies sit in front of the API (0 = none). Needed to read the client address, which rate limiting uses. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const apiEnvSchema = apiEnvObject.superRefine((env, ctx) => {
  const origin = new URL(env.WEB_ORIGIN);
  if (
    origin.protocol !== 'https:' &&
    !LOOPBACK_HOSTS.has(origin.hostname) &&
    !env.AUTH_ALLOW_INSECURE_ORIGIN
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEB_ORIGIN'],
      message:
        'must use https, or point at localhost (set AUTH_ALLOW_INSECURE_ORIGIN=true to accept plain http on another host)',
    });
  }
  if (env.SESSION_ABSOLUTE_TTL_HOURS * 60 < env.SESSION_IDLE_TTL_MINUTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_ABSOLUTE_TTL_HOURS'],
      message: 'must not be shorter than SESSION_IDLE_TTL_MINUTES',
    });
  }
});
export type ApiConfig = z.infer<typeof apiEnvSchema>;

/**
 * Validates environment variables. Error messages name the offending variables but never
 * echo their values: DATABASE_URL and REDIS_URL contain credentials.
 */
export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseConfig(apiEnvSchema, env);
}
