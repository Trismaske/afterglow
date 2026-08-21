/**
 * The shared queue-removal affordance (m0.8.7, action-layer coherence):
 * before this, Share had a confirmed "Clear queue", Organize an
 * UNconfirmed "Remove all N", and Edit and Favourite no removal at all —
 * four queues, three behaviours. One chip, one semantic, for all four:
 *
 * - **Removing an explicit SELECTION acts directly.** A targeted act
 *   needs no second question (the M5 rule's spirit: the user named
 *   exactly those rows).
 * - **Clearing ALL always confirms**, naming the count and the model's
 *   forget/keep rule — queued work is forgotten, completed history is
 *   kept (`leaveQueue`'s two-statement contract).
 *
 * The screen supplies the remove implementation; a screen with no
 * selection mode simply passes `selectedCount: 0` and gets the
 * confirmed clear.
 */
import React, { useCallback } from 'react';
import { Alert } from 'react-native';
import { Chip } from './QueueGrid';

export function QueueRemoveChip({
  queueLabel,
  count,
  selectedCount,
  onRemove,
  confirmMessage,
}: {
  /** Names the queue in the confirm ("share", "edit", …). */
  queueLabel: string;
  /** Live queue size (the clear-all count and copy). */
  count: number;
  /** Explicitly selected rows; 0 = no selection → clear-all semantics. */
  selectedCount: number;
  /** Perform the removal: 'selected' or the whole displayed queue. */
  onRemove: (scope: 'selected' | 'all') => void;
  /** Optional richer confirm body (Share names its never-shared count);
   * defaults to the standard forget/keep sentence. */
  confirmMessage?: string;
}) {
  const press = useCallback(() => {
    if (selectedCount > 0) {
      onRemove('selected');
      return;
    }
    Alert.alert(
      `Remove all ${count} from the ${queueLabel} queue?`,
      confirmMessage ?? 'Queued work is forgotten. Anything already completed keeps its history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove all', style: 'destructive', onPress: () => onRemove('all') },
      ],
    );
  }, [selectedCount, count, queueLabel, confirmMessage, onRemove]);
  if (count === 0) return null;
  return (
    <Chip
      label={selectedCount > 0 ? `Remove ${selectedCount}` : `Remove all ${count}`}
      onPress={press}
    />
  );
}
