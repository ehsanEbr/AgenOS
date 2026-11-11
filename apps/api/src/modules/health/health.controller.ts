import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  type LivenessResponse,
  type ReadinessResponse,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@agentos/contracts';
import { zodToOpenApi } from '../../common/zod-openapi';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe: the process is running' })
  @ApiResponse({ status: 200, schema: zodToOpenApi(livenessResponseSchema) })
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe: PostgreSQL and Redis are reachable' })
  @ApiResponse({
    status: 200,
    description: 'All dependencies up',
    schema: zodToOpenApi(readinessResponseSchema),
  })
  @ApiResponse({
    status: 503,
    description: 'A dependency is down',
    schema: zodToOpenApi(readinessResponseSchema),
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') res.status(503);
    return result;
  }
}
