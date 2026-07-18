import { describe, expect, it, vi } from 'vitest';
import { FifoPersistenceQueue } from './persistenceQueue';

describe('FifoPersistenceQueue', () => {
  it('retains a failed head and commits later jobs in order after retry', async () => {
    let fail = true;
    const committed: Array<{ job: string; before: string }> = [];
    const errors: unknown[] = [];
    const queue = new FifoPersistenceQueue(
      'unreviewed',
      async (job: string, before) => {
        committed.push({ job, before });
        if (fail) throw new Error('disk full');
        return job;
      },
      (error) => errors.push(error),
    );

    const keep = queue.enqueue('kept');
    const cull = queue.enqueue('culled');
    await vi.waitFor(() => expect(queue.pendingCount).toBe(2));
    expect(committed).toEqual([{ job: 'kept', before: 'unreviewed' }]);
    expect(errors.at(-1)).toBeInstanceOf(Error);

    fail = false;
    queue.retry();
    await Promise.all([keep, cull, queue.waitForIdle()]);
    expect(committed).toEqual([
      { job: 'kept', before: 'unreviewed' },
      { job: 'kept', before: 'unreviewed' },
      { job: 'culled', before: 'kept' },
    ]);
    expect(queue.pendingCount).toBe(0);
    expect(errors.at(-1)).toBeNull();
  });

  it('retains captured job metadata across a failed compare write', async () => {
    let attempts = 0;
    const seen: Array<{ snapshot: string; duel: string }> = [];
    const queue = new FifoPersistenceQueue(
      0,
      async (job: { snapshot: string; duel: string }) => {
        seen.push(job);
        if (attempts++ === 0) throw new Error('injected');
        return 1;
      },
      () => {},
    );
    const done = queue.enqueue({ snapshot: 'captured', duel: 'winner:p1' });
    await vi.waitFor(() => expect(queue.pendingCount).toBe(1));
    queue.retry();
    await done;
    expect(seen).toEqual([
      { snapshot: 'captured', duel: 'winner:p1' },
      { snapshot: 'captured', duel: 'winner:p1' },
    ]);
  });

  it('prevents a session-state reset while a write is pending', async () => {
    let release!: () => void;
    const queue = new FifoPersistenceQueue(
      0,
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 1;
      },
      () => {},
    );
    const write = queue.enqueue('job');
    expect(() => queue.resetCommitted(5)).toThrow(/writes are pending/);
    release();
    await write;
    queue.resetCommitted(5);
  });
});
