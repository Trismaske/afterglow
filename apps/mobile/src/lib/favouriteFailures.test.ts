/**
 * The favourite failure classifier (Errors_design §4.2/D4, §8's testing
 * pattern from organizeFailures.test.ts): pure tiers, singular AND
 * plural asserted for BOTH counts, a deliberately unrecognisable
 * platform message proving no text matching, and tier 3 always after
 * tier 1.
 */
import { describe, expect, it } from 'vitest';
import { describeFavouriteFailure, VERIFY_SENTINEL } from './favouriteFailures';

describe('describeFavouriteFailure', () => {
  it('tier 1: the partial-success counts, plural/plural', () => {
    const report = describeFavouriteFailure({
      batchSize: 5,
      unverifiedCount: 2,
      favourite: true,
      error: VERIFY_SENTINEL,
    });
    expect(report.title).toBe('Partly applied — 2 photos unconfirmed');
    expect(report.body).toContain('3 favourites were applied; Android did not confirm 2 photos.');
    expect(report.body).toContain('The unconfirmed ones stay queued and retry on the next apply.');
  });

  it('tier 1 singular APPLIED count: "1 favourite was applied"', () => {
    const report = describeFavouriteFailure({
      batchSize: 3,
      unverifiedCount: 2,
      favourite: true,
      error: VERIFY_SENTINEL,
    });
    expect(report.body).toContain('1 favourite was applied; Android did not confirm 2 photos.');
  });

  it('tier 1 singular UNCONFIRMED count: "did not confirm 1 photo", and it "retries"', () => {
    const report = describeFavouriteFailure({
      batchSize: 4,
      unverifiedCount: 1,
      favourite: true,
      error: VERIFY_SENTINEL,
    });
    expect(report.title).toBe('Partly applied — 1 photo unconfirmed');
    expect(report.body).toContain('3 favourites were applied; Android did not confirm 1 photo.');
    expect(report.body).toContain(
      'The unconfirmed one stays queued and retries on the next apply.',
    );
  });

  it('a REMOVAL batch names the operation', () => {
    const report = describeFavouriteFailure({
      batchSize: 2,
      unverifiedCount: 1,
      favourite: false,
      error: VERIFY_SENTINEL,
    });
    expect(report.body).toContain('1 favourite removal was applied');
  });

  it('tier 2 when nothing confirmed — honest, no invented cause', () => {
    const report = describeFavouriteFailure({
      batchSize: 3,
      unverifiedCount: 3,
      favourite: true,
      error: VERIFY_SENTINEL,
    });
    expect(report.title).toBe('Favourite changes need retry');
    expect(report.body).toContain('Android did not confirm any of the 3 favourite changes.');
    expect(report.body).not.toContain('were applied');
  });

  it('tier 3 quotes a DELIBERATELY UNRECOGNISABLE platform message verbatim, after tier 1', () => {
    // §8's pattern: this message matches no rule anywhere — the tiers
    // above it must come from OUR facts, and it must still print.
    const weird = 'XyZZy quantum flux error 0xDEAD (unrecognisable)';
    const report = describeFavouriteFailure({
      batchSize: 2,
      unverifiedCount: 1,
      favourite: true,
      error: weird,
    });
    expect(report.body).toContain(`Android said:\n• ${weird}`);
    // Tier 3 AFTER tier 1: the ground truth never displaces the counts.
    expect(report.body.indexOf('was applied')).toBeLessThan(report.body.indexOf('Android said'));
  });

  it("our own verify sentinel is never quoted as Android's words", () => {
    const report = describeFavouriteFailure({
      batchSize: 2,
      unverifiedCount: 2,
      favourite: true,
      error: VERIFY_SENTINEL,
    });
    expect(report.body).not.toContain('Android said');
  });

  it('a blank error prints no empty quote', () => {
    const report = describeFavouriteFailure({
      batchSize: 2,
      unverifiedCount: 2,
      favourite: true,
      error: '  ',
    });
    expect(report.body).not.toContain('Android said');
  });
});
