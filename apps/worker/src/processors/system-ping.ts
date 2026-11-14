import { systemPingJob } from '@agentos/contracts';
import { abortableDelay, defineProcessor } from '../runtime';

/**
 * Diagnostic processor: proves the whole path (producer -> Redis -> worker -> processor) and gives operators a job that is
 * genuinely in flight (`delayMs`) to observe shutdown and recovery with. It has no side effects, so it is idempotent by nature:
 * running it twice is indistinguishable from running it once. It is not a product feature and touches no domain data.
 */
export const systemPingProcessor = defineProcessor(systemPingJob, async (payload, ctx) => {
  if (payload.delayMs > 0) await abortableDelay(payload.delayMs, ctx.signal);
  ctx.logger.info({ delayMs: payload.delayMs }, 'system.ping handled');
});
