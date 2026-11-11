import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';

import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { ipc, unwrap, type Engine, type ObjectKind, type TextRange } from '../../ipc';
import { platform } from '../../ui/platform';
import { openTable } from '../explorer/explorerActions';
import { revealInExplorer } from '../explorer/revealInExplorer';
import { StatementLookup } from '../query/statementLookup';
import type { CatalogIndex } from './catalogIndex';
import { ensureCatalog, peekCatalog, resolveDatabase } from './catalogStore';
import { buildInfo } from './completionInfo';
import type { CompletionHost } from './completionSource';
import { resolveHover, type HoverHit, type HoverTarget } from './hoverResolve';

declare global {
  interface Window {
    /** Durations (ms) of each hover resolution, recorded while an array is set here. */
    __yadbeHoverTimings?: number[];
  }
}

/** Time the pointer rests on a name before its card shows. */
const HOVER_DELAY_MS = 350;

/** A resolved name with what is needed to act on it. */
export interface Definition {
  hit: HoverHit;
  index: CatalogIndex;
  connectionId: string;
}

function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/**
 * Finds what the name at `pos` stands for, from the shared catalog cache (read once if it is
 * not there yet). `null` when the tab has no connection or the name is unknown.
 */
export function definitionResolver(
  host: CompletionHost,
): (view: EditorView, pos: number) => Promise<Definition | null> {
  const lookup = new StatementLookup();
  let lastDoc: unknown = null;
  let lastEngine: Engine | null = null;
  let version = 0;
  return async (view, pos) => {
    const started = performance.now();
    const target = host.target();
    if (!target) return null;
    const database = await resolveDatabase(
      target.connectionId,
      target.database,
      target.connectionDatabase,
    );
    if (database === null) return null;
    const index =
      peekCatalog(target.connectionId, database) ??
      (target.connected ? await ensureCatalog(target.connectionId, database) : null);
    if (!index) return null;
    const { state } = view;
    const engine = host.engine();
    if (engine !== lastEngine || state.doc !== lastDoc) {
      if (engine !== lastEngine) lookup.reset();
      lastEngine = engine;
      lastDoc = state.doc;
      version += 1;
    }
    const text = state.doc.toString();
    let range: TextRange | null;
    try {
      range = await lookup.at(version, pos, () =>
        unwrap(ipc.commands.statementAt(engine, text, pos)),
      );
    } catch {
      range = null;
    }
    const whole = range === null || pos < range.from || pos > range.to;
    const from = whole ? 0 : (range?.from ?? 0);
    const to = whole ? text.length : (range?.to ?? text.length);
    const hit = resolveHover({
      text: text.slice(from, to),
      base: from,
      pos,
      rules: host.quoting(),
      index,
    });
    window.__yadbeHoverTimings?.push(performance.now() - started);
    return hit ? { hit, index, connectionId: target.connectionId } : null;
  };
}

/** The table or view a target belongs to, as the explorer and table tabs name it. */
function relationOf(definition: Definition): {
  database: string;
  schema: string | null;
  name: string;
  kind: ObjectKind;
} | null {
  const { index, hit } = definition;
  const { target } = hit;
  if (target.kind === 'routine') {
    const routine = index.routine(target.routine);
    if (!routine) return null;
    return {
      database: index.database,
      schema: index.schemaName(routine.schema),
      name: routine.name,
      kind: routine.kind,
    };
  }
  const relation = index.relation(target.relation);
  if (!relation) return null;
  return {
    database: index.database,
    schema: index.schemaName(relation.schema),
    name: relation.name,
    kind: relation.kind,
  };
}

/** Shows the object (the table of a column) in the explorer (F-052). */
export function revealDefinition(definition: Definition): void {
  const object = relationOf(definition);
  if (object) revealInExplorer(definition.connectionId, object);
}

/** Opens the data of the table or view (the table of a column) in a table tab. */
export function openDefinitionData(definition: Definition): boolean {
  const object = relationOf(definition);
  if (!object || definition.hit.target.kind === 'routine') return false;
  void openTable(definition.connectionId, {
    database: object.database,
    schema: object.schema,
    name: object.name,
  });
  return true;
}

const KIND_KEYS: Record<HoverTarget['kind'] | ObjectKind, MessageKey> = {
  relation: 'hover.kind.table',
  table: 'hover.kind.table',
  view: 'hover.kind.view',
  materializedView: 'hover.kind.materializedView',
  column: 'hover.kind.column',
  routine: 'hover.kind.function',
  function: 'hover.kind.function',
  procedure: 'hover.kind.procedure',
  sequence: 'hover.kind.table',
  type: 'hover.kind.table',
};

function kindKey(definition: Definition): MessageKey {
  const { target } = definition.hit;
  if (target.kind === 'column') return KIND_KEYS.column;
  const object = relationOf(definition);
  return object ? KIND_KEYS[object.kind] : KIND_KEYS.relation;
}

function button(label: string, shortcut: string | null, run: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'cm-yadbe-hover-action';
  node.textContent = label;
  if (shortcut) {
    const kbd = document.createElement('kbd');
    kbd.textContent = shortcut;
    node.append(kbd);
  }
  node.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  node.addEventListener('click', run);
  return node;
}

/** The card of a resolved name: kind, columns and types, keys, comment, actions. */
export function hoverCard(definition: Definition, host: CompletionHost): HTMLElement {
  const { index, hit } = definition;
  const { target } = hit;
  const env = {
    index,
    locale: useI18nStore.getState().locale,
    tableDetails: host.tableDetails,
  };
  const body =
    target.kind === 'relation'
      ? buildInfo({ type: 'relation', relation: target.relation }, env)
      : target.kind === 'routine'
        ? buildInfo({ type: 'routine', routine: target.routine }, env)
        : buildInfo(
            {
              type: 'column',
              relation: target.relation,
              column: target.column,
              typeName: (() => {
                const relation = index.relation(target.relation);
                const position = relation?.columns.indexOf(target.column) ?? -1;
                const type = position < 0 ? undefined : relation?.columnTypes[position];
                return type === undefined ? null : (index.catalog.typeNames[type] ?? null);
              })(),
            },
            env,
          );
  const card = document.createElement('div');
  card.className = 'cm-yadbe-hover';
  card.dataset.testid = 'hover-card';
  const kind = document.createElement('div');
  kind.className = 'cm-yadbe-hover-kind';
  kind.textContent = t(kindKey(definition));
  card.append(kind);
  if (body) card.append(body);

  // Keys and comment of a table, once its details arrive (the explorer's cached query).
  const object = relationOf(definition);
  if (target.kind === 'relation' && object) {
    void host.tableDetails(object, object.kind).then((details) => {
      if (!details || !body) return;
      const keys = new Set(details.primaryKey?.columns ?? []);
      const foreign = new Set(details.foreignKeys.flatMap((key) => key.columns));
      for (const item of body.querySelectorAll('.cm-yadbe-info-column')) {
        const name = item.querySelector('.cm-yadbe-info-name')?.textContent ?? '';
        const marks = [keys.has(name) ? 'PK' : '', foreign.has(name) ? 'FK' : ''].filter(Boolean);
        if (marks.length > 0) {
          const mark = document.createElement('span');
          mark.className = 'cm-yadbe-hover-key';
          mark.textContent = marks.join(' ');
          item.querySelector('.cm-yadbe-info-name')?.append(mark);
        }
      }
      if (details.comment) {
        const comment = document.createElement('div');
        comment.className = 'cm-yadbe-info-comment';
        comment.textContent = details.comment;
        body.querySelector('.cm-yadbe-info-title')?.after(comment);
      }
    });
  }

  const actions = document.createElement('div');
  actions.className = 'cm-yadbe-hover-actions';
  actions.append(
    button(t('hover.reveal'), 'F12', () => {
      revealDefinition(definition);
    }),
  );
  if (target.kind !== 'routine') {
    actions.append(
      button(t('hover.openData'), null, () => {
        openDefinitionData(definition);
      }),
    );
  }
  card.append(actions);
  return card;
}

/** Whether the click is the platform's "go to definition" click (⌘ on macOS, Ctrl elsewhere). */
function modClick(event: MouseEvent): boolean {
  return platform === 'mac'
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Hover cards on object names and Mod+click to reveal them in the explorer (F-052). Nothing is
 * asked of the backend per mouse move: CodeMirror waits for the pointer to rest, the catalog
 * comes from the shared cache, the statement split is cached per document version.
 */
export function hoverExtension(host: CompletionHost): Extension {
  const resolve = definitionResolver(host);
  return [
    hoverTooltip(
      async (view, pos): Promise<Tooltip | null> => {
        const definition = await resolve(view, pos);
        if (!definition) return null;
        return {
          pos: definition.hit.from,
          end: definition.hit.to,
          above: true,
          create: () => ({ dom: hoverCard(definition, host) }),
        };
      },
      { hoverTime: HOVER_DELAY_MS },
    ),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (event.button !== 0 || !modClick(event)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        void resolve(view, pos).then((definition) => {
          if (definition) revealDefinition(definition);
        });
        return true;
      },
    }),
  ];
}
