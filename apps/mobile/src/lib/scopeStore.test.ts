import { describe, expect, it } from 'vitest';
import { DAY_MS } from './scopes';
import {
  addCustomScope,
  defaultScopeConfig,
  enabledScopes,
  newCustomScopeId,
  parseScopeConfig,
  removeScope,
  resetScopeConfig,
  serializeScopeConfig,
  setScopeEnabled,
  storedScopeRange,
} from './scopeStore';

const NOW = Date.UTC(2026, 6, 18, 12, 0, 0);

describe('defaultScopeConfig', () => {
  it('seeds every builtin with its stable id, enabled, no picker chip', () => {
    const config = defaultScopeConfig();
    expect(config.scopes.map((s) => s.id)).toEqual([
      'day1',
      'days7',
      'days30',
      'months6',
      'year1',
      'all',
    ]);
    expect(config.scopes.every((s) => s.builtin && s.enabled)).toBe(true);
  });

  it('keeps the m0.3.1 rolling day counts', () => {
    const config = defaultScopeConfig();
    const days = Object.fromEntries(
      config.scopes.filter((s) => s.kind === 'rolling').map((s) => [s.id, s.days]),
    );
    expect(days).toEqual({ day1: 1, days7: 7, days30: 30, months6: 183, year1: 365 });
  });
});

describe('parse / serialize', () => {
  it('round-trips a config with customs and disabled builtins', () => {
    let config = defaultScopeConfig();
    config = setScopeEnabled(config, 'months6', false);
    config = addCustomScope(config, {
      id: newCustomScopeId(NOW),
      label: 'Japan',
      startMs: NOW - 40 * DAY_MS,
      endMs: NOW - 10 * DAY_MS,
    });
    expect(parseScopeConfig(serializeScopeConfig(config))).toEqual(config);
  });

  it('falls back to defaults on absent or garbage input', () => {
    expect(parseScopeConfig(null)).toEqual(defaultScopeConfig());
    expect(parseScopeConfig('')).toEqual(defaultScopeConfig());
    expect(parseScopeConfig('nonsense')).toEqual(defaultScopeConfig());
    expect(parseScopeConfig('{"version":2,"scopes":[]}')).toEqual(defaultScopeConfig());
    expect(parseScopeConfig('{"version":1}')).toEqual(defaultScopeConfig());
  });

  it('drops malformed scope entries but keeps valid ones', () => {
    const custom = {
      id: 'range-1',
      label: 'Trip',
      kind: 'range',
      startMs: 0,
      endMs: 10,
      builtin: false,
      enabled: true,
    };
    const raw = JSON.stringify({
      version: 1,
      scopes: [custom, { id: 'bad' }, { kind: 'range', builtin: false }],
    });
    const parsed = parseScopeConfig(raw);
    expect(parsed.scopes.filter((s) => !s.builtin)).toEqual([custom]);
  });

  it('re-seeds missing builtins without resurrecting disabled ones', () => {
    let config = defaultScopeConfig();
    config = setScopeEnabled(config, 'day1', false);
    const withoutYear = {
      version: 1 as const,
      scopes: config.scopes.filter((s) => s.id !== 'year1'),
    };
    const parsed = parseScopeConfig(serializeScopeConfig(withoutYear));
    expect(parsed.scopes.find((s) => s.id === 'year1')?.enabled).toBe(true); // re-seeded
    expect(parsed.scopes.find((s) => s.id === 'day1')?.enabled).toBe(false); // untouched
  });
});

describe('mutations', () => {
  it('addCustomScope appends an enabled fixed range and trims the name', () => {
    const config = addCustomScope(defaultScopeConfig(), {
      id: 'range-9',
      label: '  Japan  ',
      startMs: 100,
      endMs: 200,
    });
    const custom = config.scopes[config.scopes.length - 1];
    expect(custom).toEqual({
      id: 'range-9',
      label: 'Japan',
      kind: 'range',
      startMs: 100,
      endMs: 200,
      builtin: false,
      enabled: true,
    });
  });

  it('addCustomScope rejects empty names and duplicate ids', () => {
    expect(() =>
      addCustomScope(defaultScopeConfig(), { id: 'x', label: '   ', startMs: 0, endMs: 1 }),
    ).toThrow();
    const config = addCustomScope(defaultScopeConfig(), {
      id: 'x',
      label: 'A',
      startMs: 0,
      endMs: 1,
    });
    expect(() => addCustomScope(config, { id: 'x', label: 'B', startMs: 0, endMs: 1 })).toThrow();
  });

  it('removeScope deletes customs but never builtins', () => {
    let config = addCustomScope(defaultScopeConfig(), {
      id: 'range-1',
      label: 'Trip',
      startMs: 0,
      endMs: 1,
    });
    config = removeScope(config, 'range-1');
    expect(config.scopes.some((s) => s.id === 'range-1')).toBe(false);
    config = removeScope(config, 'day1');
    expect(config.scopes.some((s) => s.id === 'day1')).toBe(true);
  });

  it('setScopeEnabled toggles and enabledScopes filters', () => {
    let config = defaultScopeConfig();
    config = setScopeEnabled(config, 'days30', false);
    expect(enabledScopes(config).map((s) => s.id)).not.toContain('days30');
    config = setScopeEnabled(config, 'days30', true);
    expect(enabledScopes(config).map((s) => s.id)).toContain('days30');
  });

  it('resetScopeConfig restores builtins but keeps customs', () => {
    let config = defaultScopeConfig();
    config = setScopeEnabled(config, 'day1', false);
    config = addCustomScope(config, { id: 'range-1', label: 'Trip', startMs: 0, endMs: 1 });
    const reset = resetScopeConfig(config);
    expect(reset.scopes.find((s) => s.id === 'day1')?.enabled).toBe(true);
    expect(reset.scopes.some((s) => s.id === 'range-1')).toBe(true);
  });
});

describe('storedScopeRange', () => {
  it('rolling scopes end at now with the fixed day count', () => {
    const config = defaultScopeConfig();
    const days7 = config.scopes.find((s) => s.id === 'days7')!;
    expect(storedScopeRange(days7, NOW)).toEqual({
      startMs: NOW - 7 * DAY_MS,
      endMs: NOW,
      label: 'Last 7 days',
    });
  });

  it('all time spans epoch → now', () => {
    const all = defaultScopeConfig().scopes.find((s) => s.id === 'all')!;
    expect(storedScopeRange(all, NOW)).toEqual({ startMs: 0, endMs: NOW, label: 'All time' });
  });

  it('custom ranges are fixed — they do not move with now', () => {
    const config = addCustomScope(defaultScopeConfig(), {
      id: 'range-1',
      label: 'Japan',
      startMs: 1000,
      endMs: 2000,
    });
    const custom = config.scopes.find((s) => s.id === 'range-1')!;
    expect(storedScopeRange(custom, NOW)).toEqual({ startMs: 1000, endMs: 2000, label: 'Japan' });
    expect(storedScopeRange(custom, NOW + DAY_MS)).toEqual({
      startMs: 1000,
      endMs: 2000,
      label: 'Japan',
    });
  });
});
