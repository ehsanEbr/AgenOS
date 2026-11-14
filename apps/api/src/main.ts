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
  // SIGTERM/SIGINT: stop accepting connections and run the module destroy hooks (database, Redis), then exit 0. Nest's own
  // `enableShutdownHooks()` does the same but then re-raises the signal, so the process ends as "killed by SIGTERM" (exit
  // code 143): indistinguishable from a process that never handled the signal, and a "failure" to restart policies. An explicit
  // handler makes a clean shutdown exit 0 and a failed one exit 1. A second signal falls through to Node's default (terminate).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.get(Logger).log(`${signal} received: shutting down`);
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen(config.API_PORT, config.API_HOST);
  app.get(Logger).log(`API listening on http://${config.API_HOST}:${config.API_PORT}/api/v1`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
