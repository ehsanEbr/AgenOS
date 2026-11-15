// Public interface of the worker runtime: everything a worker process (and its processors) may use.
// The runtime knows no job and no domain. It must never import from ../processors.
export {
  type FailureClass,
  type FailureReason,
  JobFailure,
  type JobLike,
  type StuckHandlerInfo,
  DEFAULT_ABORT_GRACE_MS,
  createDispatcher,
} from './dispatch';
export {
  StartupError,
  WorkerHost,
  type HostStatus,
  type ShutdownResult,
  type WorkerHostOptions,
} from './host';
export { IllegalTransitionError, Lifecycle, type HostState } from './lifecycle';
export {
  PermanentJobError,
  abortableDelay,
  defineProcessor,
  type JobContext,
  type JobHandler,
  type JobProcessor,
} from './processor';
export { ProcessorRegistry, type LookupResult } from './registry';
