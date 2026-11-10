import { translate, type Locale, type MessageKey } from '../../i18n/i18n';
import type { ObjectKind, ObjectRef, TableDetails } from '../../ipc';
import type { CatalogIndex } from './catalogIndex';
import type { SuggestionInfo } from './completionOptions';

/**
 * The panel next to the selected suggestion: the columns of a table, the type, nullability and
 * keys of a column, the signature of a routine. Built as DOM (CodeMirror owns the tooltip), from
 * the catalog first and, for a column, completed with the table's details when they arrive.
 */

export interface InfoEnv {
  index: CatalogIndex | null;
  locale: Locale;
  /** The details of a catalog relation (cached by the explorer's queries), or `null`. */
  tableDetails: (table: ObjectRef, kind: ObjectKind) => Promise<TableDetails | null>;
}

const MAX_COLUMNS = 24;
const CLASS = 'cm-yadbe-info';

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = `${CLASS}-${className}`;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(label: string, value: string | HTMLElement, className = 'row'): HTMLElement {
  const node = el('div', className);
  node.append(el('span', 'label', label));
  const content = typeof value === 'string' ? el('span', 'value', value) : value;
  node.append(content);
  return node;
}

function root(...children: HTMLElement[]): HTMLElement {
  const node = document.createElement('div');
  node.className = CLASS;
  node.append(...children);
  return node;
}

function listColumns(
  columns: readonly { name: string; typeName: string | null }[],
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): HTMLElement {
  const list = el('ul', 'columns');
  for (const column of columns.slice(0, MAX_COLUMNS)) {
    const item = el('li', 'column');
    item.append(el('span', 'name', column.name), el('span', 'type', column.typeName ?? ''));
    list.append(item);
  }
  if (columns.length > MAX_COLUMNS) {
    list.append(
      el('li', 'more', t('completion.info.moreColumns', { count: columns.length - MAX_COLUMNS })),
    );
  }
  return list;
}

/** `null` when there is nothing worth a panel. */
export function buildInfo(info: SuggestionInfo, env: InfoEnv): HTMLElement | null {
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(env.locale, key, params);
  const { index } = env;
  switch (info.type) {
    case 'relation': {
      const relation = index?.relation(info.relation);
      if (!index || !relation) return null;
      const schema = index.schemaName(relation.schema);
      const title = el(
        'div',
        'title',
        schema === null ? relation.name : `${schema}.${relation.name}`,
      );
      const columns = relation.columns.map((name, i) => {
        const typeIndex = relation.columnTypes[i];
        return {
          name,
          typeName: typeIndex === undefined ? null : (index.catalog.typeNames[typeIndex] ?? null),
        };
      });
      return root(
        title,
        row(t('completion.info.columns'), String(columns.length)),
        listColumns(columns, t),
      );
    }
    case 'columns':
      return root(
        el('div', 'title', info.name),
        row(t('completion.info.columns'), String(info.columns.length)),
        listColumns(info.columns, t),
      );
    case 'routine': {
      const routine = index?.routine(info.routine);
      if (!index || !routine) return null;
      const schema = index.schemaName(routine.schema);
      const name = schema === null ? routine.name : `${schema}.${routine.name}`;
      const node = root(el('div', 'title', `${name}(${routine.arguments})`));
      if (routine.returnType) node.append(row(t('completion.info.returns'), routine.returnType));
      return node;
    }
    case 'column': {
      const node = root(el('div', 'title', info.column));
      if (info.typeName) node.append(row(t('completion.info.type'), info.typeName));
      const relation = info.relation === null ? undefined : index?.relation(info.relation);
      if (index && info.relation !== null && relation) {
        const owner = index.schemaName(relation.schema);
        node.append(
          row(
            t('completion.info.table'),
            owner === null ? relation.name : `${owner}.${relation.name}`,
          ),
        );
        const foreign = index.foreignKeyOf(info.relation, info.column);
        const target = foreign ? index.relation(foreign.to) : undefined;
        if (foreign && target) {
          const targetSchema = index.schemaName(target.schema);
          const position = relation.columns.indexOf(info.column);
          const at = foreign.fromColumns.indexOf(position);
          const targetColumn = target.columns[foreign.toColumns[at] ?? -1] ?? '';
          const name = targetSchema === null ? target.name : `${targetSchema}.${target.name}`;
          node.append(row(t('completion.info.references'), `${name} (${targetColumn})`));
        }
        // What the catalog leaves out: nullability and primary key, from the table's details.
        const extra = el('div', 'extra');
        node.append(extra);
        const table = {
          database: index.database,
          schema: owner,
          name: relation.name,
        };
        void env.tableDetails(table, relation.kind).then((details) => {
          const column = details?.columns.find((c) => c.name === info.column);
          if (!column) return;
          const facts = [
            column.nullable ? t('completion.info.nullable') : t('completion.info.notNull'),
            ...(column.primaryKey ? [t('completion.info.primaryKey')] : []),
            ...(column.identity !== null ? [t('completion.info.identity')] : []),
          ];
          extra.append(row(t('completion.info.constraints'), facts.join(' · ')));
          if (column.default) extra.append(row(t('completion.info.default'), column.default));
          if (column.comment) extra.append(el('div', 'comment', column.comment));
        });
      }
      return node;
    }
  }
}
