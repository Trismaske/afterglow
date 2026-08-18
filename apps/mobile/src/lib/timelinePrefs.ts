/**
 * The Timeline's remembered filter (m0.8.6, L7): the screen restores
 * what you last chose; first launch opens Unfinished. The canonical
 * settings-row pattern — the consumer parses the raw string with
 * fallback-to-default, so an unset or unparseable row never wedges the
 * screen.
 */

export const TIMELINE_FILTER_KEY = 'timeline_filter';

export type TimelineFilter = 'unfinished' | 'everything' | 'unreviewed';

export const TIMELINE_FILTERS: readonly { value: TimelineFilter; label: string }[] = [
  { value: 'unfinished', label: 'Unfinished' },
  { value: 'everything', label: 'Everything' },
  { value: 'unreviewed', label: 'Unreviewed only' },
];

export function parseTimelineFilter(raw: string | null | undefined): TimelineFilter {
  return raw === 'everything' || raw === 'unreviewed' ? raw : 'unfinished';
}
