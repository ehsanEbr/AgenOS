import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import type { ApiConfig } from '@agentos/config';
import { CORRELATION_ID_HEADER } from '@agentos/contracts';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { correlationIdMiddleware } from '../common/correlation-id.middleware';

export const API_PREFIX = 'api/v1';

/**
 * Applies all cross-cutting HTTP configuration. Shared by main.ts and the integration tests
 * so tests exercise the same pipeline as production.
 */
export function configureApp(app: INestApplication, config: Pick<ApiConfig, 'CORS_ORIGINS'>): void {
  app.useLogger(app.get(Logger));
  app.use(correlationIdMiddleware);
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: config.CORS_ORIGINS,
    exposedHeaders: [CORRELATION_ID_HEADER],
  });
  app.useGlobalFilters(new AllExceptionsFilter());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('AgentOS API')
      .setDescription('AgentOS platform API')
      .setVersion('1.0')
      .setOpenAPIVersion('3.1.0')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
}
