import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  type CreateSystemJobRequest,
  type SystemJob,
  createSystemJobRequestSchema,
  systemJobSchema,
  apiErrorSchema,
} from '@agentos/contracts';
import { type CorrelatedRequest, getCorrelationId } from '../../common/correlation-id.middleware';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { zodToOpenApi } from '../../common/zod-openapi';
import { SystemJobsService } from './system-jobs.service';

/**
 * Phase 1 diagnostics: submit a trivial job and watch it flow API -> BullMQ -> worker -> PostgreSQL.
 * Not a product feature; domain task endpoints arrive with the Agent Runtime phase.
 */
@ApiTags('system')
@Controller('system/jobs')
export class SystemJobsController {
  constructor(private readonly jobs: SystemJobsService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Submit a diagnostic background job' })
  @ApiBody({ schema: zodToOpenApi(createSystemJobRequestSchema, 'input') })
  @ApiResponse({ status: 202, description: 'Job accepted', schema: zodToOpenApi(systemJobSchema) })
  @ApiResponse({ status: 400, schema: zodToOpenApi(apiErrorSchema) })
  @ApiResponse({ status: 503, schema: zodToOpenApi(apiErrorSchema) })
  create(
    @Body(new ZodValidationPipe(createSystemJobRequestSchema)) body: CreateSystemJobRequest,
    @Req() req: CorrelatedRequest,
  ): Promise<SystemJob> {
    return this.jobs.create(body, getCorrelationId(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a diagnostic job' })
  @ApiResponse({ status: 200, schema: zodToOpenApi(systemJobSchema) })
  @ApiResponse({ status: 404, schema: zodToOpenApi(apiErrorSchema) })
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<SystemJob> {
    return this.jobs.get(id);
  }
}
