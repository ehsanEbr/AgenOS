import { z } from 'zod';

/** Header used to correlate a request across API, queue jobs and logs. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Standard error body returned by every API endpoint (spec section 7.2). */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
