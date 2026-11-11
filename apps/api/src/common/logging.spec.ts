import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildPinoHttpOptions } from './logging';

describe('logging', () => {
  it('redacts credentials and tags the service', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const { redact, base, level } = buildPinoHttpOptions({ LOG_LEVEL: 'debug', NODE_ENV: 'test' });
    pino({ redact, base, level }, stream).info(
      { req: { headers: { authorization: 'Bearer abc' } }, conn: { apiKey: 'sk-123' } },
      'x',
    );

    expect(lines[0]).toContain('"service":"api"');
    expect(lines[0]).not.toContain('Bearer abc');
    expect(lines[0]).not.toContain('sk-123');
    expect(lines[0]).toContain('[REDACTED]');
  });
});
