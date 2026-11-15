import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../database';
import { runWithRequestContext } from '../../common/request-context';
import { type AuditEntry, type AuditRepository } from './application/audit-repository';
import { AuditRecorder } from './application/audit-recorder';

const tx = {} as DatabaseClient;

function recorder() {
  const appended: Array<{ entry: AuditEntry; db: DatabaseClient }> = [];
  const repository: AuditRepository = {
    append: vi.fn(async (entry: AuditEntry, db: DatabaseClient) => {
      appended.push({ entry, db });
    }),
  };
  return { recorder: new AuditRecorder(repository), repository, appended };
}

const logout = {
  action: 'auth.logout',
  resourceType: 'session',
  result: 'success',
  metadata: {},
  actorUserId: crypto.randomUUID(),
} as const;

describe('AuditRecorder', () => {
  it('appends through the transaction handle it was given, so the record commits or rolls back with the change', async () => {
    const { recorder: r, appended } = recorder();
    await r.record(logout, tx);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.db).toBe(tx);
  });

  it('gives every entry its own id and the correlation id of the request it was recorded in', async () => {
    const { recorder: r, appended } = recorder();
    await runWithRequestContext({ correlationId: 'corr-123' }, async () => {
      await r.record(logout, tx);
      await r.record(logout, tx);
    });
    await r.record(logout, tx); // outside a request (startup, a job)
    expect(appended[0]?.entry.correlationId).toBe('corr-123');
    expect(appended[2]?.entry.correlationId).toBeNull();
    expect(new Set(appended.map((a) => a.entry.id)).size).toBe(3);
    expect(appended[0]?.entry.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('applies the contract defaults for the optional scope fields', async () => {
    const { recorder: r, appended } = recorder();
    await r.record(logout, tx);
    expect(appended[0]?.entry).toMatchObject({ organizationId: null, projectId: null, resourceId: null });
  });

  it.each([
    ['a token smuggled into the metadata', { ...logout, metadata: { token: 'secret-token-value' } }],
    ['a password smuggled into the metadata', { ...logout, metadata: { password: 'hunter2' } }],
    ['an action that is not in the catalog', { ...logout, action: 'auth.something_else' }],
    [
      'a result that contradicts the action',
      { action: 'auth.login_failed', resourceType: 'user', result: 'success', metadata: {} },
    ],
    [
      'metadata of another action',
      {
        action: 'auth.logout_all',
        resourceType: 'user',
        result: 'success',
        metadata: { delivery: 'cookie' },
      },
    ],
  ])('refuses %s and writes nothing', async (_label, event) => {
    const { recorder: r, repository } = recorder();
    await expect(r.record(event as never, tx)).rejects.toThrow();
    expect(repository.append).not.toHaveBeenCalled();
  });

  it('lets a failure to append propagate, so the surrounding transaction rolls the change back', async () => {
    const repository: AuditRepository = { append: vi.fn().mockRejectedValue(new Error('disk full')) };
    await expect(new AuditRecorder(repository).record(logout, tx)).rejects.toThrow('disk full');
  });
});
