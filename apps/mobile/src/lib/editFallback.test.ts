import { describe, expect, it, vi } from 'vitest';
import {
  ACTION_EDIT,
  ACTION_VIEW,
  launchWithViewerFallback,
  NO_EDITOR_MESSAGE,
} from './editFallback';

describe('launchWithViewerFallback', () => {
  it("returns 'returned' when ACTION_EDIT launches, without trying the viewer", async () => {
    const launch = vi.fn().mockResolvedValue(undefined);
    const onViewer = vi.fn();
    await expect(launchWithViewerFallback(launch, onViewer)).resolves.toBe('returned');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(ACTION_EDIT);
    expect(onViewer).not.toHaveBeenCalled();
  });

  it("falls back to ACTION_VIEW when ACTION_EDIT rejects → 'viewer'", async () => {
    const launch = vi.fn(async (action: string) => {
      if (action === ACTION_EDIT) throw new Error('no activity');
    });
    const onViewer = vi.fn();
    await expect(launchWithViewerFallback(launch, onViewer)).resolves.toBe('viewer');
    expect(launch.mock.calls.map(([a]) => a)).toEqual([ACTION_EDIT, ACTION_VIEW]);
    expect(onViewer).toHaveBeenCalledTimes(1);
  });

  it("returns 'failed' only when BOTH intents reject", async () => {
    const launch = vi.fn().mockRejectedValue(new Error('no activity'));
    await expect(launchWithViewerFallback(launch)).resolves.toBe('failed');
    expect(launch.mock.calls.map(([a]) => a)).toEqual([ACTION_EDIT, ACTION_VIEW]);
  });

  it('fires the viewer toast before the viewer round-trip resolves', async () => {
    const order: string[] = [];
    let resolveView!: () => void;
    const launch = vi.fn((action: string) => {
      if (action === ACTION_EDIT) return Promise.reject(new Error('no activity'));
      return new Promise<void>((resolve) => {
        resolveView = () => {
          order.push('view-returned');
          resolve();
        };
      });
    });
    const outcome = launchWithViewerFallback(launch, () => order.push('toast'));
    await Promise.resolve(); // let the EDIT rejection settle
    await Promise.resolve();
    expect(order).toEqual(['toast']); // toast fired while the viewer is open
    resolveView();
    await expect(outcome).resolves.toBe('viewer');
    expect(order).toEqual(['toast', 'view-returned']);
  });

  it('works without an onViewerLaunch callback', async () => {
    const launch = vi.fn(async (action: string) => {
      if (action === ACTION_EDIT) throw new Error('no activity');
    });
    await expect(launchWithViewerFallback(launch)).resolves.toBe('viewer');
  });

  it('error copy no longer tells the user to "enable" anything', () => {
    expect(NO_EDITOR_MESSAGE.toLowerCase()).not.toContain('enable');
  });
});
