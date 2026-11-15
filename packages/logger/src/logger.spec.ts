import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, baseLoggerOptions, createLogger } from './index';

function capture(service = 'test') {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: pino(baseLoggerOptions({ service, level: 'debug' }), stream) };
}

describe('logger conventions', () => {
  it('tags every line with the service name', () => {
    const { lines, logger } = capture('worker');
    logger.info('hello');
    expect(lines[0]).toMatchObject({ service: 'worker', msg: 'hello' });
  });

  it('redacts credentials in nested objects', () => {
    const { lines, logger } = capture();
    logger.info(
      { req: { headers: { authorization: 'Bearer abc' } }, conn: { apiKey: 'sk-123', token: 't0k' } },
      'x',
    );
    const out = JSON.stringify(lines[0]);
    for (const secret of ['Bearer abc', 'sk-123', 't0k']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('exposes the redaction paths for processes that build their own pino options', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });

  it('creates a usable logger', () => {
    expect(typeof createLogger({ service: 'x', level: 'silent' }).info).toBe('function');
  });
});
