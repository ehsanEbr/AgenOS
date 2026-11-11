import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type HealthResponse, healthResponseSchema } from '@agentos/contracts';
import { zodToOpenApi } from '../../common/zod-openapi';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness: the API process is running' })
  @ApiResponse({ status: 200, schema: zodToOpenApi(healthResponseSchema) })
  get(): HealthResponse {
    return { status: 'ok', service: 'api', uptimeSeconds: Math.round(process.uptime()) };
  }
}
