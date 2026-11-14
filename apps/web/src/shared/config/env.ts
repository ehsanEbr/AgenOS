import { z } from 'zod';

const envSchema = z.object({
  /** Base URL of the API. Defaults to same-origin `/api/v1` (proxied by Vite in development). */
  VITE_API_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : '/api/v1')),
  /** How long a single API request may take before it is aborted, in milliseconds. */
  VITE_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Provided by Vite: true in `vite dev`. Used only to decide how much error detail the UI may show. */
  DEV: z.boolean().default(false),
});

export function parseEnv(raw: Record<string, unknown>) {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid web environment configuration: ${issues}`);
  }
  return {
    apiBaseUrl: result.data.VITE_API_BASE_URL,
    apiTimeoutMs: result.data.VITE_API_TIMEOUT_MS,
    isDev: result.data.DEV,
  };
}

/**
 * Validated, typed environment. This is the ONLY place that reads `import.meta.env` (enforced by ESLint);
 * everything else imports `env`.
 */
export const env = parseEnv(import.meta.env);
