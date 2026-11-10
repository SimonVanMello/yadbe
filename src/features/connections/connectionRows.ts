import { fuzzyMatch } from './fuzzy';
import type { ConnectionGroup, ConnectionSummary } from './model';

export interface ConnectionMatch {
  connection: ConnectionSummary;
  score: number;
  /** Matched characters of the name, for highlighting. */
  nameIndices: number[];
}

/** Name matches weigh more than the rest: people search for "pg-eu", not for a host name. */
const NAME_WEIGHT = 2;

/** What is searched besides the name: where it connects and its environment. */
function details(connection: ConnectionSummary): string {
  return [
    connection.target,
    connection.database,
    connection.environmentLabel ?? connection.environment ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Fuzzy search over the name, the target, the database and the environment (F-007). */
export function searchConnections(
  connections: readonly ConnectionSummary[],
  query: string,
): ConnectionMatch[] {
  if (query.trim() === '') {
    return connections.map((connection) => ({ connection, score: 0, nameIndices: [] }));
  }
  const matches: ConnectionMatch[] = [];
  for (const connection of connections) {
    const name = fuzzyMatch(query, connection.name);
    const rest = fuzzyMatch(query, details(connection));
    if (!name && !rest) continue;
    const nameScore = name ? name.score * NAME_WEIGHT : -Infinity;
    const restScore = rest ? rest.score : -Infinity;
    matches.push({
      connection,
      score: Math.max(nameScore, restScore),
      nameIndices: name && nameScore >= restScore ? name.indices : [],
    });
  }
  return matches.sort(
    (a, b) => b.score - a.score || a.connection.name.localeCompare(b.connection.name),
  );
}

/** Most recently used first; never used connections after, by name. */
export function byRecency(a: ConnectionSummary, b: ConnectionSummary): number {
  if (a.lastUsedAt !== b.lastUsedAt) {
    if (a.lastUsedAt === null) return 1;
    if (b.lastUsedAt === null) return -1;
    return a.lastUsedAt < b.lastUsedAt ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}

export type SidebarRow =
  | {
      kind: 'group';
      group: ConnectionGroup;
      expanded: boolean;
      /** Connections in the group and its subgroups. */
      count: number;
      depth: number;
    }
  | { kind: 'connection'; connection: ConnectionSummary; nameIndices: number[]; depth: number };

/** Connections in the order the backend keeps them: by position, then name. */
function byPosition(a: ConnectionSummary, b: ConnectionSummary): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/**
 * Rows of the sidebar tree: groups (folders, nestable) first with their content, then the
 * ungrouped connections. While searching, matches are listed flat in score order, groups out
 * of the way.
 */
export function buildSidebarRows(
  connections: readonly ConnectionSummary[],
  groups: readonly ConnectionGroup[],
  query: string,
): SidebarRow[] {
  if (query.trim() !== '') {
    return searchConnections(connections, query).map((match) => ({
      kind: 'connection',
      connection: match.connection,
      nameIndices: match.nameIndices,
      depth: 0,
    }));
  }
  const known = new Set(groups.map((group) => group.id));
  const children = new Map<string | null, ConnectionGroup[]>();
  for (const group of groups) {
    // A group whose parent is gone (corrupt data) is shown at the top level.
    const parent = group.parentId !== null && known.has(group.parentId) ? group.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), group]);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position);
  const members = new Map<string | null, ConnectionSummary[]>();
  for (const connection of [...connections].sort(byPosition)) {
    const group =
      connection.groupId !== null && known.has(connection.groupId) ? connection.groupId : null;
    members.set(group, [...(members.get(group) ?? []), connection]);
  }

  const total = (id: string): number =>
    (members.get(id)?.length ?? 0) +
    (children.get(id) ?? []).reduce((sum, child) => sum + total(child.id), 0);

  const rows: SidebarRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const group of children.get(parent) ?? []) {
      const expanded = !group.collapsed;
      rows.push({ kind: 'group', group, expanded, count: total(group.id), depth });
      if (!expanded) continue;
      walk(group.id, depth + 1);
      for (const connection of members.get(group.id) ?? []) {
        rows.push({ kind: 'connection', connection, nameIndices: [], depth: depth + 1 });
      }
    }
  };
  walk(null, 0);
  for (const connection of members.get(null) ?? []) {
    rows.push({ kind: 'connection', connection, nameIndices: [], depth: 0 });
  }
  return rows;
}
