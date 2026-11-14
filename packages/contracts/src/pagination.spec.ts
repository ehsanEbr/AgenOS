import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
} from './index';

describe('paginationQuerySchema', () => {
  it('applies defaults', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it('coerces query-string values', () => {
    expect(paginationQuerySchema.parse({ limit: '50', offset: '100' })).toEqual({ limit: 50, offset: 100 });
  });

  it.each([
    { limit: '0' },
    { limit: String(MAX_PAGE_SIZE + 1) },
    { limit: '1.5' },
    { offset: '-1' },
    { limit: 'abc' },
  ])('rejects %j', (input) => {
    expect(paginationQuerySchema.safeParse(input).success).toBe(false);
  });
});

describe('paginatedSchema', () => {
  const schema = paginatedSchema(z.object({ id: z.number() }));

  it('describes items plus page info', () => {
    const body = { items: [{ id: 1 }], page: { limit: 20, offset: 0, total: 1 } };
    expect(schema.parse(body)).toEqual(body);
  });

  it('rejects a missing page object', () => {
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('sortQuerySchema', () => {
  const schema = sortQuerySchema(['createdAt', 'name'] as const, [{ field: 'createdAt', direction: 'desc' }]);

  it('uses the default when omitted or empty', () => {
    expect(schema.parse({}).sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    expect(schema.parse({ sort: '' }).sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
  });

  it('parses ascending, descending and multiple fields in order', () => {
    expect(schema.parse({ sort: '-createdAt,name' }).sort).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('rejects fields outside the allowlist and says which are allowed', () => {
    const result = schema.safeParse({ sort: 'password' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('Allowed fields: createdAt, name');
  });

  it('has no default sort unless given', () => {
    expect(sortQuerySchema(['name'] as const).parse({}).sort).toEqual([]);
  });
});
