import { runAction } from '../../app/actions';
import { useTabsStore } from '../../app/tabs/tabsStore';
import type { MessageKey } from '../../i18n/i18n';
import { openQuery } from '../connections/connectionActions';
import { openTable, scriptAs } from '../explorer/explorerActions';
import { revealInExplorer } from '../explorer/revealInExplorer';
import { insertEntry, openEntry } from '../history/historyActions';
import { isScriptable, type PaletteItem } from './paletteItems';

/** What `↵` does, shown in the footer. */
export function primaryHint(item: PaletteItem): MessageKey {
  switch (item.kind) {
    case 'action':
      return 'palette.hint.run';
    case 'connection':
      return 'palette.hint.connect';
    case 'tab':
      return 'palette.hint.switch';
    case 'object':
      return 'palette.hint.reveal';
    case 'history':
      return 'palette.hint.openHistory';
  }
}

/** What `⌘↵` does for this item, `null` when it has no second action. */
export function secondaryHint(item: PaletteItem): MessageKey | null {
  if (isScriptable(item)) return 'palette.hint.script';
  return item.kind === 'history' ? 'palette.hint.insert' : null;
}

/**
 * Carries out an item, once the palette is closed. `openData` (`⇧↵`): a table or view opens in a
 * table tab. `secondary` (`⌘↵`): a table or view opens as
 * `SELECT` in a new tab instead of showing in the explorer, a statement of the history is
 * inserted at the cursor instead of opening in a new tab.
 */
export function activateItem(item: PaletteItem, secondary: boolean, openData = false): void {
  switch (item.kind) {
    case 'action':
      runAction(item.id);
      return;
    case 'connection':
      openQuery(item.connection);
      return;
    case 'tab':
      useTabsStore.getState().activate(item.tabId);
      return;
    case 'object':
      if (openData && isScriptable(item)) {
        void openTable(item.connectionId, {
          database: item.database,
          schema: item.schema,
          name: item.name,
        });
      } else if (secondary && isScriptable(item)) {
        void scriptAs(
          item.connectionId,
          { database: item.database, schema: item.schema, name: item.name },
          'select',
        );
      } else {
        revealInExplorer(item.connectionId, {
          database: item.database,
          schema: item.schema,
          kind: item.objectKind,
          name: item.name,
        });
      }
      return;
    case 'history':
      void (secondary ? insertEntry(item.entry) : openEntry(item.entry));
      return;
  }
}
