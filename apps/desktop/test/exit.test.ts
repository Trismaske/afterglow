import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVE_THRESHOLD_PX, createExitArbiter } from '../src/renderer/exit';

function make(overrides: Partial<Parameters<typeof createExitArbiter>[0]> = {}) {
  const onExit = vi.fn();
  const arbiter = createExitArbiter({ onExit, ...overrides });
  return { arbiter, onExit };
}

describe('exit arbiter', () => {
  it('does nothing until armed', () => {
    const { arbiter, onExit } = make();
    arbiter.keyDown('a');
    arbiter.pointerDown();
    arbiter.pointerMoved(0, 0);
    arbiter.pointerMoved(500, 500);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('exits on keydown when armed', () => {
    const { arbiter, onExit } = make();
    arbiter.arm();
    arbiter.keyDown('Escape');
    expect(onExit).toHaveBeenCalledExactlyOnceWith('key:Escape');
  });

  it('exits on click when armed', () => {
    const { arbiter, onExit } = make();
    arbiter.arm();
    arbiter.pointerDown();
    expect(onExit).toHaveBeenCalledExactlyOnceWith('click');
  });

  it('first mousemove only sets the baseline; small nudges are tolerated', () => {
    const { arbiter, onExit } = make();
    arbiter.arm();
    arbiter.pointerMoved(100, 100); // baseline
    arbiter.pointerMoved(100 + DEFAULT_MOVE_THRESHOLD_PX, 100); // exactly at threshold: no exit
    expect(onExit).not.toHaveBeenCalled();
    arbiter.pointerMoved(100 + DEFAULT_MOVE_THRESHOLD_PX + 1, 100);
    expect(onExit).toHaveBeenCalledExactlyOnceWith('mouse-move');
  });

  it('measures displacement from baseline, not per-event deltas', () => {
    const { arbiter, onExit } = make({ moveThresholdPx: 10 });
    arbiter.arm();
    arbiter.pointerMoved(0, 0);
    for (let x = 1; x <= 10; x++) arbiter.pointerMoved(x, 0); // creep within threshold
    expect(onExit).not.toHaveBeenCalled();
    arbiter.pointerMoved(11, 0);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('fires at most once', () => {
    const { arbiter, onExit } = make();
    arbiter.arm();
    arbiter.keyDown('a');
    arbiter.keyDown('b');
    arbiter.pointerDown();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(arbiter.fired).toBe(true);
  });

  it('disarm resets the baseline and suppresses input (first-run screen)', () => {
    const { arbiter, onExit } = make();
    arbiter.arm();
    arbiter.pointerMoved(0, 0);
    arbiter.disarm();
    arbiter.pointerMoved(500, 500); // would exceed old baseline
    arbiter.pointerDown();
    arbiter.keyDown('Enter');
    expect(onExit).not.toHaveBeenCalled();
    arbiter.arm();
    arbiter.pointerMoved(500, 500); // new baseline after re-arm
    expect(onExit).not.toHaveBeenCalled();
  });

  it('exempt keys pass through without exiting (v0.2 flag keys hook)', () => {
    const { arbiter, onExit } = make({ isExemptKey: (k) => k === 'd' });
    arbiter.arm();
    arbiter.keyDown('d');
    expect(onExit).not.toHaveBeenCalled();
    arbiter.keyDown('x');
    expect(onExit).toHaveBeenCalledExactlyOnceWith('key:x');
  });
});
