import { z } from 'zod';

export const systemJobStatusSchema = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);
export type SystemJobStatus = z.infer<typeof systemJobStatusSchema>;

/** POST /api/v1/system/jobs */
export const createSystemJobRequestSchema = z.object({
  message: z.string().trim().min(1).max(200),
});
export type CreateSystemJobRequest = z.infer<typeof createSystemJobRequestSchema>;

export const systemJobSchema = z.object({
  id: z.uuid(),
  status: systemJobStatusSchema,
  message: z.string(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type SystemJob = z.infer<typeof systemJobSchema>;

/**
 * Queue payload. Deliberately minimal: it references the persisted job by id and
 * never carries credentials or sensitive context (spec section 11.3).
 */
export const systemJobQueuePayloadSchema = z.object({
  jobId: z.uuid(),
  correlationId: z.string().min(1),
});
export type SystemJobQueuePayload = z.infer<typeof systemJobQueuePayloadSchema>;

export const SYSTEM_JOB_NAME = 'system.ping';
export const SYSTEM_JOB_MAX_ATTEMPTS = 3;
