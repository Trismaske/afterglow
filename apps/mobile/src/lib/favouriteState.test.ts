import { describe, expect, it } from 'vitest';
import { isFavouriteSelected, nextFavouriteIntent } from './favouriteState';

describe('favourite intent', () => {
  it('queues apply from none and cancels an unsubmitted apply', () => {
    const queued = nextFavouriteIntent('p1', { state: 'none', target: null });
    expect(queued).toEqual({ assetId: 'p1', state: 'queued_apply', target: true });
    expect(isFavouriteSelected({ state: queued.state, target: queued.target })).toBe(true);
    expect(nextFavouriteIntent('p1', { state: queued.state, target: queued.target })).toEqual({
      assetId: 'p1',
      state: 'none',
      target: null,
    });
  });

  it('queues removal from applied and cancels an unsubmitted removal', () => {
    expect(nextFavouriteIntent('p1', { state: 'applied', target: null })).toEqual({
      assetId: 'p1',
      state: 'queued_remove',
      target: false,
    });
    expect(nextFavouriteIntent('p1', { state: 'queued_remove', target: false })).toEqual({
      assetId: 'p1',
      state: 'applied',
      target: null,
    });
  });

  it('retains the failed target and queues the opposite operation', () => {
    expect(isFavouriteSelected({ state: 'error', target: true })).toBe(true);
    expect(nextFavouriteIntent('p1', { state: 'error', target: true })).toEqual({
      assetId: 'p1',
      state: 'queued_remove',
      target: false,
    });
    expect(nextFavouriteIntent('p1', { state: 'error', target: false })).toEqual({
      assetId: 'p1',
      state: 'queued_apply',
      target: true,
    });
  });
});
