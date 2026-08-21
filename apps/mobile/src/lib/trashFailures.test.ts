/**
 * The trash failure report (Errors_design §4.1, §8's pattern): pure
 * tiers, n = 1 asserted per count, a deliberately unrecognisable
 * platform message proving no text matching, tier 3 always last.
 */
import { describe, expect, it } from 'vitest';
import { describeTrashFailure } from './trashFailures';

describe('describeTrashFailure', () => {
  it('names verified progress first, refusal second, Android last', () => {
    const weird = 'Blorp-77 subsystem anomaly (unrecognisable)';
    const report = describeTrashFailure({
      trashedCount: 3,
      remaining: 5,
      unresolvedCount: 0,
      error: weird,
    });
    expect(report.title).toBe('Partly moved to trash');
    expect(report.body).toContain('3 photos were already moved to trash; 5 remain staged.');
    expect(report.body).toContain('Android refused to move the rest. Your culls remain staged.');
    expect(report.body).toContain(`Android said:\n• ${weird}`);
    expect(report.body.indexOf('already moved')).toBeLessThan(report.body.indexOf('Android said'));
  });

  it('n = 1 progress reads "1 photo was already moved"', () => {
    const report = describeTrashFailure({
      trashedCount: 1,
      remaining: 2,
      unresolvedCount: 0,
    });
    expect(report.body).toContain('1 photo was already moved to trash; 2 remain staged.');
  });

  it('no progress: the honest refusal alone, with its own title', () => {
    const report = describeTrashFailure({ trashedCount: 0, remaining: 4, unresolvedCount: 0 });
    expect(report.title).toBe('Could not move photos to trash');
    expect(report.body).toBe(
      'Android refused to move the photos to trash. Your culls remain staged.',
    );
  });

  it('ambiguity names the unverified count, singular included', () => {
    const report = describeTrashFailure({ trashedCount: 0, remaining: 4, unresolvedCount: 1 });
    expect(report.body).toContain(
      '1 photo could not be verified and may already be in the system trash.',
    );
  });

  it('a blank error prints no empty quote', () => {
    const report = describeTrashFailure({
      trashedCount: 0,
      remaining: 1,
      unresolvedCount: 0,
      error: ' ',
    });
    expect(report.body).not.toContain('Android said');
  });
});
