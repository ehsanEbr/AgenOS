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

  it('redacts the credentials authentication code handles, whatever name they travel under', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        body: { currentPassword: 'old-pw-1', newPassword: 'new-pw-2', password: 'pw-3' },
        user: { passwordHash: '$scrypt$v=1$secret-hash' },
        auth: { sessionToken: 'session-tok-4', credential: 'cred-5' },
        res: { headers: { 'set-cookie': ['agentos_session=cookie-secret-6'] } },
        req: { headers: { cookie: 'agentos_session=cookie-secret-7' } },
      },
      'x',
    );
    const out = JSON.stringify(lines[0]);
    for (const secret of [
      'old-pw-1',
      'new-pw-2',
      'pw-3',
      'secret-hash',
      'session-tok-4',
      'cred-5',
      'cookie-secret-6',
      'cookie-secret-7',
    ])
      expect(out).not.toContain(secret);
  });

  it('exposes the redaction paths for processes that build their own pino options', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });

  it('creates a usable logger', () => {
    expect(typeof createLogger({ service: 'x', level: 'silent' }).info).toBe('function');
  });
});
