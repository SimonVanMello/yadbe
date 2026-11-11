import type { Capabilities, Engine, PinnedObject } from '../../ipc';
import { buildSidebarRows, searchConnections } from '../connections/connectionRows';
import type { ConnectionGroup, ConnectionState, ConnectionSummary } from '../connections/model';
import {
  buildNodes,
  flattenNodes,
  nodeKeys,
  pruneNodes,
  statusNode,
  type ExplorerNode,
  type ExplorerRow,
  type MetaSource,
} from '../explorer/explorerRows';

export type SidebarTreeRow =
  | {
      type: 'group';
      key: string;
      level: number;
      group: ConnectionGroup;
      expandable: true;
      expanded: boolean;
      /** Connections in the group and its subgroups. */
      count: number;
    }
  | {
      type: 'connection';
      key: string;
      level: number;
      connection: ConnectionSummary;
      nameIndices: readonly number[];
      state: ConnectionState;
      expandable: true;
      expanded: boolean;
    }
  | ExplorerRow;

export interface SidebarInput {
  connections: readonly ConnectionSummary[];
  groups: readonly ConnectionGroup[];
  query: string;
  capabilities: ReadonlyMap<Engine, Capabilities>;
  stateOf: (connectionId: string) => ConnectionState;
  /** Expanded nodes of each connection. */
  expanded: Readonly<Record<string, ReadonlySet<string>>>;
  showSystem: boolean;
  /** Pinned objects of every connection (F-027): shown first under their connection. */
  pins?: readonly PinnedObject[];
  /** Where the tree of a connection reads its data. */
  sourceFor: (connectionId: string) => MetaSource;
  /**
   * The loaded tree of a connection pruned to `filter`, from a cache: the whole tree does not
   * depend on the query, only on the data and the expanded nodes, so a keystroke only prunes it
   * again. Absent: built and pruned every time.
   */
  filteredTree?: (
    connectionId: string,
    filter: string,
    build: () => ExplorerNode[],
  ) => ExplorerNode[];
}

const NO_NODES: ReadonlySet<string> = new Set();

/** The rows under a connection row: its explorer tree, shown as far as it is open. */
function explorerRows(
  input: SidebarInput,
  connection: ConnectionSummary,
  level: number,
  state: ConnectionState,
  filter: string,
): ExplorerRow[] {
  const capabilities = input.capabilities.get(connection.engine);
  const expanded = input.expanded[connection.id] ?? NO_NODES;
  const open = expanded.has(nodeKeys.root);
  if (!capabilities || state === 'disconnected') return [];
  if (filter === '' && !open) return [];
  const options = { connectionId: connection.id, level };
  if (state === 'connecting' && filter === '') {
    const connecting = statusNode(nodeKeys.root, 'loading', 'connecting', { level: 'connection' });
    return flattenNodes([connecting], { ...options, expanded, open: false });
  }
  const context = {
    levels: { databases: capabilities.multipleDatabases, schemas: capabilities.schemas },
    showSystem: input.showSystem,
    expanded,
    source: input.sourceFor(connection.id),
    pins: (input.pins ?? []).filter((pin) => pin.connectionId === connection.id),
  };
  // Only a connection that is up loads anything: the rest shows what it already holds.
  const fetching = state === 'connected' && open;
  if (filter === '') {
    const nodes = buildNodes({ ...context, exhaustive: false }, fetching);
    return flattenNodes(nodes, { ...options, expanded, open: false });
  }
  const build = () => buildNodes({ ...context, exhaustive: true }, fetching);
  const nodes = input.filteredTree
    ? input.filteredTree(connection.id, filter, build)
    : pruneNodes(build(), filter);
  return flattenNodes(nodes, { ...options, expanded, open: true });
}

/**
 * The flat rows of the sidebar: connection folders and connections, and under each open
 * connection its explorer tree. While filtering, connections that match by name come first, then
 * the ones that only hold a matching loaded node, each with its matches and their ancestors.
 */
export function composeSidebarRows(input: SidebarInput): SidebarTreeRow[] {
  const filter = input.query.trim();
  const rows: SidebarTreeRow[] = [];

  const pushConnection = (
    connection: ConnectionSummary,
    nameIndices: readonly number[],
    level: number,
    keepAlone: boolean,
  ) => {
    const state = input.stateOf(connection.id);
    const children = explorerRows(input, connection, level + 1, state, filter);
    if (!keepAlone && children.length === 0) return;
    const open = input.expanded[connection.id]?.has(nodeKeys.root) ?? false;
    rows.push({
      type: 'connection',
      key: `connection:${connection.id}`,
      level,
      connection,
      nameIndices,
      state,
      expandable: true,
      expanded: filter === '' ? open && state !== 'disconnected' : children.length > 0,
    });
    rows.push(...children);
  };

  if (filter !== '') {
    const matches = searchConnections(input.connections, filter);
    const named = new Set(matches.map((match) => match.connection.id));
    for (const match of matches) pushConnection(match.connection, match.nameIndices, 1, true);
    const others = input.connections
      .filter((connection) => !named.has(connection.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const connection of others) pushConnection(connection, [], 1, false);
    return rows;
  }

  for (const row of buildSidebarRows(input.connections, input.groups, '')) {
    if (row.kind === 'group') {
      rows.push({
        type: 'group',
        key: `group:${row.group.id}`,
        level: row.depth + 1,
        group: row.group,
        expandable: true,
        expanded: row.expanded,
        count: row.count,
      });
    } else {
      pushConnection(row.connection, row.nameIndices, row.depth + 1, true);
    }
  }
  return rows;
}

export interface TreeShape {
  /** Index of the parent row, `-1` at the top. */
  parent: number[];
  /** 1-based position among the siblings, for `aria-posinset`. */
  posInSet: number[];
  /** Number of siblings, for `aria-setsize`. */
  setSize: number[];
}

/** Parents and sibling positions, which a virtualized tree must state itself (ARIA). */
export function treeShape(rows: readonly { level: number }[]): TreeShape {
  const parent: number[] = [];
  const posInSet: number[] = [];
  const setSize: number[] = [];
  const stack: number[] = [];
  const counts = new Map<number, number>();
  rows.forEach((row, index) => {
    while (stack.length >= row.level) stack.pop();
    const up = stack.at(-1) ?? -1;
    parent.push(up);
    const position = (counts.get(up) ?? 0) + 1;
    counts.set(up, position);
    posInSet.push(position);
    stack.push(index);
  });
  rows.forEach((_, index) => {
    setSize.push(counts.get(parent[index] ?? -1) ?? 1);
  });
  return { parent, posInSet, setSize };
}
