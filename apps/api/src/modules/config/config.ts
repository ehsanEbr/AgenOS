import {
  ConfigError,
  csvSchema,
  logLevelSchema,
  nodeEnvSchema,
  parseConfig,
  postgresUrlSchema,
  redisUrlSchema,
} from '@agentos/config';
import { z } from 'zod';

export { ConfigError };

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated list of allowed browser origins. Empty means no cross-origin access. */
  CORS_ORIGINS: csvSchema.default([]),
  /** PostgreSQL connection string, including credentials. Required: PostgreSQL is the source of truth. */
  DATABASE_URL: postgresUrlSchema,
  /** Redis connection string (redis:// or rediss://), including credentials. Required. */
  REDIS_URL: redisUrlSchema,
});
export type ApiConfig = z.infer<typeof apiEnvSchema>;

/**
 * Validates environment variables. Error messages name the offending variables but never
 * echo their values: DATABASE_URL and REDIS_URL contain credentials.
 */
export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseConfig(apiEnvSchema, env);
}
