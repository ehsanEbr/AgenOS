import { ProcessorRegistry } from '../runtime';
import { systemPingProcessor } from './system-ping';

/**
 * Every processor this worker process runs. Adding a job type = a processor file + one line here. A specialized worker
 * (agent, repository, MCP, scheduler) is a different set of processors and a different WORKER_QUEUES, not a different runtime.
 */
export function createRegistry(): ProcessorRegistry {
  return new ProcessorRegistry().register(systemPingProcessor);
}
