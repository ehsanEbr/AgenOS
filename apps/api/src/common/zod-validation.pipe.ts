import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from './app-error';

/** A class that carries a Zod schema; use as the declared type of `@Body()`, `@Query()` or `@Param()`. */
export interface ZodDto<T extends z.ZodType = z.ZodType> {
  new (): z.output<T>;
  readonly schema: T;
}

/**
 * Creates a DTO class from a shared contract schema, so the global pipe validates it:
 *
 *   class CreateThingDto extends createZodDto(createThingRequestSchema) {}
 *   create(@Body() body: CreateThingDto) {}
 */
export function createZodDto<T extends z.ZodType>(schema: T): ZodDto<T> {
  class SchemaDto {
    static readonly schema = schema;
  }
  return SchemaDto as unknown as ZodDto<T>;
}

function isZodDto(value: unknown): value is ZodDto {
  return typeof value === 'function' && 'schema' in value;
}

/**
 * Global validation pipe (registered via APP_PIPE). Parameters typed with a ZodDto are validated
 * and replaced by the parsed value; everything else passes through unchanged.
 * Failures are `AppError('validation')` -> HTTP 400 `validation_error` with per-field details.
 */
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!isZodDto(metadata.metatype)) return value;

    const result = metadata.metatype.schema.safeParse(value);
    if (!result.success) {
      throw new AppError('validation', 'validation_error', 'Request validation failed', {
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
