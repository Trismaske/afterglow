/**
 * The large- and huge-text thresholds as state (lib/textScale.ts): the
 * hooks the stacking layouts read. React Native re-renders on a
 * font-scale or width change through useWindowDimensions, so a change in
 * Settings reflows the app without a restart. The scale the app SEES is
 * logged once per change (`[a11y] text scale …`): the accessibility walk
 * reads it from the diag sink to tie a screenshot to its threshold.
 */
import { useEffect } from 'react';
import { useWindowDimensions } from 'react-native';
import { effectiveTextScale, isHugeText, isLargeText } from '../lib/textScale';

let loggedFor = '';

function useTextScaleLog(fontScale: number, width: number): void {
  useEffect(() => {
    const key = `${fontScale}|${width}`;
    if (key === loggedFor) return;
    loggedFor = key;
    const effective = effectiveTextScale(fontScale, width);
    console.log(
      `[a11y] text scale ${fontScale} at ${Math.round(width)} dp → effective ${effective.toFixed(3)}: ${
        isHugeText(fontScale, width) ? 'huge' : isLargeText(fontScale, width) ? 'large' : 'normal'
      }`,
    );
  }, [fontScale, width]);
}

export function useLargeText(): boolean {
  const { fontScale, width } = useWindowDimensions();
  useTextScaleLog(fontScale, width);
  return isLargeText(fontScale, width);
}

/** Past the second threshold (lib/textScale.ts): labels beside icons go,
 * chip grids wrap two per row. */
export function useHugeText(): boolean {
  const { fontScale, width } = useWindowDimensions();
  useTextScaleLog(fontScale, width);
  return isHugeText(fontScale, width);
}
