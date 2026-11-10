import type { MessageKey } from '../../i18n/i18n';
import { MAX_HITS, type Hit, type Searcher } from './matcher';
import {
  GROUP_LABELS,
  type ActionItem,
  type ConnectionItem,
  type HistoryItem,
  type ObjectItem,
  type PaletteItem,
  type PaletteKind,
  type PaletteMode,
  type TabItem,
} from './paletteItems';

export interface PaletteSources {
  actions: readonly ActionItem[];
  connections: readonly ConnectionItem[];
  tabs: readonly TabItem[];
  objects: readonly ObjectItem[];
  /** Statements the backend found for the query, newest first. */
  history: readonly HistoryItem[];
  searchers: {
    actions: Searcher<ActionItem>;
    connections: Searcher<ConnectionItem>;
    tabs: Searcher<TabItem>;
    objects: Searcher<ObjectItem>;
  };
}

export type ResultRow =
  | { type: 'header'; key: string; label: MessageKey; count: number }
  | { type: 'item'; item: PaletteItem; indices: readonly number[] };

export interface Results {
  rows: ResultRow[];
  /** Items matching, over every group: what the footer counts. */
  total: number;
}

/** Items per group while every kind is listed together; a prefix lifts the cap. */
const GROUP_CAP = 8;
const OBJECT_CAP = 12;
const HISTORY_CAP = 5;
const RECENT_BOOST = 6;
const DISABLED_PENALTY = 12;
const ACTIVE_TAB_BOOST = 2;

/** Kinds in the order they are listed when their best matches tie. */
const KIND_ORDER: readonly PaletteKind[] = ['action', 'connection', 'tab', 'object', 'history'];

interface Group {
  kind: PaletteKind;
  hits: Hit<PaletteItem>[];
  total: number;
  best: number;
}

function boostOf(recents: ReadonlySet<string>) {
  return (item: PaletteItem): number => {
    let boost = recents.has(item.key) ? RECENT_BOOST : 0;
    if (item.kind === 'action' && item.disabledReason !== null) boost -= DISABLED_PENALTY;
    if (item.kind === 'tab' && item.active) boost += ACTIVE_TAB_BOOST;
    return boost;
  };
}

function plain(items: readonly PaletteItem[], limit: number): Hit<PaletteItem>[] {
  return items.slice(0, limit).map((item) => ({ item, score: 0, indices: [] }));
}

function groupRows(group: Group): ResultRow[] {
  if (group.hits.length === 0) return [];
  return [
    {
      type: 'header',
      key: `group:${group.kind}`,
      label: GROUP_LABELS[group.kind],
      count: group.total,
    },
    ...group.hits.map((hit): ResultRow => ({ type: 'item', item: hit.item, indices: hit.indices })),
  ];
}

/**
 * What the palette lists for a query, grouped by kind.
 * - Empty query, every kind: the recent items first, then the actions, connections and tabs.
 * - A query: the groups are ordered by their best match, items by score (recents and the active
 *   tab slightly boosted, actions that cannot run now pushed down).
 * - A prefix (`>`, `@`…): that kind alone, many more items.
 */
export function buildResults(
  sources: PaletteSources,
  mode: PaletteMode,
  text: string,
  recentKeys: readonly string[],
): Results {
  const recents = new Set(recentKeys);
  const boost = boostOf(recents);
  const single = mode !== 'all';
  const wants = (kind: PaletteKind) => mode === 'all' || mode === kind;
  const cap = (kind: PaletteKind) =>
    single
      ? MAX_HITS
      : kind === 'object'
        ? OBJECT_CAP
        : kind === 'history'
          ? HISTORY_CAP
          : GROUP_CAP;

  if (text === '' && mode === 'all') return emptyQueryResults(sources, recentKeys);

  const groups: Group[] = [];
  const addSearched = <T extends PaletteItem>(
    kind: PaletteKind,
    searcher: Searcher<T>,
    items: readonly T[],
  ) => {
    if (!wants(kind)) return;
    if (text === '') {
      groups.push({ kind, hits: plain(items, cap(kind)), total: items.length, best: 0 });
      return;
    }
    const { hits, total } = searcher.search(text, cap(kind), boost);
    groups.push({ kind, hits, total, best: hits[0]?.score ?? -Infinity });
  };
  addSearched('action', sources.searchers.actions, sources.actions);
  addSearched('connection', sources.searchers.connections, sources.connections);
  addSearched('tab', sources.searchers.tabs, sources.tabs);
  addSearched('object', sources.searchers.objects, sources.objects);
  if (wants('history')) {
    const limit = single ? MAX_HITS : HISTORY_CAP;
    groups.push({
      kind: 'history',
      hits: plain(sources.history, limit),
      total: sources.history.length,
      // After the searched kinds on a tie: history is a last resort.
      best: -Infinity,
    });
  }
  if (text !== '' && !single) {
    groups.sort(
      (a, b) => b.best - a.best || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
  }
  return {
    // One kind alone needs no heading.
    rows: groups.flatMap(groupRows).filter((row) => !single || row.type === 'item'),
    total: groups.reduce((sum, group) => sum + group.total, 0),
  };
}

function emptyQueryResults(sources: PaletteSources, recentKeys: readonly string[]): Results {
  const byKey = new Map<string, PaletteItem>();
  for (const items of [sources.actions, sources.connections, sources.tabs]) {
    for (const item of items) byKey.set(item.key, item);
  }
  const wanted = new Set(recentKeys.filter((key) => key.startsWith('object:')));
  if (wanted.size > 0) {
    for (const item of sources.objects) if (wanted.has(item.key)) byKey.set(item.key, item);
  }
  const recent: Hit<PaletteItem>[] = [];
  for (const key of recentKeys) {
    const item = byKey.get(key);
    if (item) recent.push({ item, score: 0, indices: [] });
  }
  const shown = new Set(recent.map((hit) => hit.item.key));
  const rest = (items: readonly PaletteItem[]) => items.filter((item) => !shown.has(item.key));
  const rows: ResultRow[] = [];
  if (recent.length > 0) {
    rows.push({
      type: 'header',
      key: 'group:recent',
      label: 'palette.group.recent',
      count: recent.length,
    });
    for (const hit of recent) rows.push({ type: 'item', item: hit.item, indices: [] });
  }
  let total = recent.length;
  for (const [kind, items] of [
    ['action', rest(sources.actions)],
    ['connection', rest(sources.connections)],
    ['tab', rest(sources.tabs)],
  ] as const) {
    const hits = plain(items, items.length);
    total += hits.length;
    rows.push(...groupRows({ kind, hits, total: hits.length, best: 0 }));
  }
  return { rows, total };
}
