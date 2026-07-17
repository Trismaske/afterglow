import { describe, expect, it } from 'vitest';
import { SCR_BASENAME, isSameWindowsPath, parseRegSz, scrPath } from '../src/main/screensaver';

// Only the pure pieces are testable on this (Linux) machine; the reg.exe
// round-trips are exercised on a real Windows install.

describe('parseRegSz', () => {
  const sample = [
    '',
    'HKEY_CURRENT_USER\\Control Panel\\Desktop',
    '    SCRNSAVE.EXE    REG_SZ    C:\\Users\\T\\AppData\\Local\\Programs\\Afterglow\\Afterglow.scr',
    '',
  ].join('\r\n');

  it('extracts a REG_SZ value, spaces in the data included', () => {
    expect(parseRegSz(sample, 'SCRNSAVE.EXE')).toBe(
      'C:\\Users\\T\\AppData\\Local\\Programs\\Afterglow\\Afterglow.scr',
    );
    const spaced = '    SCRNSAVE.EXE    REG_SZ    C:\\Program Files\\A B\\x.scr';
    expect(parseRegSz(spaced, 'SCRNSAVE.EXE')).toBe('C:\\Program Files\\A B\\x.scr');
  });

  it('accepts REG_EXPAND_SZ and is case-insensitive on the value name', () => {
    const expand = '    scrnsave.exe    REG_EXPAND_SZ    %SystemRoot%\\ssText3d.scr';
    expect(parseRegSz(expand, 'SCRNSAVE.EXE')).toBe('%SystemRoot%\\ssText3d.scr');
  });

  it('returns null when the value is absent or the output is an error blurb', () => {
    expect(parseRegSz('', 'SCRNSAVE.EXE')).toBeNull();
    expect(
      parseRegSz('ERROR: The system was unable to find the specified registry key or value.', 'SCRNSAVE.EXE'),
    ).toBeNull();
    expect(parseRegSz(sample, 'ScreenSaveActive')).toBeNull();
  });
});

describe('isSameWindowsPath', () => {
  it('compares case-insensitively after normalization', () => {
    expect(isSameWindowsPath('C:\\A\\Afterglow.scr', 'c:\\a\\afterglow.SCR')).toBe(true);
    expect(isSameWindowsPath('C:\\A\\Afterglow.scr', 'C:\\B\\Afterglow.scr')).toBe(false);
  });
});

describe('scrPath', () => {
  it(`is ${SCR_BASENAME} next to the exe`, () => {
    // path.join uses the host separator; assert on the pieces, not the sep.
    const p = scrPath('/opt/Afterglow/afterglow');
    expect(p.endsWith(SCR_BASENAME)).toBe(true);
    expect(p.includes('Afterglow')).toBe(true);
  });
});
