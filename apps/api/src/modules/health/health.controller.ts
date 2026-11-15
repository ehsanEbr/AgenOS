import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  type HealthResponse,
  type ReadinessResponse,
  healthResponseSchema,
  readinessResponseSchema,
} from '@agentos/contracts';
import { ApiZodResponse } from '../../common/openapi';
import { Public } from '../identity';
import { HealthService } from './health.service';

/** Reference example of a thin controller: no logic beyond translating the service result to HTTP. */
/** Liveness and readiness are public: orchestrators and load balancers call them without credentials. */
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: the API process is running (does not check dependencies)' })
  @ApiZodResponse(200, healthResponseSchema)
  live(): HealthResponse {
    return { status: 'ok', service: 'api', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL and Redis are reachable' })
  @ApiZodResponse(200, readinessResponseSchema, 'All required dependencies are up')
  @ApiZodResponse(
    503,
    readinessResponseSchema,
    'A required dependency is down (same body shape; see `checks`)',
  )
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.checkReadiness();
    if (result.status !== 'ready') res.status(503);
    return result;
  }
}
