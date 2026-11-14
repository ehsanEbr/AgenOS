import type { INestApplication } from '@nestjs/common';
import { Body, Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Paginated,
  apiErrorSchema,
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
} from '@agentos/contracts';
import { AppError, type AppErrorKind, HTTP_STATUS_BY_ERROR_KIND } from '../src/common/app-error';
import { ApiStandardErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../src/common/openapi';
import { currentCorrelationId } from '../src/common/request-context';
import { createZodDto } from '../src/common/zod-validation.pipe';
import { createTestApp } from './support/create-test-app';

/*
 * REFERENCE EXAMPLE of the backend conventions (docs/architecture/backend.md), built from a deliberately
 * non-business "number range" so no domain entity is invented:
 *
 *   controller (thin: HTTP <-> application)  ->  application service (rules, throws AppError)
 *
 * The same shapes apply to a real module's presentation / application layers.
 */

// --- contracts (in a real module these live in packages/contracts) ---------------------------------------
const numberSchema = z.object({ value: z.number().int() });
type NumberItem = z.infer<typeof numberSchema>;
const listQuerySchema = paginationQuerySchema.extend(
  sortQuerySchema(['value'] as const, [{ field: 'value', direction: 'asc' }]).shape,
);
const reverseRequestSchema = z.object({ numbers: z.array(z.number().int()).min(1).max(10) });

// --- presentation DTOs -----------------------------------------------------------------------------------
class ListQueryDto extends createZodDto(listQuerySchema) {}
class ReverseDto extends createZodDto(reverseRequestSchema) {}

// --- application service: all decisions live here; no HTTP, no framework types besides DI ---------------
@Injectable()
class NumberRangeService {
  private readonly all: NumberItem[] = Array.from({ length: 45 }, (_, i) => ({ value: i + 1 }));

  list(query: z.output<typeof listQuerySchema>): Paginated<NumberItem> {
    const direction = query.sort[0]?.direction ?? 'asc';
    const sorted = [...this.all].sort((a, b) =>
      direction === 'asc' ? a.value - b.value : b.value - a.value,
    );
    return {
      items: sorted.slice(query.offset, query.offset + query.limit),
      page: { limit: query.limit, offset: query.offset, total: sorted.length },
    };
  }

  reverse(numbers: number[]): number[] {
    if (numbers.includes(13))
      throw new AppError('unprocessable', 'unlucky_number', 'The number 13 is not allowed');
    return [...numbers].reverse();
  }

  find(value: number): NumberItem {
    const found = this.all.find((n) => n.value === value);
    if (!found) throw new AppError('not_found', 'number_not_found', `Number ${value} is not in the range`);
    return found;
  }
}

// --- thin controller: validate (global pipe) -> call service -> return. No branching, no data access. ----
@ApiTags('test-conventions')
@Controller('test-conventions')
class ConventionsController {
  constructor(private readonly numbers: NumberRangeService) {}

  @Get('numbers')
  @ApiOperation({ summary: 'Paginated, sortable list' })
  @ApiZodQuery(listQuerySchema)
  @ApiZodResponse(200, paginatedSchema(numberSchema))
  @ApiStandardErrors(400)
  list(@Query() query: ListQueryDto): Paginated<NumberItem> {
    return this.numbers.list(query);
  }

  @Get('numbers/:value')
  @ApiStandardErrors(404)
  get(@Param('value') value: string): NumberItem {
    return this.numbers.find(Number(value));
  }

  @Post('reverse')
  @ApiZodBody(reverseRequestSchema)
  @ApiStandardErrors(400, 422)
  reverse(@Body() body: ReverseDto): { numbers: number[] } {
    return { numbers: this.numbers.reverse(body.numbers) };
  }

  // --- error classification fixtures ---------------------------------------------------------------
  @Post('fail/app-error/:kind')
  failWithAppError(@Param('kind') kind: AppErrorKind): never {
    throw new AppError(kind, `${kind}_example`, 'An expected failure', { details: { hint: 'safe' } });
  }

  @Get('fail/unexpected')
  failUnexpectedly(): never {
    throw new TypeError('Cannot read properties of undefined (reading "secretToken=abc123")');
  }

  @Get('fail/prisma-unavailable')
  failPrismaUnavailable(): never {
    throw new Prisma.PrismaClientInitializationError(
      "Can't reach database server at postgresql://agentos:hunter2@db.internal:5432/agentos",
      'test',
    );
  }

  @Get('fail/prisma-other')
  failPrismaOther(): never {
    throw new Prisma.PrismaClientKnownRequestError(
      'Invalid `prisma.x.create()` invocation: data: { pw: "hunter2" }',
      {
        code: 'P2002',
        clientVersion: 'test',
      },
    );
  }

  // --- request context fixtures --------------------------------------------------------------------
  @Get('context')
  async context(): Promise<{ ids: (string | undefined)[] }> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const first = currentCorrelationId();
    await sleep(Math.random() * 15);
    const [second, third] = await Promise.all([
      sleep(Math.random() * 15).then(() => currentCorrelationId()),
      Promise.resolve(currentCorrelationId()),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { ids: [first, second, third, currentCorrelationId()] };
  }

  /** Has a JSON body: proves the context survives body parsing, which is where naive middleware loses it. */
  @Post('context-with-body')
  async contextWithBody(@Body() body: ReverseDto): Promise<{ id?: string; count: number }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id: currentCorrelationId(), count: body.numbers.length };
  }
}

describe('backend conventions (e2e reference example)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      controllers: [ConventionsController],
      providers: [NumberRangeService],
    }));
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  describe('pagination and sorting', () => {
    it('uses defaults and returns items with page info', async () => {
      const res = await http().get('/api/v1/test-conventions/numbers').expect(200);
      const body = paginatedSchema(numberSchema).parse(res.body);
      expect(body.items).toHaveLength(20);
      expect(body.items[0]).toEqual({ value: 1 });
      expect(body.page).toEqual({ limit: 20, offset: 0, total: 45 });
    });

    it('honours limit, offset and descending sort', async () => {
      const res = await http()
        .get('/api/v1/test-conventions/numbers?limit=5&offset=10&sort=-value')
        .expect(200);
      expect(res.body.items.map((i: NumberItem) => i.value)).toEqual([35, 34, 33, 32, 31]);
      expect(res.body.page).toEqual({ limit: 5, offset: 10, total: 45 });
    });

    it('rejects out-of-range pagination with per-field details', async () => {
      const res = await http().get('/api/v1/test-conventions/numbers?limit=1000').expect(400);
      const body = apiErrorSchema.parse(res.body);
      expect(body.code).toBe('validation_error');
      expect(JSON.stringify(body.details)).toContain('limit');
    });

    it('rejects sorting by a field outside the allowlist', async () => {
      const res = await http().get('/api/v1/test-conventions/numbers?sort=secret').expect(400);
      expect(JSON.stringify(res.body.details)).toContain('Allowed fields: value');
    });
  });

  describe('error classification and HTTP status conventions', () => {
    const kinds = Object.keys(HTTP_STATUS_BY_ERROR_KIND) as AppErrorKind[];

    it.each(kinds)(
      'AppError kind "%s" becomes its documented status with the standard body',
      async (kind) => {
        const res = await http()
          .post(`/api/v1/test-conventions/fail/app-error/${kind}`)
          .expect(HTTP_STATUS_BY_ERROR_KIND[kind]);
        expect(apiErrorSchema.parse(res.body)).toMatchObject({
          code: `${kind}_example`,
          message: 'An expected failure',
          details: { hint: 'safe' },
        });
        expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
      },
    );

    it('application services signal rule violations (422) and missing data (404) with AppError', async () => {
      const rule = await http()
        .post('/api/v1/test-conventions/reverse')
        .send({ numbers: [1, 13] })
        .expect(422);
      expect(rule.body.code).toBe('unlucky_number');
      const missing = await http().get('/api/v1/test-conventions/numbers/999').expect(404);
      expect(missing.body.code).toBe('number_not_found');
      const ok = await http()
        .post('/api/v1/test-conventions/reverse')
        .send({ numbers: [1, 2, 3] })
        .expect(201);
      expect(ok.body).toEqual({ numbers: [3, 2, 1] });
    });

    it('treats unexpected errors as 500 with a generic body that leaks nothing', async () => {
      const res = await http().get('/api/v1/test-conventions/fail/unexpected').expect(500);
      expect(apiErrorSchema.parse(res.body)).toMatchObject({
        code: 'internal_error',
        message: 'Internal server error',
      });
      expect(JSON.stringify(res.body)).not.toContain('secretToken');
    });

    it('maps an unreachable database to 503 database_unavailable without leaking the connection string', async () => {
      const res = await http().get('/api/v1/test-conventions/fail/prisma-unavailable').expect(503);
      expect(apiErrorSchema.parse(res.body).code).toBe('database_unavailable');
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|db\.internal|postgresql:\/\//);
    });

    it('maps untranslated Prisma errors to a generic 500 without leaking query text', async () => {
      const res = await http().get('/api/v1/test-conventions/fail/prisma-other').expect(500);
      expect(apiErrorSchema.parse(res.body).code).toBe('internal_error');
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
    });
  });

  describe('request context', () => {
    it('keeps the correlation id across awaits, timers and Promise.all', async () => {
      const res = await http()
        .get('/api/v1/test-conventions/context')
        .set('x-correlation-id', 'ctx-1')
        .expect(200);
      expect(res.body.ids).toEqual(['ctx-1', 'ctx-1', 'ctx-1', 'ctx-1']);
    });

    it('keeps the correlation id after the request body has been parsed', async () => {
      const res = await http()
        .post('/api/v1/test-conventions/context-with-body')
        .set('x-correlation-id', 'ctx-body-1')
        .send({ numbers: [1, 2] })
        .expect(201);
      expect(res.body).toEqual({ id: 'ctx-body-1', count: 2 });
    });

    it('never mixes up concurrent requests', async () => {
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          http().get('/api/v1/test-conventions/context').set('x-correlation-id', `concurrent-${i}`),
        ),
      );
      responses.forEach((res, i) => {
        expect(res.body.ids).toEqual(Array(4).fill(`concurrent-${i}`));
      });
    });
  });

  describe('OpenAPI conventions', () => {
    it('documents query parameters, success schema and standard error responses from the contracts', async () => {
      const doc = (await http().get('/api/openapi.json').expect(200)).body;
      const list = doc.paths['/api/v1/test-conventions/numbers'].get;

      const params = Object.fromEntries(list.parameters.map((p: { name: string }) => [p.name, p]));
      expect(Object.keys(params).sort()).toEqual(['limit', 'offset', 'sort']);
      expect(params.limit.schema.maximum).toBe(100);

      expect(list.responses['200'].content['application/json'].schema.properties).toHaveProperty('page');
      expect(list.responses['400'].content['application/json'].schema.properties).toHaveProperty(
        'correlationId',
      );

      const reverse = doc.paths['/api/v1/test-conventions/reverse'].post;
      expect(reverse.requestBody.content['application/json'].schema.properties).toHaveProperty('numbers');
      expect(Object.keys(reverse.responses)).toEqual(expect.arrayContaining(['400', '422']));
    });
  });

  describe('lifecycle', () => {
    it('can be closed twice without error (idempotent shutdown)', async () => {
      const second = await createTestApp();
      await second.app.close();
      await expect(second.app.close()).resolves.toBeUndefined();
    });
  });
});
