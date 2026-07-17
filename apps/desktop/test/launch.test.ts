import { describe, expect, it } from 'vitest';
import { parseLaunchMode } from '../src/main/launch';

describe('parseLaunchMode', () => {
  it('defaults to the settings screen', () => {
    expect(parseLaunchMode(['electron', 'apps/desktop'], 'linux')).toBe('settings');
    expect(parseLaunchMode(['C:\\Afterglow\\Afterglow.exe'], 'win32')).toBe('settings');
  });

  it('--show starts the slideshow on every platform', () => {
    expect(parseLaunchMode(['electron', 'apps/desktop', '--show'], 'linux')).toBe('show');
    expect(parseLaunchMode(['Afterglow.exe', '--show'], 'win32')).toBe('show');
    expect(parseLaunchMode(['electron', '.', '--smoke', '--show'], 'darwin')).toBe('show');
  });

  it('honors Windows screensaver args on win32 (any case, / or -, :hwnd)', () => {
    expect(parseLaunchMode(['Afterglow.scr', '/s'], 'win32')).toBe('show');
    expect(parseLaunchMode(['Afterglow.scr', '/S'], 'win32')).toBe('show');
    expect(parseLaunchMode(['Afterglow.scr', '-s'], 'win32')).toBe('show');
    expect(parseLaunchMode(['Afterglow.scr', '/p', '133742'], 'win32')).toBe('preview-quit');
    expect(parseLaunchMode(['Afterglow.scr', '/P:133742'], 'win32')).toBe('preview-quit');
    expect(parseLaunchMode(['Afterglow.scr', '/c'], 'win32')).toBe('settings');
    expect(parseLaunchMode(['Afterglow.scr', '/c:5551212'], 'win32')).toBe('settings');
  });

  it('ignores slash args off Windows (they are far more likely paths)', () => {
    expect(parseLaunchMode(['electron', '/s'], 'linux')).toBe('settings');
    expect(parseLaunchMode(['electron', '/p'], 'darwin')).toBe('settings');
  });

  it('ignores unrelated arguments', () => {
    expect(parseLaunchMode(['Afterglow.exe', '/x', '--smoke', '-shift'], 'win32')).toBe('settings');
  });
});
