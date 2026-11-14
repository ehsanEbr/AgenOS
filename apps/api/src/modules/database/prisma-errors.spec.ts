import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  PRISMA_ERROR_CLASSES,
  PrismaErrorCode,
  isDatabaseUnavailable,
  isForeignKeyViolation,
  isRecordNotFound,
  isTransactionConflict,
  isUniqueConstraintViolation,
} from './prisma-errors';

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });

describe('prisma error classification', () => {
  it('recognises specific outcomes by Prisma code', () => {
    expect(isUniqueConstraintViolation(known('P2002'))).toBe(true);
    expect(isForeignKeyViolation(known('P2003'))).toBe(true);
    expect(isRecordNotFound(known('P2025'))).toBe(true);
    expect(isTransactionConflict(known('P2034'))).toBe(true);
    expect(PrismaErrorCode.UniqueConstraintViolation).toBe('P2002');
  });

  it('does not confuse codes or non-Prisma errors', () => {
    expect(isUniqueConstraintViolation(known('P2025'))).toBe(false);
    expect(isUniqueConstraintViolation(new Error('P2002'))).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
  });

  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])('treats %s as database unavailable', (code) => {
    expect(isDatabaseUnavailable(known(code))).toBe(true);
  });

  it('treats initialization errors as database unavailable', () => {
    expect(
      isDatabaseUnavailable(new Prisma.PrismaClientInitializationError("Can't reach database", 'test')),
    ).toBe(true);
  });

  it('does not treat data-level failures as unavailability', () => {
    expect(isDatabaseUnavailable(known('P2002'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('boom'))).toBe(false);
  });

  it('lists every Prisma error class for the exception filter', () => {
    expect(PRISMA_ERROR_CLASSES).toHaveLength(5);
  });
});
