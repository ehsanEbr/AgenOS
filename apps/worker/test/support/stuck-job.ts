import { defineJob } from '@agentos/contracts';
import { z } from 'zod';

/** A job whose handler never ends and ignores its AbortSignal: the non-cooperative asynchronous handler of the timeout review. */
export const stuckJob = defineJob({ queue: 'system', type: 'test.stuck', version: 1, payload: z.object({}) });
