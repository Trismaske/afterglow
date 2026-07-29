/**
 * Library progress page (m0.4 stage 3): the Day progress experience —
 * state summary + filtered grid + state editor — over the whole library
 * and the selected photo sources. Reached from the Home screen's
 * Progress row. No review CTA here: Home's "Continue reviewing" already
 * covers library-wide reviews.
 *
 * m0.8.2: paramless. It used to receive a label and a taken_at range,
 * but nothing set one after sessions were removed — both callers passed
 * the whole library.
 */
import React from 'react';
import { ProgressView } from '../components/progress/ProgressView';

export function ProgressScreen() {
  return <ProgressView target={{ kind: 'library' }} />;
}
