import 'reflect-metadata';
import { Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@agentos/contracts';
import { Public } from '../src/modules/identity';
import { IS_PUBLIC_KEY } from '../src/modules/identity/presentation/decorators';
import { createTestApp } from './support/create-test-app';

/*
 * Default deny, checked on the REAL composition (AppModule with its global guard), with the infrastructure stubbed.
 * The behavior of authentication itself (sessions, cookies, CSRF) is tested against real PostgreSQL and Redis in identity.int.spec.ts.
 */

@Controller('test-protected')
class UnannotatedController {
  @Get()
  read() {
    return { secret: 'only for the signed-in' };
  }

  @Post()
  write() {
    return { written: true };
  }
}

@Public()
@Controller('test-open')
class OpenController {
  @Get()
  read() {
    return { open: true };
  }
}

describe('authentication is the default', () => {
  let app: INestApplication;
  beforeAll(async () => {
    ({ app } = await createTestApp({ controllers: [UnannotatedController, OpenController] }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('protects a route nobody annotated: forgetting @Public() protects instead of exposing', async () => {
    for (const response of [
      await request(app.getHttpServer()).get('/api/v1/test-protected'),
      await request(app.getHttpServer()).post('/api/v1/test-protected').send({}),
    ]) {
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(response.body).code).toBe('unauthenticated');
      expect(JSON.stringify(response.body)).not.toContain('secret');
    }
  });

  it('serves a route that is explicitly @Public(), and still answers 404 for a route that does not exist', async () => {
    await request(app.getHttpServer()).get('/api/v1/test-open').expect(200, { open: true });
    await request(app.getHttpServer()).get('/api/v1/no-such-route').expect(404);
  });

  it('lets the health probes through without credentials', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
  });

  it('exposes exactly the routes on the public allowlist: a new unauthenticated route is a deliberate, reviewed change', () => {
    const controllers = [...app.get(ModulesContainer).values()].flatMap((module) => [
      ...module.controllers.values(),
    ]);
    const reflector = app.get(Reflector);
    const verb = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

    const publicRoutes: string[] = [];
    const protectedRoutes: string[] = [];
    for (const wrapper of controllers) {
      const type = wrapper.metatype;
      if (!type || !wrapper.instance) continue;
      if (type === UnannotatedController || type === OpenController) continue; // this file's own fixtures
      const prefix = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      const prototype = Object.getPrototypeOf(wrapper.instance) as Record<
        string,
        (...args: never[]) => unknown
      >;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue; // not a route handler
        const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const route = `${verb[method]} /${[prefix, path].filter((p) => p && p !== '/').join('/')}`;
        const isPublic =
          reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [handler, type]) === true;
        (isPublic ? publicRoutes : protectedRoutes).push(route);
      }
    }
    expect(publicRoutes.sort()).toEqual([
      'GET /health',
      'GET /health/ready',
      'POST /auth/login',
      'POST /auth/register',
    ]);
    // Everything else is authenticated by the global guard. (What each organization route additionally requires is pinned, route by
    // route, in route-metadata.e2e.spec.ts.)
    expect(protectedRoutes.sort()).toEqual(
      [
        'DELETE /organizations/:organizationId/members/:userId',
        'GET /me',
        'GET /organizations',
        'GET /organizations/:organizationId',
        'GET /organizations/:organizationId/members',
        'GET /projects',
        'GET /projects/:projectId',
        'PATCH /organizations/:organizationId',
        'PATCH /organizations/:organizationId/members/:userId',
        'POST /auth/logout',
        'POST /auth/logout-all',
        'POST /me/password',
        'POST /organizations',
        'PATCH /projects/:projectId',
        'POST /organizations/:organizationId/members',
        'POST /projects',
        'POST /projects/:projectId/archive',
        'POST /projects/:projectId/restore',
      ].sort(),
    );
  });
});
