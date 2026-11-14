import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { requestContextMiddleware } from './request-context';

@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Express 5 (Nest 11) requires a named wildcard.
    consumer.apply(requestContextMiddleware).forRoutes('{*splat}');
  }
}
