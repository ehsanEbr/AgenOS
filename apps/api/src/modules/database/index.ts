// Public surface of the database module. Everything not exported here is private to the module.
export { DatabaseExceptionFilter } from './database-exception.filter';
export { DatabaseModule } from './database.module';
export { PrismaService } from './prisma.service';
export {
  PrismaErrorCode,
  isDatabaseUnavailable,
  isForeignKeyViolation,
  isRecordNotFound,
  isTransactionConflict,
  isUniqueConstraintViolation,
} from './prisma-errors';
export { TransactionRunner } from './transaction-runner';
export {
  DEFAULT_TRANSACTION_OPTIONS,
  TransactionIsolationLevel,
  type DatabaseClient,
  type TransactionOptions,
} from './transaction';
