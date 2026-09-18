/**
 * What an animated thumbnail needs of a row (m0.9 phase 6): identity and
 * version for the OS thumbnail, and what it animates as — a video by its
 * kind, a motion photo by its clip's byte range, a GIF by its MIME
 * (lib/animatedCells `animatedKindOf`). Every uri-bearing SELECT projects
 * these facts, so every surface builds its rows through `thumbRowOf`.
 */
import { animatedKindOf, type AnimatedKind } from './animatedCells';
import type { StoredMediaKind } from './mediaIdentity';
import { motionClipOf, type MotionClipRow } from '../db/store';

export interface AnimatedThumbRow {
  id: string;
  kind: StoredMediaKind;
  uri: string;
  version: number;
  animated: AnimatedKind | null;
  motion: MotionClipRow | null;
}

/** The facts every row projection carries. */
export interface ThumbFacts {
  uri: string;
  image_version: number;
  kind: StoredMediaKind;
  mime_type: string | null;
  motion_offset: number | null;
  motion_length: number | null;
  motion_presentation_us: number | null;
}

export function thumbRowOf(id: string, facts: ThumbFacts): AnimatedThumbRow {
  return {
    id,
    kind: facts.kind,
    uri: facts.uri,
    version: Number(facts.image_version),
    animated: animatedKindOf({
      kind: facts.kind,
      mimeType: facts.mime_type,
      hasMotion: facts.motion_offset !== null && facts.motion_length !== null,
    }),
    motion: motionClipOf(facts),
  };
}
