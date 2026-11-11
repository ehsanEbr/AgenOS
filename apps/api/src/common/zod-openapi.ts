import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';

/**
 * Converts a shared contract schema to a JSON Schema for the OpenAPI document, so the
 * published API docs are generated from the same source of truth that validates requests.
 */
export function zodToOpenApi(schema: z.ZodType, io: 'input' | 'output' = 'output'): SchemaObject {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return jsonSchema as SchemaObject;
}
