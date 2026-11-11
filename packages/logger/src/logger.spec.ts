import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from './index';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: pino(buildLoggerOptions({ service: 'test', level: 'debug' }), stream) };
}

describe('logger', () => {
  it('tags lines with the service name', () => {
    const { lines, logger } = capture();
    logger.info('hello');
    expect(lines[0]).toMatchObject({ service: 'test', msg: 'hello' });
  });

  it('redacts credentials', () => {
    const { lines, logger } = capture();
    logger.info({ req: { headers: { authorization: 'Bearer abc' } }, conn: { apiKey: 'sk-123' } }, 'x');
    const out = JSON.stringify(lines[0]);
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('sk-123');
    expect(out).toContain('[REDACTED]');
  });
});
