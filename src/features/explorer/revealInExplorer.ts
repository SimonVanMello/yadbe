import { useLayoutStore } from '../../app/layout/layoutStore';
import { queryClient } from '../../app/queryClient';
import type { EngineInfo } from '../../ipc';
import { connectionKeys } from '../connections/connectionStore';
import { findConnection } from '../query/connectionLookup';
import { useSidebarView } from '../sidebar/sidebarViewStore';
import { nodeKeys } from './explorerRows';
import { useExplorerStore } from './explorerStore';
import { useRevealStore, type RevealTarget } from './revealStore';

/**
 * Shows an object in the explorer: the Connections view of the sidebar opens, the nodes above
 * the object expand (loading what they hold), and the tree scrolls to its row and focuses it
 * (`useRevealRow`, in the sidebar tree, does the last two once the row is listed).
 */
export function revealInExplorer(connectionId: string, target: RevealTarget): void {
  const engine = findConnection(connectionId)?.engine;
  const engines = queryClient.getQueryData<EngineInfo[]>(connectionKeys.engines);
  const capabilities = engines?.find((info) => info.engine === engine)?.capabilities;
  const levels = {
    databases: capabilities?.multipleDatabases ?? true,
    schemas: capabilities?.schemas ?? target.schema !== null,
  };
  const explorer = useExplorerStore.getState();
  explorer.setExpanded(connectionId, nodeKeys.root, true);
  if (levels.databases)
    explorer.setExpanded(connectionId, nodeKeys.database(target.database), true);
  const schema = levels.schemas ? target.schema : null;
  if (schema !== null)
    explorer.setExpanded(connectionId, nodeKeys.schema(target.database, schema), true);
  explorer.setExpanded(connectionId, nodeKeys.kind(target.database, schema, target.kind), true);

  useSidebarView.getState().setView('connections');
  useLayoutStore.getState().setCollapsed('sidebar', false);
  useRevealStore.getState().ask(connectionId, { ...target, schema });
}

/** Shows a schema in the explorer: the nodes above it open, and the sidebar shows the tree. */
export function revealSchema(connectionId: string, database: string, schema: string): void {
  const explorer = useExplorerStore.getState();
  explorer.setExpanded(connectionId, nodeKeys.root, true);
  explorer.setExpanded(connectionId, nodeKeys.database(database), true);
  explorer.setExpanded(connectionId, nodeKeys.schema(database, schema), true);
  useSidebarView.getState().setView('connections');
  useLayoutStore.getState().setCollapsed('sidebar', false);
}
