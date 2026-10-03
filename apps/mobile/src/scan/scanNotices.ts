/**
 * The scan NOTICES (m0.9 phase 9, the impure binding): MediaStore's
 * ContentObserver relay (modules/media-store-actions `mediaChanged`)
 * becomes ONE delta request per burst of change events. The observer
 * is the load-bearing half of the design: a photo taken from the lock
 * screen, an edit saved in Gallery, a delete in its Recycle bin, or a
 * Samsung camera row leaving PENDING all notify the provider — and the
 * app, foregrounded on the Timeline or a deck, noticed none of them
 * until Home regained focus (sink-proven on the S23, 2026-09-08). The
 * other halves live elsewhere: every foreground return requests a
 * check (the review provider), pull-to-refresh on Home, Everything and
 * Progress asks explicitly (scanRunner.requestLibraryCheck), and a
 * surface finding items MediaStore has and the DB lacks asks too
 * (ProgressView). No timer polls.
 *
 * DEBOUNCED, trailing: a camera burst or a 50-file download notifies
 * per row, and the check should run once, after. FOREGROUND ONLY: an
 * event while the app is in the background is dropped — the foreground
 * return's own check covers it, and scanning behind a backgrounded
 * app is deliberately out of scope (docs/TODO.md).
 *
 * MEDIA COLLECTIONS ONLY (measured on the S10e, 2026-10-01): the
 * provider notifies for EVERY row in its files table, and the app's
 * own diagnostics sink lives in the external files dir — each check
 * wrote its sink lines, the write notified `…/file/<id>`, and the
 * observer asked for the next check: a self-fed loop at a few seconds'
 * cadence. An event is a photo or video change only when its URI names
 * the images or video collection; everything else (`file`, `audio`,
 * `downloads`, the root) is counted and dropped, and the notice line
 * names what arrived so the sink can tell a real burst from noise.
 * The scan itself never writes MediaStore; the app's own trash,
 * favourite and move requests do, and the check they trigger
 * reconciles their rows (cheap: the change query reports what the flow
 * already converged).
 */
import { AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { subscribeMediaChanged } from '../../modules/media-store-actions';
import { isMediaCollectionUri, mediaUriCollection } from '../lib/mediaUri';
import { noticeMediaChange } from './scanRunner';

const DEBOUNCE_MS = 2_000;

/** Subscribe for the process life; returns the unsubscribe. */
export function installScanNotices(db: SQLiteDatabase): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const seen = new Map<string, number>();
  let media = 0;
  const fire = (): void => {
    timer = null;
    const kinds = [...seen.entries()].map(([k, n]) => `${k} ×${n}`).join(', ');
    const relevant = media;
    seen.clear();
    media = 0;
    if (relevant === 0 || AppState.currentState !== 'active') return;
    console.log(`[scan] notice: MediaStore change event(s): ${kinds} — checking`);
    void noticeMediaChange(db);
  };
  const unsubscribe = subscribeMediaChanged(({ uri }) => {
    const collection = mediaUriCollection(uri);
    seen.set(collection, (seen.get(collection) ?? 0) + 1);
    // Only a media event arms or extends the debounce; the rest are
    // tallied for the line and otherwise silent — a stream of unrelated
    // writes (the sink's own) must neither arm a check nor postpone an
    // armed one indefinitely (codex r1).
    if (!isMediaCollectionUri(uri)) return;
    media += 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, DEBOUNCE_MS);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
