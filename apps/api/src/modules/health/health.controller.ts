import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  type HealthResponse,
  type ReadinessResponse,
  healthResponseSchema,
  readinessResponseSchema,
} from '@agentos/contracts';
import { zodToOpenApi } from '../../common/zod-openapi';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: the API process is running (does not check dependencies)' })
  @ApiResponse({ status: 200, schema: zodToOpenApi(healthResponseSchema) })
  live(): HealthResponse {
    return { status: 'ok', service: 'api', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL and Redis are reachable' })
  @ApiResponse({
    status: 200,
    description: 'All required dependencies are up',
    schema: zodToOpenApi(readinessResponseSchema),
  })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is down (same body shape; see `checks`)',
    schema: zodToOpenApi(readinessResponseSchema),
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.checkReadiness();
    if (result.status !== 'ready') res.status(503);
    return result;
  }
}
