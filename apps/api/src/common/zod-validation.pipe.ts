import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates input against a shared contract schema and returns the parsed (typed) value. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'validation_error',
        message: 'Request validation failed',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
