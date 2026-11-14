import { QUEUE_NAMES, type QueueName } from '@agentos/contracts';
import { z } from 'zod';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry';

/** Redis key namespace for every queue AgentOS creates, so AgentOS never collides with other BullMQ users of the same Redis. */
export const DEFAULT_QUEUE_PREFIX = 'agentos';
export const queuePrefixSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'letters, digits, "_" and "-" only');

export interface QueueDefinition {
  readonly name: QueueName;
  /** The default retry behavior for jobs in this queue. A producer may override it per job. */
  readonly retry: RetryPolicy;
}

/**
 * The queue registry: the single place where a queue's operational defaults are decided, shared by producers and workers
 * so they cannot drift. Adding a queue means adding its name to the contracts and its entry here.
 */
export const QUEUES: Readonly<Record<QueueName, QueueDefinition>> = {
  [QUEUE_NAMES.system]: { name: QUEUE_NAMES.system, retry: DEFAULT_RETRY_POLICY },
};

export function getQueueDefinition(name: QueueName): QueueDefinition {
  return QUEUES[name];
}
