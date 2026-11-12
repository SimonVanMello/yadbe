import { runAction } from '../../app/actions';
import { useTabsStore } from '../../app/tabs/tabsStore';
import type { MessageKey } from '../../i18n/i18n';
import { openQuery } from '../connections/connectionActions';
import { openKeyTab } from '../keyvalue/kvActions';
import { openTable, scriptAs } from '../explorer/explorerActions';
import { revealInExplorer } from '../explorer/revealInExplorer';
import { insertEntry, openEntry } from '../history/historyActions';
import { insertSaved, openSaved } from '../library/libraryActions';
import { isScriptable, type ObjectItem, type PaletteItem } from './paletteItems';

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
      return item.family ? 'palette.hint.openObject' : 'palette.hint.reveal';
    case 'history':
      return 'palette.hint.openHistory';
    case 'saved':
      return 'palette.hint.openSaved';
  }
}

/** What `⌘↵` does for this item, `null` when it has no second action. */
export function secondaryHint(item: PaletteItem): MessageKey | null {
  if (isScriptable(item)) return 'palette.hint.script';
  return item.kind === 'history' || item.kind === 'saved' ? 'palette.hint.insert' : null;
}

/** A collection, index, data stream, alias or key opens in its own tab. */
function openFamilyObject(item: ObjectItem): void {
  const { family } = item;
  if (family?.type === 'key') {
    openKeyTab(item.connectionId, family.database, family.key);
  } else if (family) {
    void openTable(item.connectionId, {
      database: item.database,
      schema: null,
      name: item.name,
    });
  }
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
      if (item.family) {
        openFamilyObject(item);
      } else if (openData && isScriptable(item)) {
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
    case 'saved':
      void (secondary ? insertSaved(item.query) : openSaved(item.query));
      return;
  }
}
