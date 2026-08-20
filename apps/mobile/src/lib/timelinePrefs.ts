/**
 * The Timeline's remembered filter (m0.8.6, L7): the screen restores
 * what you last chose; first launch opens Unfinished. The canonical
 * settings-row pattern — the consumer parses the raw string with
 * fallback-to-default, so an unset or unparseable row never wedges the
 * screen.
 */

export const TIMELINE_FILTER_KEY = 'timeline_filter';

export type TimelineFilter = 'unfinished' | 'everything' | 'unreviewed';

// Chip order (final device pass, Tristan): Everything leads — it is
// the whole timeline the others peel back from. "Only" dropped from
// the last chip: it is a filter chip, only is implied.
export const TIMELINE_FILTERS: readonly { value: TimelineFilter; label: string }[] = [
  { value: 'everything', label: 'Everything' },
  { value: 'unfinished', label: 'Unfinished' },
  { value: 'unreviewed', label: 'Unreviewed' },
];

export function parseTimelineFilter(raw: string | null | undefined): TimelineFilter {
  return raw === 'everything' || raw === 'unreviewed' ? raw : 'unfinished';
}
