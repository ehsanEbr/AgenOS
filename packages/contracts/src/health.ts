import { z } from 'zod';

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), dependencyCheckSchema),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
