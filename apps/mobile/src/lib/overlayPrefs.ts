/**
 * The Overlay section (m0.9 phase 7, F34): which items the deck stage
 * draws over the photo. Ten rows, each a durable boolean in the
 * settings table, each with the subtext Settings shows under it (M22:
 * full switch rows with an explanation, no chip grid). The rows CURATE
 * the set; the eye (lib/badgePrefs) MUTES the whole set at once (M20).
 *
 * One shared set for the deck stage and the expanded stage (M21).
 * Outside the set by design: the thumbnails' inspection dots and kind
 * marks (wayfinding), the details overlay (always complete), the
 * playback chrome, and the zoom fail-soft notice (a fidelity claim).
 *
 * Defaults: everything on except Megapixels (M19) — pixels are the
 * editing fact a photographer reads; megapixels the capture-settings
 * one (M14), a second rendering of the same fact — and Parts (settled
 * with Tristan, 2026-10-08): the strip divider already marks a part
 * boundary, so the chip is opt-in.
 */

export type OverlayRow =
  | 'dateTime'
  | 'folder'
  | 'position'
  | 'parts'
  | 'pixels'
  | 'megapixels'
  | 'extension'
  | 'duration'
  | 'kindChips'
  | 'statusBadges';

export type OverlayPrefs = Readonly<Record<OverlayRow, boolean>>;

/** The rows in Settings order: the metadata corner's lines first (when,
 * where, what), then the position box's two lines, then the two badge
 * rows. */
export const OVERLAY_ROWS: ReadonlyArray<{
  row: OverlayRow;
  key: string;
  title: string;
  hint: string;
  defaultOn: boolean;
}> = [
  {
    row: 'dateTime',
    key: 'overlay_date_time',
    title: 'Date & time',
    hint: 'When the photo was taken, in the top-left corner.',
    defaultOn: true,
  },
  {
    row: 'folder',
    key: 'overlay_folder',
    title: 'Source folder',
    hint: 'The folder a photo came from, when it is not the camera roll; and whether it sits on the SD card.',
    defaultOn: true,
  },
  {
    row: 'position',
    key: 'overlay_position',
    title: 'Position',
    hint: 'Where you are in the group or the list, in the top-right corner.',
    defaultOn: true,
  },
  {
    row: 'parts',
    key: 'overlay_parts',
    title: 'Parts',
    hint: 'Which look-alike part of a group you are in, under the position: Part 2 of 4 · 5 photos.',
    defaultOn: false,
  },
  {
    row: 'pixels',
    key: 'overlay_pixels',
    title: 'Resolution',
    hint: 'The exact size in pixels, such as 4032 × 3024.',
    defaultOn: true,
  },
  {
    row: 'megapixels',
    key: 'overlay_megapixels',
    title: 'Megapixels',
    hint: 'The same size as a single number, such as 12 MP. A video shows its class instead: 1080p, 4K.',
    defaultOn: false,
  },
  {
    row: 'extension',
    key: 'overlay_extension',
    title: 'File type',
    hint: 'The file name’s extension: JPG, HEIC, MP4.',
    defaultOn: true,
  },
  {
    row: 'duration',
    key: 'overlay_duration',
    title: 'Duration',
    hint: 'How long a video or a motion photo’s clip runs.',
    defaultOn: true,
  },
  {
    row: 'kindChips',
    key: 'overlay_kind_chips',
    title: 'Kind chips',
    hint: 'A small Video, Motion or GIF chip beside the status badges. Plain photos carry none.',
    defaultOn: true,
  },
  {
    row: 'statusBadges',
    key: 'overlay_status_badges',
    title: 'Status badges',
    hint: 'The verdict and the queued or carried actions: keep, cull, edit, favourite, organize, share.',
    defaultOn: true,
  },
];

export const OVERLAY_KEYS: readonly string[] = OVERLAY_ROWS.map((r) => r.key);

export const DEFAULT_OVERLAY_PREFS: OverlayPrefs = Object.fromEntries(
  OVERLAY_ROWS.map((r) => [r.row, r.defaultOn]),
) as Record<OverlayRow, boolean>;

/** The durable rows to a preference set: '1' on, '0' off, anything
 * else (unset, unreadable) the row's default — an odd row never wedges
 * the stage. */
export function parseOverlayPrefs(raw: ReadonlyMap<string, string | null>): OverlayPrefs {
  const out: Record<OverlayRow, boolean> = { ...DEFAULT_OVERLAY_PREFS };
  for (const r of OVERLAY_ROWS) {
    const value = raw.get(r.key);
    if (value === '1') out[r.row] = true;
    else if (value === '0') out[r.row] = false;
  }
  return out;
}

export function serializeOverlayPref(on: boolean): '1' | '0' {
  return on ? '1' : '0';
}
