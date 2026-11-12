import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { deleteHit, duplicateHit, editHit } from './searchEditActions';
import { blockText, hitBlock, type HitRef } from './searchEditModel';
import { useSearchEditTab } from './searchEditStore';

interface HitMenuItemsProps {
  tabId: string;
  /** The hit's `_index` when known before it is read (for the reasons). */
  index: string | null;
  /** Reads the whole hit (its version, routing, `_source`). */
  load: () => Promise<HitRef | null>;
}

/**
 * Edit, duplicate, delete a hit (M4-8), in the menu of a grid row or a document; disabled with
 * the reason where the document cannot be changed (read-only connection, data stream, closed
 * or write-blocked index).
 */
export function HitMenuItems({ tabId, index, load }: HitMenuItemsProps) {
  const t = useT();
  const { info } = useSearchEditTab(tabId);
  if (!info || index === null) return null;
  const block = hitBlock(info, { index, id: '', routing: null, guard: null, hasSource: true });
  const reason = block ? blockText(block) : null;
  const hint = reason ? t(reason.key, reason.params) : undefined;
  const run = (action: (tabId: string, hit: HitRef) => Promise<void>) => {
    load()
      .then((hit) => (hit ? action(tabId, hit) : undefined))
      .catch(showError);
  };
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="pencil"
        disabled={block !== null}
        hint={hint}
        onSelect={() => {
          run(editHit);
        }}
      >
        {t('search.edit.menu.edit')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="copy"
        disabled={info.readOnly || info.createTargets.length === 0}
        onSelect={() => {
          run(duplicateHit);
        }}
      >
        {t('search.edit.menu.duplicate')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="trash"
        danger
        disabled={block !== null}
        hint={hint}
        onSelect={() => {
          run(deleteHit);
        }}
      >
        {t('search.edit.menu.delete')}
      </ContextMenuItem>
    </>
  );
}
