import type {
  MetaNode,
  SearchAlias,
  SearchDataStream,
  SearchField,
  SearchIndexDetails,
  SearchIndexInfo,
  SearchSetting,
  SearchTemplate,
} from '../../ipc';
import { expandNode, explorerNode, type ExplorerNode, type Loadable } from './explorerRows';

/**
 * The explorer of a search connection (Elasticsearch, OpenSearch): indices, data streams,
 * aliases and index templates, each a group read on its own when opened; under an index (data
 * stream, alias) its mapping fields as flattened paths with their types, and a summary of its
 * settings. Hidden and system ones (dot names) show with the system objects only. Same tree
 * machinery as the other families: lazy, cached in the query cache, virtualized by the sidebar.
 */

/** What the search explorer reads, one request per node that lists its children. */
export interface SearchSource {
  indices(fetch: boolean): Loadable<SearchIndexInfo[]>;
  dataStreams(fetch: boolean): Loadable<SearchDataStream[]>;
  aliases(fetch: boolean): Loadable<SearchAlias[]>;
  templates(fetch: boolean): Loadable<SearchTemplate[]>;
  details(target: string, fetch: boolean): Loadable<SearchIndexDetails>;
}

export type SearchGroupKind = 'indices' | 'dataStreams' | 'aliases' | 'templates';
export type SearchDetailKind = 'fields' | 'settings';
/** What can be opened in an index tab. */
export type SearchTargetKind = 'index' | 'dataStream' | 'alias';

export const SEARCH_GROUPS: readonly SearchGroupKind[] = [
  'indices',
  'dataStreams',
  'aliases',
  'templates',
];

export type SearchBody =
  | {
      type: 'searchGroup';
      group: SearchGroupKind;
      /** Listed (without the hidden ones unless shown); `null` before the first read. */
      count: number | null;
    }
  | { type: 'searchIndex'; index: SearchIndexInfo }
  | { type: 'searchDataStream'; stream: SearchDataStream }
  | { type: 'searchAlias'; alias: SearchAlias }
  | { type: 'searchTemplate'; template: SearchTemplate }
  | {
      type: 'searchDetails';
      target: string;
      detail: SearchDetailKind;
      count: number;
    }
  | { type: 'searchField'; target: string; field: SearchField }
  | { type: 'searchSetting'; target: string; setting: SearchSetting };

export const searchKeys = {
  group: (group: SearchGroupKind) => JSON.stringify(['sg', group]),
  target: (kind: SearchTargetKind, name: string) => JSON.stringify(['st', kind, name]),
  details: (kind: SearchTargetKind, name: string, detail: SearchDetailKind) =>
    JSON.stringify(['sd', kind, name, detail]),
};

export interface SearchBuildContext {
  source: SearchSource;
  expanded: ReadonlySet<string>;
  exhaustive: boolean;
  showSystem: boolean;
}

/** The backend node a refresh of an index (its fields and settings) drops. */
export function searchTargetNode(target: string): MetaNode {
  return { level: 'table', table: { database: '', schema: null, name: target } };
}

function detailNodes(
  ctx: SearchBuildContext,
  kind: SearchTargetKind,
  target: string,
  fetching: boolean,
): ExplorerNode[] {
  const peek = ctx.source.details(target, false);
  const refresh = () => searchTargetNode(target);
  return (['fields', 'settings'] as const).map((detail) => {
    const id = searchKeys.details(kind, target, detail);
    const count =
      peek.state === 'ready'
        ? detail === 'fields'
          ? peek.data.fields.length
          : peek.data.settings.length
        : 0;
    return explorerNode(
      id,
      { type: 'searchDetails', target, detail, count },
      true,
      expandNode(
        ctx,
        id,
        fetching,
        (fetch) => ctx.source.details(target, fetch),
        'details',
        refresh,
        (details) =>
          detail === 'fields'
            ? details.fields.map((field) =>
                explorerNode(`${id}/${field.path}`, { type: 'searchField', target, field }, false),
              )
            : details.settings.map((setting) =>
                explorerNode(
                  `${id}/${setting.key}`,
                  { type: 'searchSetting', target, setting },
                  false,
                ),
              ),
      ),
    );
  });
}

/** A node that opens in an index tab and lists its fields and settings when expanded. */
function targetNode(
  ctx: SearchBuildContext,
  kind: SearchTargetKind,
  name: string,
  body: Extract<SearchBody, { type: 'searchIndex' | 'searchDataStream' | 'searchAlias' }>,
  fetching: boolean,
): ExplorerNode {
  const id = searchKeys.target(kind, name);
  const open = ctx.expanded.has(id) || ctx.exhaustive;
  return explorerNode(
    id,
    body,
    true,
    open ? detailNodes(ctx, kind, name, fetching && ctx.expanded.has(id)) : null,
  );
}

function groupChildren(
  ctx: SearchBuildContext,
  group: SearchGroupKind,
  fetching: boolean,
): ExplorerNode[] | null {
  const id = searchKeys.group(group);
  const refresh = (): MetaNode => ({ level: 'connection' });
  const visible = (system: boolean) => ctx.showSystem || !system;
  switch (group) {
    case 'indices':
      return expandNode(
        ctx,
        id,
        fetching,
        (fetch) => ctx.source.indices(fetch),
        'objects',
        refresh,
        (list, below) =>
          list
            .filter((index) => visible(index.system))
            .map((index) =>
              targetNode(ctx, 'index', index.name, { type: 'searchIndex', index }, below),
            ),
      );
    case 'dataStreams':
      return expandNode(
        ctx,
        id,
        fetching,
        (fetch) => ctx.source.dataStreams(fetch),
        'objects',
        refresh,
        (list, below) =>
          list
            .filter((stream) => visible(stream.system))
            .map((stream) =>
              targetNode(
                ctx,
                'dataStream',
                stream.name,
                { type: 'searchDataStream', stream },
                below,
              ),
            ),
      );
    case 'aliases':
      return expandNode(
        ctx,
        id,
        fetching,
        (fetch) => ctx.source.aliases(fetch),
        'objects',
        refresh,
        (list, below) =>
          list
            .filter((alias) => visible(alias.system))
            .map((alias) =>
              targetNode(ctx, 'alias', alias.name, { type: 'searchAlias', alias }, below),
            ),
      );
    case 'templates':
      return expandNode(
        ctx,
        id,
        fetching,
        (fetch) => ctx.source.templates(fetch),
        'objects',
        refresh,
        (list) =>
          list
            .filter((template) => visible(template.system))
            .map((template) =>
              explorerNode(`${id}/${template.name}`, { type: 'searchTemplate', template }, false),
            ),
      );
  }
}

function countOf(ctx: SearchBuildContext, group: SearchGroupKind): number | null {
  const visible = (item: { system: boolean }) => ctx.showSystem || !item.system;
  const count = <T extends { system: boolean }>(loadable: Loadable<T[]>) =>
    loadable.state === 'ready' ? loadable.data.filter(visible).length : null;
  switch (group) {
    case 'indices':
      return count(ctx.source.indices(false));
    case 'dataStreams':
      return count(ctx.source.dataStreams(false));
    case 'aliases':
      return count(ctx.source.aliases(false));
    case 'templates':
      return count(ctx.source.templates(false));
  }
}

/** The tree under an open search connection: its four groups. */
export function buildSearchNodes(ctx: SearchBuildContext, fetching: boolean): ExplorerNode[] {
  return SEARCH_GROUPS.map((group) =>
    explorerNode(
      searchKeys.group(group),
      { type: 'searchGroup', group, count: countOf(ctx, group) },
      true,
      groupChildren(ctx, group, fetching),
    ),
  );
}

/** The name a search row is filtered and announced by (`null`: a group, by its label). */
export function searchNameOf(body: SearchBody): string | null {
  switch (body.type) {
    case 'searchIndex':
      return body.index.name;
    case 'searchDataStream':
      return body.stream.name;
    case 'searchAlias':
      return body.alias.name;
    case 'searchTemplate':
      return body.template.name;
    case 'searchField':
      return body.field.path;
    case 'searchSetting':
      return body.setting.key;
    case 'searchGroup':
    case 'searchDetails':
      return null;
  }
}

/** The index (data stream, alias) a row opens in an index tab, if any. */
export function searchTargetOf(body: SearchBody): string | null {
  switch (body.type) {
    case 'searchIndex':
      return body.index.name;
    case 'searchDataStream':
      return body.stream.name;
    case 'searchAlias':
      return body.alias.name;
    default:
      return null;
  }
}

/** The backend node a search row's refresh drops. */
export function searchNodeOf(body: SearchBody): MetaNode {
  switch (body.type) {
    case 'searchGroup':
    case 'searchTemplate':
      return { level: 'connection' };
    case 'searchIndex':
    case 'searchDataStream':
    case 'searchAlias':
      return searchTargetNode(searchTargetOf(body) ?? '');
    case 'searchDetails':
    case 'searchField':
    case 'searchSetting':
      return searchTargetNode(body.target);
  }
}

export function isSearchBody<T extends { type: string }>(body: T): body is T & SearchBody {
  return body.type.startsWith('search');
}

/** A new console's first request on an index: its first documents. */
export function searchStarter(target: string): string {
  return `GET /${encodeURI(target)}/_search\n{\n  "size": 20,\n  "query": { "match_all": {} }\n}\n`;
}
