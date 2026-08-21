/**
 * The share failure report (Errors_design §4.3, §8's pattern): the
 * stage-proven tier 1, the honest tier 2, an unrecognisable platform
 * message, tier 3 last, n = 1 asserted.
 */
import { describe, expect, it } from 'vitest';
import { describeShareFailure } from './shareFailures';

describe('describeShareFailure', () => {
  it('a PREPARE failure is ours to name — Android never saw the batch', () => {
    const report = describeShareFailure({ count: 3, stage: 'prepare', error: 'ENOENT xz' });
    expect(report.body).toContain('3 photos could not be prepared for sharing');
    expect(report.body).toContain('the share sheet was never opened');
    expect(report.body).toContain('Android said:\n• ENOENT xz');
  });

  it('a DISPATCH failure gets the honest generic line, verbatim last', () => {
    const weird = 'Frobnitz handler 0x2A rejected (unrecognisable)';
    const report = describeShareFailure({ count: 2, stage: 'dispatch', error: weird });
    expect(report.body).toContain('Android could not open the share sheet for 2 photos.');
    expect(report.body).toContain(`Android said:\n• ${weird}`);
    expect(report.body.indexOf('share sheet')).toBeLessThan(report.body.indexOf('Android said'));
  });

  it('n = 1 reads "1 photo"', () => {
    expect(describeShareFailure({ count: 1, stage: 'dispatch' }).body).toContain(
      'the share sheet for 1 photo.',
    );
  });

  it('a blank error prints no empty quote', () => {
    expect(describeShareFailure({ count: 1, stage: 'prepare', error: '' }).body).not.toContain(
      'Android said',
    );
  });
});
