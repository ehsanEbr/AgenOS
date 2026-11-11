import { z } from 'zod';

const envSchema = z.object({
  /** Base URL of the API. Defaults to same-origin `/api/v1` (proxied by Vite in development). */
  VITE_API_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : '/api/v1')),
});

export function parseEnv(raw: Record<string, unknown>) {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid web environment configuration: ${issues}`);
  }
  return { apiBaseUrl: result.data.VITE_API_BASE_URL };
}

/** Validated, typed environment. Import this instead of reading `import.meta.env` directly. */
export const env = parseEnv(import.meta.env);
