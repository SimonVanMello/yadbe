import type { MessageKey, MessageParams } from '../../i18n/i18n';
import { connectTo, openQuery } from '../connections/connectionActions';
import { setGroupCollapsed } from '../connections/groupActions';
import { metaNodeOf, openTable, refreshNode } from '../explorer/explorerActions';
import { explorerRowLabel } from '../explorer/explorerLabels';
import { isRelationKind, nodeKeys } from '../explorer/explorerRows';
import { revealInExplorer, revealSchema } from '../explorer/revealInExplorer';
import { useExplorerStore } from '../explorer/explorerStore';
import type { SidebarTreeRow } from './sidebarRows';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Opens or closes the node a row stands for. A connection that is not up connects first. */
export function setRowExpanded(row: SidebarTreeRow, expanded: boolean): void {
  if (!row.expandable) return;
  const explorer = useExplorerStore.getState();
  switch (row.type) {
    case 'group':
      void setGroupCollapsed(row.group, !expanded);
      return;
    case 'connection':
      explorer.setExpanded(row.connection.id, nodeKeys.root, expanded);
      if (expanded && row.state === 'disconnected') void connectTo(row.connection);
      return;
    case 'status':
      return;
    default:
      explorer.setExpanded(row.connectionId, row.nodeKey, expanded);
  }
}

export function toggleRow(row: SidebarTreeRow): void {
  setRowExpanded(row, !row.expanded);
}

/**
 * What a double click or Enter does on a row, `false` when it does nothing there. A table or a
 * view opens its rows in a table tab.
 */
export function openRow(row: SidebarTreeRow): boolean {
  switch (row.type) {
    case 'connection':
      openQuery(row.connection);
      return true;
    case 'object':
      if (!isRelationKind(row.object.kind)) return false;
      void openTable(row.connectionId, row.ref);
      return true;
    case 'docCollection':
      // A collection tab is a table tab of a document connection (its body follows the family).
      void openTable(row.connectionId, {
        database: row.database,
        schema: null,
        name: row.collection.name,
      });
      return true;
    case 'pinned': {
      const { kind } = row.pin;
      if (kind === null) {
        revealSchema(row.connectionId, row.pin.database, row.pin.name);
      } else if (!row.missing && isRelationKind(kind)) {
        void openTable(row.connectionId, row.ref);
      } else {
        revealInExplorer(row.connectionId, {
          database: row.pin.database,
          schema: row.pin.schema,
          kind,
          name: row.pin.name,
        });
      }
      return true;
    }
    default:
      return false;
  }
}

/** Refreshes the metadata under a row (F5): the nodes on screen read it again. */
export function refreshRow(row: SidebarTreeRow): void {
  switch (row.type) {
    case 'group':
      return;
    case 'connection':
      if (row.state === 'connected') void refreshNode(row.connection.id, { level: 'connection' });
      return;
    default: {
      const node = metaNodeOf(row);
      if (node) void refreshNode(row.connectionId, node);
    }
  }
}

/** What the type-ahead matches against. */
export function rowLabel(row: SidebarTreeRow, t: Translate): string {
  switch (row.type) {
    case 'group':
      return row.group.name;
    case 'connection':
      return row.connection.name;
    default:
      return explorerRowLabel(row, t);
  }
}
