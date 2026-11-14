import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated list of allowed browser origins. Empty means no cross-origin access. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** PostgreSQL connection string, including credentials. Required: PostgreSQL is the source of truth. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Redis connection string (redis:// or rediss://), including credentials. Required. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});
export type ApiConfig = z.infer<typeof apiEnvSchema>;

/**
 * Validates environment variables. Error messages name the offending variables but never
 * echo their values: DATABASE_URL and REDIS_URL contain credentials.
 */
export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const result = apiEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
