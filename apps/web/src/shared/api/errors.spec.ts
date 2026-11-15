import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  type ApiErrorKind,
  MAX_RETRIES,
  categorizeError,
  isAbortError,
  isRetryableError,
  retryDelay,
  shouldRetry,
} from './errors';

const http = (status: number) =>
  new ApiClientError({ kind: 'http', message: 'x', status, code: 'some_code' });
const kind = (k: ApiErrorKind) => new ApiClientError({ kind: k, message: 'x', code: 'c' });

describe('categorizeError', () => {
  it.each([
    [kind('network'), 'network'],
    [kind('timeout'), 'timeout'],
    [kind('invalid_response'), 'invalid_response'],
    [http(400), 'validation'],
    [http(422), 'validation'],
    [http(401), 'unauthenticated'],
    [http(403), 'forbidden'],
    [http(404), 'not_found'],
    [http(409), 'conflict'],
    [http(429), 'rate_limited'],
    [http(502), 'unavailable'],
    [http(503), 'unavailable'],
    [http(504), 'unavailable'],
    [http(500), 'server'],
    [http(418), 'unknown'],
    [new Error('boom'), 'unknown'],
    ['a string', 'unknown'],
  ])('%j -> %s', (error, category) => {
    expect(categorizeError(error)).toBe(category);
  });
});

describe('isRetryableError', () => {
  it.each([kind('network'), kind('timeout'), http(502), http(503), http(504), http(408)])(
    'retries recoverable failures (%j)',
    (error) => expect(isRetryableError(error)).toBe(true),
  );

  it.each([
    http(400),
    http(401),
    http(403),
    http(404),
    http(409),
    http(422),
    http(429),
    http(500),
    kind('invalid_response'),
  ])('never retries failures that repetition cannot fix (%j)', (error) =>
    expect(isRetryableError(error)).toBe(false),
  );

  it('does not retry cancellations or unknown errors', () => {
    expect(isRetryableError(new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(isRetryableError(new Error('boom'))).toBe(false);
  });
});

describe('shouldRetry / retryDelay', () => {
  it('stops after the maximum number of retries', () => {
    expect(shouldRetry(0, kind('network'))).toBe(true);
    expect(shouldRetry(MAX_RETRIES - 1, kind('network'))).toBe(true);
    expect(shouldRetry(MAX_RETRIES, kind('network'))).toBe(false);
  });

  it('backs off exponentially up to a ceiling', () => {
    expect([0, 1, 2, 3, 4, 10].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });
});

describe('isAbortError', () => {
  it('recognises only deliberate aborts', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new DOMException('Timed out', 'TimeoutError'))).toBe(false);
    expect(isAbortError(kind('network'))).toBe(false);
  });
});
