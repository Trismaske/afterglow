/** Dark, photo-first palette with big touch targets (hotel-at-night UX). */
export const colors = {
  background: '#0d0f12',
  surface: '#1a1d23',
  surfaceRaised: '#242830',
  border: '#2e333d',
  text: '#f2f4f8',
  textDim: '#9aa3b2',
  accent: '#e8a54b', // afterglow amber
  keep: '#3fb96a',
  cull: '#e05252',
  cullDim: '#5a2a2a',
} as const;

export const touch = {
  /** Minimum height for primary action buttons. */
  action: 64,
  radius: 14,
} as const;
