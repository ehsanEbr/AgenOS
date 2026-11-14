import { systemPingProcessor } from '../../src/processors/system-ping';
import { runWorker } from '../../src/run';
import { ProcessorRegistry, defineProcessor } from '../../src/runtime';
import { stuckJob } from './stuck-job';

/*
 * TEST-ONLY process entry. It is the REAL worker (`runWorker`: configuration, signals, health file, exit codes) with one extra
 * processor that never finishes and ignores its AbortSignal. Production `main.ts` registers only the real processors, so a
 * misbehaving handler never exists in the shipped worker; this file exists to prove what the process does when one does.
 * Run with `node --import tsx test/support/stuck-main.ts`.
 */
const registry = new ProcessorRegistry().register(systemPingProcessor).register(
  defineProcessor(stuckJob, async (_payload, ctx) => {
    ctx.logger.info('stuck handler started');
    await new Promise<never>(() => undefined); // never settles; the signal is ignored
  }),
);

void runWorker({ registry });
