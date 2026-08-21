/**
 * The edit-launch classifier (Errors_design §4.4/D2, §8's pattern): the
 * stage and probe facts are OURS; an unrecognisable platform message
 * proves no text matching; tier 3 always last.
 */
import { describe, expect, it } from 'vitest';
import { describeEditLaunchFailure } from './editLaunchFailures';

describe('describeEditLaunchFailure', () => {
  it("the probe's no_handler verdict names the missing editor, actionably", () => {
    const weird = 'Zorp activity manager glitch 41 (unrecognisable)';
    const report = describeEditLaunchFailure({
      operation: 'edit',
      stage: 'dispatch',
      probe: 'no_handler',
      error: weird,
    });
    expect(report.body).toContain('No installed app offers photo editing');
    expect(report.body).toContain('Install or enable one, then retry.');
    expect(report.body).toContain(`Android said:\n• ${weird}`);
    expect(report.body.indexOf('No installed app')).toBeLessThan(
      report.body.indexOf('Android said'),
    );
  });

  it('a security probe verdict points at the permission matrix', () => {
    const report = describeEditLaunchFailure({
      operation: 'edit',
      stage: 'dispatch',
      probe: 'security',
      error: 'x',
    });
    expect(report.body).toContain('Android refused Afterglow permission');
    expect(report.body).toContain('permission matrix');
  });

  it('a write-request failure is named as OURS — no editor was involved', () => {
    const report = describeEditLaunchFailure({
      operation: 'edit',
      stage: 'write_request',
      error: 'RecoverableSecurityException blah',
    });
    expect(report.body).toContain('MediaStore refused write access');
    expect(report.body).toContain('before any editor was involved');
  });

  it('a resolve failure suggests the rescan repair', () => {
    const report = describeEditLaunchFailure({ operation: 'view', stage: 'resolve' });
    expect(report.body).toContain('did not resolve to an Android content address');
    expect(report.body).toContain('no viewer could be offered it');
  });

  it('no probe verdict → the honest generic line, never an invented cause', () => {
    const report = describeEditLaunchFailure({
      operation: 'view',
      stage: 'dispatch',
      error: 'mystery',
    });
    expect(report.body).toContain('Android could not open a viewer for this photo.');
    expect(report.body).not.toContain('No installed app');
  });

  it('a blank error prints no empty quote', () => {
    const report = describeEditLaunchFailure({ operation: 'edit', stage: 'dispatch', error: '' });
    expect(report.body).not.toContain('Android said');
  });
});
