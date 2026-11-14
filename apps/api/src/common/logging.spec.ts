import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { correlationIdMiddleware } from './correlation-id.middleware';
import { buildPinoHttpOptions } from './logging';
import { requestContextMiddleware, runWithRequestContext } from './request-context';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, stream };
}

const options = buildPinoHttpOptions({ LOG_LEVEL: 'debug', NODE_ENV: 'test' });

describe('logging configuration (plain pino)', () => {
  it('redacts credentials and tags the service', () => {
    const { lines, stream } = capture();
    pino({ redact: options.redact, base: options.base, level: 'debug' }, stream).info(
      { req: { headers: { authorization: 'Bearer abc' } }, conn: { apiKey: 'sk-123' } },
      'x',
    );
    const out = JSON.stringify(lines[0]);
    expect(out).toContain('"service":"api"');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('sk-123');
    expect(out).toContain('[REDACTED]');
  });

  it('adds the correlation id to every line written inside a request context', () => {
    const { lines, stream } = capture();
    const logger = pino({ mixin: options.mixin as never, base: options.base, level: 'debug' }, stream);

    logger.info('outside');
    runWithRequestContext({ correlationId: 'corr-123' }, () => logger.info('inside'));

    expect(lines[0]).not.toHaveProperty('correlationId');
    expect(lines[1]).toMatchObject({ msg: 'inside', correlationId: 'corr-123' });
  });
});

describe('request logging (pino-http)', () => {
  function appWith(lines: ReturnType<typeof capture>) {
    const app = express();
    app.use(correlationIdMiddleware);
    app.use(requestContextMiddleware); // as RequestContextModule does in the real app
    app.use(pinoHttp(options, lines.stream));
    app.use(express.json());
    app.post('/login', (req, res) => {
      req.log.info('handler log line');
      res.json({ ok: true });
    });
    return app;
  }

  it('never logs bodies, headers or query strings, and always includes the correlation id', async () => {
    const out = capture();
    await request(appWith(out))
      .post('/login?token=query-secret')
      .set('authorization', 'Bearer header-secret')
      .set('cookie', 'session=cookie-secret')
      .set('x-correlation-id', 'corr-42')
      .send({ username: 'ada', password: 'body-secret', apiKey: 'body-key' })
      .expect(200);

    const text = JSON.stringify(out.lines);
    for (const secret of ['query-secret', 'header-secret', 'cookie-secret', 'body-secret', 'body-key']) {
      expect(text).not.toContain(secret);
    }

    const completed = out.lines.find((l) => l.msg === 'request completed');
    expect(completed).toMatchObject({
      correlationId: 'corr-42',
      req: { id: 'corr-42', method: 'POST', path: '/login' },
      res: { statusCode: 200 },
    });
    expect(completed?.req).not.toHaveProperty('headers');
    expect(completed?.req).not.toHaveProperty('query');
  });

  it('does not log health probes', async () => {
    const out = capture();
    const app = express();
    app.use(pinoHttp(options, out.stream));
    app.get('/api/v1/health/ready', (_req, res) => res.json({}));
    await request(app).get('/api/v1/health/ready').expect(200);
    expect(out.lines).toHaveLength(0);
  });
});
