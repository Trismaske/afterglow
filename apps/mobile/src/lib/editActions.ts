/**
 * Editor-launch intent constants + user-facing copy (m0.7 item A).
 *
 * m0.6's silent EDIT→VIEW fallback chain is retired: the gate-0 matrix
 * proved the real failure mode (an app with broad read access cannot
 * delegate a write grant it does not hold), and the tester wants explicit
 * control — so the edit queue offers two buttons instead:
 *
 *  - **Edit**  → write-request-first ACTION_EDIT (edit.ts): ask
 *    MediaStore.createWriteRequest for write access (auto-approved when
 *    already writable), then dispatch EDIT with read+write; denial falls
 *    back to EDIT read-only (the editor saves a copy, which edit
 *    detection picks up).
 *  - **Open in gallery** → ACTION_VIEW, read-only. The gallery's own edit
 *    button takes over with its own write powers (Samsung Gallery never
 *    registers as an EDIT handler, so this is the one-tap path for
 *    Gallery-preferring users).
 */
import type { StoredMediaKind } from './mediaIdentity';

export const ACTION_EDIT = 'android.intent.action.EDIT';
export const ACTION_VIEW = 'android.intent.action.VIEW';

/** The intent type an EDIT / VIEW launch declares for an item (m0.9
 * phase 4): Android resolves handlers by it, so a video launched as
 * image/* would find no editor or the wrong one. */
export function launchMimeType(kind: StoredMediaKind): 'image/*' | 'video/*' {
  return kind === 'video' ? 'video/*' : 'image/*';
}

/** The declared type of a share batch (m0.9 phase 4): the chooser filters
 * receivers by it, so a video-only batch says video/*, a photo-only batch
 * image/*, and a mixed batch the wildcard type (star-slash-star) — the
 * honest type for a heterogeneous ACTION_SEND_MULTIPLE. */
export function shareMimeType(kinds: readonly StoredMediaKind[]): 'image/*' | 'video/*' | '*/*' {
  const hasPhoto = kinds.includes('photo');
  const hasVideo = kinds.includes('video');
  if (hasPhoto && hasVideo) return '*/*';
  return hasVideo ? 'video/*' : 'image/*';
}
