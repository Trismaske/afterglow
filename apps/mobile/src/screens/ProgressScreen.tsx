/**
 * Global progress page (m0.4 stage 3): the Day progress experience —
 * state summary + filtered grid + state editor — over the whole selected
 * scope + source. Reached from the Home screen's Progress row; the range
 * is computed there (rolling scopes end at "now") and passed in. No
 * review CTA here: Home's "Start culling" already covers scope-wide
 * reviews.
 */
import React from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { ProgressView } from '../components/progress/ProgressView';

type Props = NativeStackScreenProps<RootStackParamList, 'Progress'>;

export function ProgressScreen({ route }: Props) {
  const { label, startMs, endMs } = route.params;
  return (
    <ProgressView heading={label} scope={{ startMs, endMs }} startMs={startMs} endMs={endMs} />
  );
}
