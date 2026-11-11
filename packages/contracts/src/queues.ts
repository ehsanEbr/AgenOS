/**
 * Queue registry (spec section 11.2). Names are shared between producers (API)
 * and consumers (workers) so they cannot drift apart.
 *
 * Only `system-jobs` is wired up in Phase 1; the other queues are reserved for
 * the phases that implement their domains.
 */
export const QUEUE_NAMES = {
  /** Phase 1 foundation/smoke-test queue; proves enqueue -> worker -> persisted result. */
  SYSTEM_JOBS: 'system-jobs',
  AGENT_EXECUTIONS: 'agent-executions',
  REPOSITORY_INDEXING: 'repository-indexing',
  REPOSITORY_ANALYSIS: 'repository-analysis',
  MCP_EXECUTIONS: 'mcp-executions',
  SCHEDULED_JOBS: 'scheduled-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
