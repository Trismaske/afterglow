/**
 * Launch-mode parsing (v0.5): how was the app started, and what should the
 * renderer do first?
 *
 * - Plain launch → the settings screen ('settings').
 * - `--show` (any platform) → straight into the slideshow ('show'). This is
 *   also what the Windows `.scr` wrapper effectively requests via `/s`.
 * - Windows screensaver arguments (win32 only — on other platforms a `/s`
 *   argument is far more likely to be a path than a screensaver flag):
 *     /s          run the screensaver          → 'show'
 *     /p <hwnd>   preview inside a tiny hwnd   → 'preview-quit' (unsupported;
 *                 quit immediately rather than fight the preview pane)
 *     /c, /c:hwnd open the configure dialog    → 'settings'
 *   Windows is inconsistent about case and separators, so `/S`, `-s` and
 *   `/c:1234` all parse.
 *
 * Kept pure (argv + platform in, mode out) so it is unit-testable.
 */

export type LaunchMode = 'settings' | 'show' | 'preview-quit';

/** Windows screensaver switch: "/s", "-S", "/c:5551212", ... */
const WIN_SAVER_ARG = /^[/-]([spc])(?::.*)?$/i;

export function parseLaunchMode(argv: readonly string[], platform: string): LaunchMode {
  for (const arg of argv) {
    if (arg === '--show') return 'show';
    if (platform !== 'win32') continue;
    const match = WIN_SAVER_ARG.exec(arg);
    if (!match) continue;
    switch (match[1].toLowerCase()) {
      case 's':
        return 'show';
      case 'p':
        return 'preview-quit';
      case 'c':
        return 'settings';
    }
  }
  return 'settings';
}
