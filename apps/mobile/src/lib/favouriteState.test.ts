import { describe, expect, it } from 'vitest';
import {
  favouriteBadgeWeight,
  isFavouriteSelected,
  nextFavouriteIntent,
  shouldOfferFavouriteHandoff,
  type FavouriteStatus,
} from './favouriteState';

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

describe('shouldOfferFavouriteHandoff (m0.7 item F, #10)', () => {
  it('never offers for an already-favourited photo (applied or queued)', () => {
    expect(shouldOfferFavouriteHandoff({ state: 'applied', target: null })).toBe(false);
    expect(shouldOfferFavouriteHandoff({ state: 'queued_apply', target: true })).toBe(false);
    expect(shouldOfferFavouriteHandoff({ state: 'error', target: true })).toBe(false);
  });

  it('offers only when the photo reads as not favourited', () => {
    expect(shouldOfferFavouriteHandoff({ state: 'none', target: null })).toBe(true);
    expect(shouldOfferFavouriteHandoff({ state: 'queued_remove', target: false })).toBe(true);
    expect(shouldOfferFavouriteHandoff({ state: 'error', target: false })).toBe(true);
  });
});

describe('applied direction (v18)', () => {
  it('a VERIFIED removal is not a filled heart', () => {
    // The action model records a removal as an applied row whose target
    // is false. Reading only `state === 'applied'` left the heart filled
    // on a photo the gallery had just un-favourited, so the next tap
    // queued a SECOND removal instead of an apply.
    const removed: FavouriteStatus = { state: 'applied', target: false };
    expect(isFavouriteSelected(removed)).toBe(false);
    expect(nextFavouriteIntent('p1', removed)).toEqual({
      assetId: 'p1',
      state: 'queued_apply',
      target: true,
    });
  });

  it('a verified add stays filled, and an unknown direction is given the benefit of the doubt', () => {
    expect(isFavouriteSelected({ state: 'applied', target: true })).toBe(true);
    expect(isFavouriteSelected({ state: 'applied', target: null })).toBe(true);
  });
});

describe('badge weight (m0.8.2)', () => {
  it('is live while an apply waits, and carried once it stands', () => {
    expect(favouriteBadgeWeight({ state: 'queued_apply', target: true })).toBe('live');
    expect(favouriteBadgeWeight({ state: 'applied', target: true })).toBe('carried');
    // No direction ever recorded keeps the same benefit of the doubt
    // isFavouriteSelected gives it.
    expect(favouriteBadgeWeight({ state: 'applied', target: null })).toBe('carried');
  });

  it('a QUEUED removal shows the heart-off badge; a verified one shows nothing', () => {
    // Grilling Q5 (Tristan): three states must read apart — queued
    // apply (heart, live), applied (heart, carried), queued removal
    // (heart-off, live). Only a VERIFIED removal drops the badge.
    expect(favouriteBadgeWeight({ state: 'queued_remove', target: false })).toBe('removing');
    expect(favouriteBadgeWeight({ state: 'applied', target: false })).toBeNull();
    expect(favouriteBadgeWeight({ state: 'none', target: null })).toBeNull();
  });

  it('retryable failures keep their direction: apply stays live, removal stays removing', () => {
    expect(favouriteBadgeWeight({ state: 'error', target: true })).toBe('live');
    expect(favouriteBadgeWeight({ state: 'error', target: false })).toBe('removing');
  });
});
