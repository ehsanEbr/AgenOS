import { createRegistry } from './processors';
import { runWorker } from './run';

// The production worker: the real processors. All process behavior (config, signals, health, exit codes) is in run.ts.
void runWorker({ registry: createRegistry() });
