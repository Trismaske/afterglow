/** Write-priority gate (m0.8): user writes release the scan's yields. */
import { describe, expect, it } from 'vitest';
import { userWritesActive, waitForUserWrites, withUserWritePriority } from './writePriority';

describe('write priority', () => {
  it('is a no-op when no user write is active', async () => {
    expect(userWritesActive()).toBe(0);
    await waitForUserWrites(); // resolves immediately
  });

  it('scan yields wait for the active user write, then release', async () => {
    let userDone: () => void = () => {};
    const userWrite = withUserWritePriority(
      () => new Promise<void>((resolve) => (userDone = resolve)),
    );
    expect(userWritesActive()).toBe(1);
    let released = false;
    const scanYield = waitForUserWrites().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false); // gated while the write runs
    userDone();
    await userWrite;
    await scanYield;
    expect(released).toBe(true);
    expect(userWritesActive()).toBe(0);
  });

  it('releases even when the user write rejects', async () => {
    await expect(withUserWritePriority(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(userWritesActive()).toBe(0);
    await waitForUserWrites();
  });

  it('overlapping user writes gate until the LAST one ends', async () => {
    let doneA: () => void = () => {};
    let doneB: () => void = () => {};
    const a = withUserWritePriority(() => new Promise<void>((r) => (doneA = r)));
    const b = withUserWritePriority(() => new Promise<void>((r) => (doneB = r)));
    let released = false;
    const gate = waitForUserWrites().then(() => {
      released = true;
    });
    doneA();
    await a;
    await Promise.resolve();
    expect(released).toBe(false); // B still active
    doneB();
    await b;
    await gate;
    expect(released).toBe(true);
  });
});
