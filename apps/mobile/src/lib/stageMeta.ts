/**
 * The stage's METADATA CORNER (m0.9 phase 7, F31 + F33): the facts the
 * deck draws in the top-left, as lines by KIND of fact (Tristan,
 * 2026-09-22) — WHEN (day · time), WHERE (folder · SD), WHAT (file type ·
 * pixels · megapixels or class · duration). A line with nothing on
 * disappears, so a fact keeps a fixed spot whatever the Overlay rows
 * enable. Pure: the deck passes the facts in, the Overlay preferences
 * choose, and the corner renders the lines.
 *
 * Which kinds carry which facts (Tristan, 2026-09-22): a photo and a
 * GIF carry pixels and megapixels; a video carries pixels, its
 * RESOLUTION CLASS in the megapixels spot (480p · 720p · 1080p · 2K ·
 * 4K · 8K — "8 MP" says little of a 4K frame) and its duration; a
 * motion photo carries its photo's pixels and megapixels and its clip's
 * duration once the clip has been read. A fact the scan and the
 * measurement rescue both lacked is omitted silently here (M17: the
 * stage omits, the details overlay names).
 *
 * The folder is EXCEPTIONS-ONLY (F31, G12): the primary volume's
 * DCIM/Camera is the plain photo of source-ness and names nothing;
 * every other folder, and any folder on the SD card, is named.
 */
import type { AnimatedKind } from './animatedCells';
import type { OverlayPrefs } from './overlayPrefs';

/** What the stage knows of the file (photos.display_name, width,
 * height, duration_ms); null = unknown to the scan (M17). */
export interface FileFacts {
  displayName: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** The display name's extension, uppercase without the dot (M15: the
 * name is the extension truth; MIME is the classification truth). Null
 * when the name has none. */
export function extensionOf(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const dot = displayName.lastIndexOf('.');
  if (dot <= 0 || dot === displayName.length - 1) return null;
  const ext = displayName.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,8}$/.test(ext)) return null;
  return ext.toUpperCase();
}

/** "12 MP", "0.3 MP" — whole numbers from ten up, one decimal below. */
export function megapixelsOf(width: number, height: number): string {
  const mp = (width * height) / 1_000_000;
  return `${mp >= 10 ? Math.round(mp).toString() : mp.toFixed(1)} MP`;
}

/** A video's class from its frame's SHORTER side, rounded to the
 * nearest of the named classes — a portrait 1080 × 1920 and a
 * 1088-line file both read 1080p. */
export function resolutionClassOf(width: number, height: number): string {
  const short = Math.min(width, height);
  const classes: ReadonlyArray<readonly [number, string]> = [
    [480, '480p'],
    [720, '720p'],
    [1080, '1080p'],
    [1440, '2K'],
    [2160, '4K'],
    [4320, '8K'],
  ];
  let best = classes[0];
  for (const c of classes) if (Math.abs(c[0] - short) < Math.abs(best[0] - short)) best = c;
  return best[1];
}

/** "0:34", "12:05", "1:02:03". Under a second rounds to "0:01" so a
 * clip never reads as empty. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The parent-folder name from a file uri — the segment above the
 * filename; null when the uri has no usable directory (content://
 * uris, root files). */
export function folderNameOfUri(uri: string | null | undefined): string | null {
  if (!uri || !uri.startsWith('file://')) return null;
  const segments = uri.slice('file://'.length).split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const folder = segments[segments.length - 2];
  if (folder.length === 0) return null;
  // A literal '%' in a folder name ("100% Photos") is a malformed escape
  // to decodeURIComponent; the raw segment is the honest fallback.
  try {
    return decodeURIComponent(folder);
  } catch {
    return folder;
  }
}

/** The folder the corner names: null for the primary volume's
 * DCIM/Camera (exceptions-only, F31), the folder name otherwise. */
export function folderAnnotation(uri: string | null | undefined, sdCard: boolean): string | null {
  const folder = folderNameOfUri(uri);
  if (folder === null) return null;
  if (!sdCard && /\/DCIM\/Camera\/[^/]+$/.test(uri ?? '')) return null;
  return folder;
}

export interface StageMetaInput {
  /** The WHEN line as the deck already words it (day · time, and its
   * untracked note) — dates are the deck's business. */
  when: string;
  folder: string | null;
  sdCard: boolean;
  /** What the item is (lib/animatedCells `animatedKindOf`): null = a
   * plain photo. */
  kind: AnimatedKind | null;
  facts: FileFacts | null;
}

const SEP = ' · ';

/** The corner's lines under the Overlay preferences: [] when nothing is
 * on, so the corner itself can go. */
export function stageMetaLines(input: StageMetaInput, prefs: OverlayPrefs): string[] {
  const lines: string[] = [];
  if (prefs.dateTime) lines.push(input.when);
  if (prefs.folder) {
    const where: string[] = [];
    if (input.folder !== null) where.push(input.folder);
    if (input.sdCard) where.push('SD card');
    if (where.length > 0) lines.push(where.join(SEP));
  }
  const what: string[] = [];
  const f = input.facts;
  if (f !== null) {
    const ext = prefs.extension ? extensionOf(f.displayName) : null;
    if (ext !== null) what.push(ext);
    const sized = f.width !== null && f.height !== null && f.width > 0 && f.height > 0;
    if (sized && prefs.pixels) what.push(`${f.width} × ${f.height}`);
    if (sized && prefs.megapixels)
      what.push(
        input.kind === 'video'
          ? resolutionClassOf(f.width as number, f.height as number)
          : megapixelsOf(f.width as number, f.height as number),
      );
    const timed = input.kind === 'video' || input.kind === 'motion';
    if (timed && prefs.duration && f.durationMs !== null && f.durationMs > 0)
      what.push(formatDuration(f.durationMs));
  }
  if (what.length > 0) lines.push(what.join(SEP));
  return lines;
}
