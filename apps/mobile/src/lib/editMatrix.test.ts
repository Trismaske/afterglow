import { describe, expect, it } from 'vitest';
import {
  formatMatrixReport,
  nextMatrixStep,
  sawSecurityFailure,
  type MatrixRecord,
} from './editMatrix';

const launched = (step: MatrixRecord['step'], observedOpen = true): MatrixRecord => ({
  step,
  dispatch: { result: 'launched', message: 'dispatch accepted' },
  observedOpen,
});

const security = (step: MatrixRecord['step']): MatrixRecord => ({
  step,
  dispatch: { result: 'security', message: 'UID 10434 does not have permission' },
});

describe('nextMatrixStep', () => {
  it('runs the three dispatch probes in order', () => {
    expect(nextMatrixStep([])).toBe('view_read');
    expect(nextMatrixStep([launched('view_read')])).toBe('edit_read');
    expect(nextMatrixStep([launched('view_read'), launched('edit_read')])).toBe('edit_readwrite');
  });

  it('completes without the write branch when nothing threw SecurityException', () => {
    const records = [launched('view_read'), launched('edit_read'), launched('edit_readwrite')];
    expect(sawSecurityFailure(records)).toBe(false);
    expect(nextMatrixStep(records)).toBeNull();
  });

  it('branches to createWriteRequest when any probe hit SecurityException', () => {
    const records = [launched('view_read'), launched('edit_read'), security('edit_readwrite')];
    expect(sawSecurityFailure(records)).toBe(true);
    expect(nextMatrixStep(records)).toBe('write_request');
  });

  it('branches even when only read-mode probes failed (Samsung shows VIEW failing too)', () => {
    const records = [security('view_read'), security('edit_read'), security('edit_readwrite')];
    expect(nextMatrixStep(records)).toBe('write_request');
  });

  it('re-probes EDIT read+write only after an approved write request', () => {
    const base = [launched('view_read'), launched('edit_read'), security('edit_readwrite')];
    const approved: MatrixRecord = {
      step: 'write_request',
      dispatch: { result: 'approved', message: 'user approved' },
    };
    const cancelled: MatrixRecord = {
      step: 'write_request',
      dispatch: { result: 'cancelled', message: 'user cancelled' },
    };
    expect(nextMatrixStep([...base, approved])).toBe('edit_readwrite_after_grant');
    expect(nextMatrixStep([...base, cancelled])).toBeNull();
    expect(nextMatrixStep([...base, approved, launched('edit_readwrite_after_grant')])).toBeNull();
  });
});

describe('formatMatrixReport', () => {
  it('includes URI provenance, env lines, every record, and completion state', () => {
    const report = formatMatrixReport(
      [
        ['Device', 'samsung SM-G991B'],
        ['UID', '10434'],
      ],
      'content://media/external_primary/images/media/1000168830',
      [launched('view_read'), security('edit_readwrite')],
    );
    expect(report).toContain('constructed canonical volume-qualified uri');
    expect(report).toContain('samsung SM-G991B');
    expect(report).toContain('VIEW, read-only grant: launched');
    expect(report).toContain('(an app opened)');
    expect(report).toContain('EDIT, read+write grant: security');
    expect(report).toContain('Matrix incomplete');
  });

  it('flags a dispatch that launched with nothing observed opening', () => {
    const report = formatMatrixReport([], 'content://media/1', [launched('view_read', false)]);
    expect(report).toContain('NOTHING opened');
  });

  it('reports completion when the sequence is done', () => {
    const report = formatMatrixReport([], 'content://media/1', [
      launched('view_read'),
      launched('edit_read'),
      launched('edit_readwrite'),
    ]);
    expect(report).toContain('Matrix complete.');
  });
});
