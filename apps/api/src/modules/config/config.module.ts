import { Global, Module } from '@nestjs/common';
import { loadApiConfig } from '@agentos/config';

/** DI token for the validated API configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadApiConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
