import { z } from 'zod';

/**
 * Environment validation shared by every backend process. Each process (API, worker) declares its OWN schema and
 * composes it from the building blocks below, so a variable has one definition and one meaning everywhere.
 */

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables against a schema. Error messages name the offending variables but never echo their
 * values: connection strings carry credentials.
 */
export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

/** Redis connection string (`redis://` or `rediss://`), including credentials. */
export const redisUrlSchema = z.url({ protocol: /^rediss?$/ });

/** PostgreSQL connection string (`postgresql://` or `postgres://`), including credentials. */
export const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * A boolean switch from an environment variable. Only the exact words `true` and `false` are accepted, so a typo such as
 * `AUTH_ALLOW_REGISTRATION=ture` fails at startup instead of silently meaning "off" (or worse, "on").
 */
export const booleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Comma-separated list from an environment variable: `"a, b,"` becomes `["a", "b"]`. */
export const csvSchema = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/**
 * A connection URL that is safe to log: protocol, host and port only. Credentials, path and query are dropped.
 * Returns "(invalid url)" for anything unparseable rather than echoing it.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(invalid url)';
  }
}
