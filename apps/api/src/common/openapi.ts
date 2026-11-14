import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { apiErrorSchema } from '@agentos/contracts';
import { zodToOpenApi } from './zod-openapi';

/**
 * OpenAPI decorators driven by the shared Zod contracts, so the published documentation is generated from the
 * same schemas that validate requests. Prefer these over hand-written `@ApiBody({ schema: ... })` objects.
 */

/** Documents the JSON request body. */
export const ApiZodBody = (schema: z.ZodType) => ApiBody({ schema: zodToOpenApi(schema, 'input') });

/** Documents a success response (or any response) with a contract schema. */
export const ApiZodResponse = (status: number, schema: z.ZodType, description?: string) =>
  ApiResponse({ status, description, schema: zodToOpenApi(schema) });

/** Documents each property of an object schema as a query parameter (pagination, filters, sorting). */
export function ApiZodQuery(schema: z.ZodObject) {
  const json = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) =>
      ApiQuery({ name, required: required.has(name), schema: property as never }),
    ),
  );
}

const STANDARD_ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation error',
  401: 'Not authenticated',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  422: 'Rejected by a business rule',
  429: 'Too many requests',
  503: 'A required dependency is unavailable',
};

/** Documents error responses using the standard `ApiError` body. Unexpected 500s are implied and not listed. */
export const ApiStandardErrors = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: STANDARD_ERROR_DESCRIPTIONS[status] ?? 'Error',
        schema: zodToOpenApi(apiErrorSchema),
      }),
    ),
  );
