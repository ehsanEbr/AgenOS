import { Prisma } from '@prisma/client';

/*
 * Framework-free helpers for classifying Prisma failures. Repositories use the specific predicates to translate
 * a database outcome into a meaningful AppError (for example a unique violation into `agent_name_taken`).
 * Anything a repository does not translate is handled generically by DatabaseExceptionFilter.
 */

/** Prisma error codes AgentOS reacts to. https://www.prisma.io/docs/orm/reference/error-reference */
export const PrismaErrorCode = {
  UniqueConstraintViolation: 'P2002',
  ForeignKeyViolation: 'P2003',
  RecordNotFound: 'P2025',
  TransactionConflict: 'P2034', // write conflict / deadlock: the whole transaction may be retried
} as const;

/** Codes meaning "could not talk to the database right now". Retrying later may succeed. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'P1001', // can't reach server
  'P1002', // server reached but timed out
  'P1008', // operation timed out
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
]);

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export const isUniqueConstraintViolation = (error: unknown) =>
  hasCode(error, PrismaErrorCode.UniqueConstraintViolation);
export const isForeignKeyViolation = (error: unknown) => hasCode(error, PrismaErrorCode.ForeignKeyViolation);
export const isRecordNotFound = (error: unknown) => hasCode(error, PrismaErrorCode.RecordNotFound);
export const isTransactionConflict = (error: unknown) => hasCode(error, PrismaErrorCode.TransactionConflict);

/** True for connection-level failures (database down, unreachable, closed or pool exhausted). */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  return error instanceof Prisma.PrismaClientKnownRequestError && UNAVAILABLE_CODES.has(error.code);
}

/** Every error class the Prisma Client can throw. */
export const PRISMA_ERROR_CLASSES = [
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientRustPanicError,
] as const;
