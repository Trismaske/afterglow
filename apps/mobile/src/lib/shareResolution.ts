/**
 * Share-resolution wiring (m0.8.6 D10), installed once at app root.
 *
 * Two facts drive the share lifecycle past `sheet_opened`, and both are
 * app-global — a chooser choice can arrive after the Share screen
 * unmounted, and abandonment is an absence only visible on return:
 *
 * - The chooser's chosen-component event resolves its batch to `shared`
 *   (the token IS the batch id, riding the IntentSender round trip).
 * - A return to the foreground schedules the abandonment sweep: the
 *   callback fires at choice time, so a `sheet_opened` batch still
 *   unresolved shortly after resume was dismissed — discard it whole
 *   (the photos stay queued; only the attempt evaporates).
 *
 * The sweep waits SWEEP_DELAY_MS after resume (a late-delivered chosen
 * event must win the race) and only touches batches opened at least
 * OPEN_GRACE_MS ago (a resume racing a fresh dispatch must never sweep
 * the sheet out from under the user); a batch still inside that grace
 * gets a follow-up sweep at its expiry, so a sub-grace dismissal never
 * lingers past its window (codex r4). Both writes are guarded state
 * transitions, so either order of the race is safe: a mark after the
 * discard no-ops on the missing row (the accepted crash-window
 * undercount), a discard after the mark skips the `shared` batch.
 */
import { AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { subscribeShareTargetChosen } from '../../modules/media-store-actions';
import {
  discardAbandonedShareBatches,
  markShareBatchShared,
  oldestOpenShareSheet,
} from '../db/shareStore';

const SWEEP_DELAY_MS = 2_000;
const OPEN_GRACE_MS = 5_000;

export function installShareResolution(db: SQLiteDatabase): () => void {
  const unsubscribeChosen = subscribeShareTargetChosen(({ token, component }) => {
    if (token < 0) return;
    // Bounded retry (codex r5): the chosen event is delivered exactly
    // once, so a transient write failure here (plus the Share screen's
    // own parallel attempt) is the only chance to record a real share —
    // an unrecorded one gets swept as abandoned. Three tries, spaced.
    const record = async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await markShareBatchShared(db, token, component, Date.now());
          return;
        } catch (error) {
          if (attempt >= 3) {
            console.warn('[share] chosen-target record failed after retries:', String(error));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    };
    void record();
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sweepFailures = 0;
  const sweep = () => {
    timer = null;
    void discardAbandonedShareBatches(db, Date.now() - OPEN_GRACE_MS)
      .then(async (discarded) => {
        sweepFailures = 0;
        // Loud once, per the deliberate-fallback rule: a discarded
        // attempt is a real user action reduced to nothing.
        if (discarded > 0) {
          console.log(`[share] ${discarded} abandoned share sheet(s) discarded`);
        }
        // A sheet dismissed WITHIN the grace window is protected from
        // this pass — schedule ONE follow-up at the earliest expiry
        // (codex r4: without it, a sub-grace dismissal lingered until
        // the next unrelated foreground transition). A chosen event in
        // the meantime resolves the batch and the follow-up no-ops.
        const oldest = await oldestOpenShareSheet(db);
        if (oldest === null || timer !== null) return;
        const wait = Math.max(250, oldest + OPEN_GRACE_MS - Date.now() + 250);
        timer = setTimeout(sweep, wait);
      })
      .catch((error: unknown) => {
        console.warn('[share] abandonment sweep failed:', String(error));
        // Bounded re-arm (codex r5): a transiently failed sweep would
        // otherwise leave the batch until an unrelated transition — but
        // a persistently broken database must not retry forever.
        sweepFailures += 1;
        if (sweepFailures < 3 && timer === null) timer = setTimeout(sweep, SWEEP_DELAY_MS);
      });
  };
  const appState = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(sweep, SWEEP_DELAY_MS);
  });
  return () => {
    unsubscribeChosen();
    appState.remove();
    if (timer !== null) clearTimeout(timer);
  };
}
