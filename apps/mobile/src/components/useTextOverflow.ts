/**
 * Measured levers (m0.9.1, settled in the close-out grilling): a layout
 * that stacks, wraps or drops labels when its text no longer fits
 * decides that from the TEXT'S OWN MEASUREMENT, not from a number. React
 * Native reports every Text's rendered lines (onTextLayout); a label that
 * needed a second line in its slot is the fact, exact for any width,
 * font or language.
 *
 * The hybrid: the threshold from lib/textScale.ts is the FIRST GUESS,
 * applied before anything measured, so the phones the walk covered never
 * show a frame of the row layout before stacking; the measurement then
 * corrects the guess either way. A font-scale or width change resets the
 * measurements (a label hidden by the last decision cannot report that
 * it would fit again), and the guess leads once more until the texts
 * re-report.
 *
 * `watch(key)` returns the onTextLayout handler for one text; `overflow`
 * is true when any watched text reported more lines than it is allowed.
 * A text's overflow report latches: the rearranged layout gives it more
 * room and it would otherwise report "fits" and undo the rearrangement.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';

export interface TextOverflow {
  /** Any watched text needs more lines than allowed (or the guess says so). */
  overflow: boolean;
  /** The onTextLayout handler for the text with this key. */
  watch: (key: string) => (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
}

export function useTextOverflow(guess: boolean, maxLines = 1): TextOverflow {
  const { fontScale, width } = useWindowDimensions();
  const measured = useRef(new Map<string, boolean>());
  const [, bump] = useState(0);
  // A new scale or width invalidates every report: start from the guess.
  useEffect(() => {
    measured.current = new Map();
    bump((n) => n + 1);
  }, [fontScale, width]);
  const watch = useCallback(
    (key: string) => (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const over = event.nativeEvent.lines.length > maxLines;
      const known = measured.current.get(key);
      // A report of overflow LATCHES until the next scale or width change:
      // the rearranged layout gives the same text more room, it would
      // report "fits", the layout would go back, and the two would
      // alternate forever. Only the first report, or a later overflow,
      // is news.
      if (known === true || known === over) return;
      measured.current.set(key, over);
      bump((n) => n + 1);
    },
    [maxLines],
  );
  // Read on every render (the bump above re-renders on each report):
  // the guess until a text has reported, then the reports alone.
  const reports = [...measured.current.values()];
  const overflow = reports.length === 0 ? guess : reports.some(Boolean);
  return { overflow, watch };
}
