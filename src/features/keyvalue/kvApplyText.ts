import type { MessageKey } from '../../i18n/i18n';

/**
 * The sentence under the title of the apply / revert dialog. Up to 500 keys it is one checked
 * transaction; above, the change set runs as several, each one checked, not atomic as a whole,
 * and the sentence says that alone (it must not also claim a single transaction).
 */
export function applyDescriptionKey(revert: boolean, batches: number): MessageKey {
  if (revert) {
    return batches > 1 ? 'keyValue.revert.description.batched' : 'keyValue.revert.description';
  }
  return batches > 1 ? 'keyValue.apply.description.batched' : 'keyValue.apply.description';
}

/** The sentence of the confirmation of a change set with no danger of its own. */
export function confirmDescriptionKey(batches: number): MessageKey {
  return batches > 1
    ? 'keyValue.edit.confirmDescription.batched'
    : 'keyValue.edit.confirmDescription';
}
