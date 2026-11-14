import { z } from 'zod';

/**
 * GET /api/v1/health - liveness: the API process is running.
 * Deliberately independent of PostgreSQL/Redis so an infrastructure outage never restarts a healthy process.
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Result of probing one required dependency. `reason` is a fixed vocabulary on purpose:
 * hostnames, ports, credentials and driver error text never appear in responses.
 */
export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  reason: z.enum(['timeout', 'unavailable']).optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/**
 * GET /api/v1/health/ready - readiness: all required infrastructure is reachable.
 * Returned with HTTP 200 when `ready` and HTTP 503 when `not_ready` (same body shape in both cases).
 */
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    postgres: dependencyCheckSchema,
    redis: dependencyCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
