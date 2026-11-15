import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { CORRELATION_ID_HEADER } from '@agentos/contracts';
import { correlationIdMiddleware } from '../common/correlation-id.middleware';
import type { ApiConfig } from '../modules/config';

export const API_PREFIX = 'api/v1';

/**
 * Applies HTTP-level configuration that is not expressed as module providers. The pipe and
 * exception filter are registered in AppModule so every test module gets them too.
 * Shared by main.ts and the e2e tests so tests exercise the production pipeline.
 */
export function configureApp(
  app: INestApplication,
  config: Pick<ApiConfig, 'CORS_ORIGINS'> & Partial<Pick<ApiConfig, 'TRUST_PROXY_HOPS'>>,
): void {
  app.useLogger(app.get(Logger));
  // The client address (rate limiting) is only trustworthy if Express knows how many proxies sit in front of the API.
  if (config.TRUST_PROXY_HOPS !== undefined)
    app.getHttpAdapter().getInstance().set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(correlationIdMiddleware);
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: config.CORS_ORIGINS, exposedHeaders: [CORRELATION_ID_HEADER] });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('AgentOS API')
      .setDescription('AgentOS platform API')
      .setVersion('1.0')
      .setOpenAPIVersion('3.1.0')
      .addBearerAuth()
      .addCookieAuth('agentos_session')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
}
