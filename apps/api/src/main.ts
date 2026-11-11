import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { APP_CONFIG, type ApiConfig } from './modules/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<ApiConfig>(APP_CONFIG);

  configureApp(app, config);
  // SIGTERM/SIGINT run module destroy hooks and stop accepting connections before exit.
  app.enableShutdownHooks();

  await app.listen(config.API_PORT, config.API_HOST);
  app.get(Logger).log(`API listening on http://${config.API_HOST}:${config.API_PORT}/api/v1`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
