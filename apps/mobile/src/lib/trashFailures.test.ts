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

  it("a PREPARE failure is ours: Android was never asked, and its words are never quoted as Android's", () => {
    // The stage is our own pipeline fact (codex m0.8.7 r1) — an
    // Afterglow preparation error must not wear Android's name.
    const report = describeTrashFailure({
      trashedCount: 0,
      remaining: 3,
      unresolvedCount: 0,
      stage: 'prepare',
      error: 'SQLITE_BUSY: database is locked',
    });
    expect(report.body).toContain('Android was never asked');
    expect(report.body).not.toContain('Android refused');
    expect(report.body).not.toContain('Android said');
    expect(report.body).toContain('Details:\n• SQLITE_BUSY: database is locked');
  });

  it('a BOOKKEEPING failure says the recording failed, not that Android refused', () => {
    const report = describeTrashFailure({
      trashedCount: 2,
      remaining: 1,
      unresolvedCount: 1,
      stage: 'bookkeeping',
      error: 'disk I/O error',
    });
    expect(report.body).toContain('could not record the outcome');
    expect(report.body).not.toContain('Android refused');
    expect(report.body).not.toContain('Android said');
    // Tier order holds: verified counts before the stage line.
    expect(report.body.indexOf('already moved')).toBeLessThan(
      report.body.indexOf('could not record'),
    );
  });

  it('stillStaged: false drops every "remain staged" claim (the rolled-back edited-copy path)', () => {
    const report = describeTrashFailure({
      trashedCount: 0,
      remaining: 0,
      unresolvedCount: 0,
      stage: 'dispatch',
      error: 'refused',
      stillStaged: false,
    });
    expect(report.body).not.toContain('staged');
    expect(report.body).toContain('Android refused');
  });

  it('an absent stage keeps the historical dispatch shape', () => {
    const report = describeTrashFailure({
      trashedCount: 0,
      remaining: 2,
      unresolvedCount: 0,
      error: 'XyZZy quantum flux error 0xDEAD (unrecognisable)',
    });
    expect(report.body).toContain('Android refused');
    expect(report.body).toContain('Android said:\n• XyZZy quantum flux error 0xDEAD');
  });
});
