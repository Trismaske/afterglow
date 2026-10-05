import { describe, expect, it } from 'vitest';
import { scanProgressLine, type ScanProgress } from './scanProgress';

const n = (x: number): string => x.toLocaleString();

const base: ScanProgress = {
  phase: 'scanning',
  kind: 'full',
  reason: 'first',
  scanned: 0,
  embedded: 0,
  total: null,
  changed: null,
  remaining: null,
  resumed: false,
};

describe('scanProgressLine', () => {
  it('renders nothing while the skip check runs, or when idle or done', () => {
    expect(scanProgressLine({ ...base, phase: 'checking' })).toBeNull();
    expect(scanProgressLine({ ...base, phase: 'idle' })).toBeNull();
    expect(scanProgressLine({ ...base, phase: 'done' })).toBeNull();
  });

  it('a first full pass shows the walk percent against the library snapshot', () => {
    expect(scanProgressLine({ ...base, scanned: 7000, total: 30000 })).toBe(
      `Initial scan 23% · ${n(7000)} of ${n(30000)} items`,
    );
    // Photos landing mid-scan: the numerator clamps to the snapshot.
    expect(scanProgressLine({ ...base, scanned: 30010, total: 30000 })).toBe(
      `Initial scan 100% · ${n(30000)} of ${n(30000)} items`,
    );
  });

  it('a full pass names its reason', () => {
    const at = (reason: ScanProgress['reason']) =>
      scanProgressLine({ ...base, reason, scanned: 100, total: 1000 });
    expect(at('weekly')).toBe(`Weekly full scan 10% · 100 of ${n(1000)} items`);
    expect(at('unavailable')).toBe(`Rescanning · delta check failed 10% · 100 of ${n(1000)} items`);
    expect(at('forced')).toBe(`Rescanning · settings changed 10% · 100 of ${n(1000)} items`);
    expect(at('manual')).toBe(`Rescanning · manually triggered 10% · 100 of ${n(1000)} items`);
    expect(at('model')).toBe(`Rescanning · model changed 10% · 100 of ${n(1000)} items`);
    expect(at('rules')).toBe(`Rescanning · grouping changed 10% · 100 of ${n(1000)} items`);
    expect(at('loss')).toBe(`Reconciling deletions 10% · 100 of ${n(1000)} items`);
    expect(at('dates')).toBe(`Rescanning · dates changed 10% · 100 of ${n(1000)} items`);
    expect(at('inconsistent')).toBe(`Rescanning · counts disagreed 10% · 100 of ${n(1000)} items`);
    expect(at('storage')).toBe(`Scanning new storage 10% · 100 of ${n(1000)} items`);
  });

  it("a resumed pass shows the interrupted pass's own reason, resumed, with the fixed work left", () => {
    expect(
      scanProgressLine({
        ...base,
        reason: 'weekly',
        resumed: true,
        scanned: 18000,
        total: 28535,
        remaining: 9441,
        embedded: 0,
      }),
    ).toBe(`Weekly full scan · resumed 63% · ${n(9441)} of ${n(28535)} items to analyze`);
    // The figure is fixed for the pass: this run's embed count is a
    // different population and never decrements it.
    expect(
      scanProgressLine({
        ...base,
        reason: 'weekly',
        resumed: true,
        scanned: 20000,
        total: 28535,
        remaining: 9441,
        embedded: 2000,
      }),
    ).toBe(`Weekly full scan · resumed 70% · ${n(9441)} of ${n(28535)} items to analyze`);
    // Nothing left to analyze (every item embedded): the walk count,
    // never "0 of N to analyze".
    expect(
      scanProgressLine({
        ...base,
        reason: 'manual',
        resumed: true,
        scanned: 21000,
        total: 33188,
        remaining: 0,
      }),
    ).toBe(`Rescanning · manually triggered · resumed 63% · ${n(21000)} of ${n(33188)} items`);
    // A checkpoint written without a reason: the fallback words.
    expect(
      scanProgressLine({
        ...base,
        reason: 'resume',
        resumed: true,
        scanned: 18000,
        total: 28535,
        remaining: 9441,
      }),
    ).toBe(`Resuming last scan 63% · ${n(9441)} of ${n(28535)} items to analyze`);
  });

  it('a delta names its size in items, and what it analyzed so far', () => {
    expect(scanProgressLine({ ...base, kind: 'delta', reason: null, changed: 1 })).toBe(
      'Checking 1 changed item',
    );
    expect(
      scanProgressLine({ ...base, kind: 'delta', reason: null, changed: 12, embedded: 5 }),
    ).toBe('Checking 12 changed items · 5 analyzed');
  });

  it('a targeted pass says it is regrouping', () => {
    expect(scanProgressLine({ ...base, kind: 'targeted', reason: null, scanned: 0 })).toBe(
      'Regrouping 1 item',
    );
    expect(scanProgressLine({ ...base, kind: 'targeted', reason: null, scanned: 6 })).toBe(
      'Regrouping 6 items',
    );
  });

  it('without a library count a full pass shows plain counts', () => {
    expect(scanProgressLine({ ...base, scanned: 400, embedded: 12 })).toBe(
      'Initial scan… 400 seen · 12 analyzed',
    );
  });
});
