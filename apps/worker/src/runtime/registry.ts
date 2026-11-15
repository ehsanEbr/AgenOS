import type { QueueName } from '@agentos/contracts';
import type { JobProcessor } from './processor';

export type LookupResult =
  | { found: true; processor: JobProcessor }
  | { found: false; reason: 'unknown_type' | 'unsupported_version'; supportedVersions: number[] };

/**
 * Which processor handles which job: keyed by queue, job type and payload version. A processor handles exactly one
 * version; to support an old and a new payload shape at once during a rollout, register two processors.
 * Registering the same (queue, type, version) twice is a programming error and throws, so a mistake cannot silently
 * replace a handler.
 */
export class ProcessorRegistry {
  private readonly processors = new Map<string, Map<number, JobProcessor>>();

  register(processor: JobProcessor): this {
    const { queue, type, version } = processor.definition;
    const key = `${queue}\u0000${type}`;
    const versions = this.processors.get(key) ?? new Map<number, JobProcessor>();
    if (versions.has(version)) {
      throw new Error(`A processor for "${type}" v${version} on queue "${queue}" is already registered`);
    }
    versions.set(version, processor);
    this.processors.set(key, versions);
    return this;
  }

  find(queue: string, type: string, version: number): LookupResult {
    const versions = this.processors.get(`${queue}\u0000${type}`);
    if (!versions) return { found: false, reason: 'unknown_type', supportedVersions: [] };
    const processor = versions.get(version);
    if (!processor) {
      return {
        found: false,
        reason: 'unsupported_version',
        supportedVersions: [...versions.keys()].sort((a, b) => a - b),
      };
    }
    return { found: true, processor };
  }

  /** Queues that have at least one processor, i.e. the queues a worker can usefully consume. */
  queues(): QueueName[] {
    return [
      ...new Set(
        [...this.processors.values()].flatMap((v) => [...v.values()].map((p) => p.definition.queue)),
      ),
    ];
  }

  size(): number {
    return [...this.processors.values()].reduce((sum, v) => sum + v.size, 0);
  }
}
