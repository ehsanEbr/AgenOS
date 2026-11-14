import { z } from 'zod';

/** Largest page a client may request. Keeps list endpoints bounded. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Query parameters for list endpoints: `?limit=20&offset=40`.
 * Query strings arrive as text, hence `coerce`.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Position of a page inside the full result set. */
export const pageInfoSchema = z.object({
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

/** Response body for list endpoints: `{ items: [...], page: { limit, offset, total } }`. */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), page: pageInfoSchema });
}
export type Paginated<T> = { items: T[]; page: PageInfo };

export type SortDirection = 'asc' | 'desc';
export interface SortField<F extends string = string> {
  field: F;
  direction: SortDirection;
}

/**
 * Sorting query parameter: `?sort=-createdAt,name` (comma-separated, `-` prefix means descending).
 * Only fields in the allowlist are accepted, so clients cannot sort by arbitrary columns.
 * The parsed value is an ordered list of `{ field, direction }`; omitted means `defaultSort`.
 */
export function sortQuerySchema<const F extends readonly [string, ...string[]]>(
  allowedFields: F,
  defaultSort: SortField<F[number]>[] = [],
) {
  const allowed = new Set<string>(allowedFields);
  return z.object({
    sort: z
      .string()
      .optional()
      .transform((value, ctx): SortField<F[number]>[] => {
        if (value === undefined || value === '') return defaultSort;
        const parsed: SortField<F[number]>[] = [];
        for (const part of value.split(',')) {
          const direction: SortDirection = part.startsWith('-') ? 'desc' : 'asc';
          const field = part.replace(/^[-+]/, '');
          if (!allowed.has(field)) {
            ctx.addIssue({
              code: 'custom',
              message: `Cannot sort by "${field}". Allowed fields: ${allowedFields.join(', ')}`,
            });
            return z.NEVER;
          }
          parsed.push({ field: field as F[number], direction });
        }
        return parsed;
      }),
  });
}
